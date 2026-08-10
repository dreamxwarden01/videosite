package transcoder

import (
	"math"
	"strconv"
	"testing"
)

// TestSegmentPlanExactness asserts the property the whole type exists for: the
// segment length must be a whole number of GOPs AND a whole number of
// microseconds, so the value handed to -hls_time is exactly what the encoder
// produces and the muxer's accumulated threshold never drifts off the frame
// grid.
//
// Runs on arithmetic alone — no media, no FFmpeg — so it is safe in CI.
func TestSegmentPlanExactness(t *testing.T) {
	rates := []struct {
		name     string
		num, den int
	}{
		{"15", 15, 1},
		{"24", 24, 1},
		{"25", 25, 1},
		{"30", 30, 1},
		{"50", 50, 1},
		{"60", 60, 1},
		{"23.976", 24000, 1001},
		{"29.97", 30000, 1001},
		{"59.94", 60000, 1001},
	}
	// Target GOPs spanning the range the server allows (gop_seconds 0.1-10)
	// plus the source-adopted cadences seen in practice.
	gops := []float64{0.5, 1.0, 1.951951, 2.0, 3.0}
	segs := []float64{4.0, 6.0, 10.0}

	for _, r := range rates {
		for _, g := range gops {
			for _, s := range segs {
				p := NewSegmentPlan(r.num, r.den, g, s)

				if p.GOPFrames < 1 {
					t.Errorf("%s gop=%.3f seg=%.1f: GOPFrames=%d", r.name, g, s, p.GOPFrames)
				}
				if p.SegmentFrames%p.GOPFrames != 0 {
					t.Errorf("%s gop=%.3f seg=%.1f: segment %d frames is not a whole number of %d-frame GOPs",
						r.name, g, s, p.SegmentFrames, p.GOPFrames)
				}
				if _, exact := p.SegmentMicros(); !exact {
					t.Errorf("%s gop=%.3f seg=%.1f: segment duration is not a whole number of microseconds (%s)",
						r.name, g, s, p)
				}
				// The segment must still cover the requested target; rounding
				// up to a GOP multiple may overshoot but must never undershoot.
				if got := p.SegmentSeconds(); got < s-1e-9 {
					t.Errorf("%s gop=%.3f seg=%.1f: segment %.6fs undershoots target", r.name, g, s, got)
				}
				// The GOP must be the frame count nearest the target.
				fps := float64(r.num) / float64(r.den)
				if want := int(math.Round(g * fps)); p.GOPFrames != want && want >= 1 {
					t.Errorf("%s gop=%.3f: GOPFrames=%d, want %d", r.name, g, p.GOPFrames, want)
				}
			}
		}
	}
}

// TestSegmentPlanHLSTimeIsExact checks the formatted -hls_time round-trips to
// the same microsecond count the plan describes. A formatting width that lost
// precision here would silently reintroduce the per-segment deficit.
func TestSegmentPlanHLSTimeIsExact(t *testing.T) {
	cases := []struct {
		num, den int
		gop, seg float64
		want     string
	}{
		{15, 1, 2.0, 6.0, "6.000000"},            // 90 frames
		{25, 1, 2.0, 6.0, "6.000000"},            // 150 frames
		{24000, 1001, 2.0, 6.0, "6.006000"},      // 144 frames, NTSC film
		{30000, 1001, 2.0, 6.0, "6.006000"},      // 180 frames
		{60000, 1001, 1.951951, 6.0, "7.807800"}, // 468 frames, 117-frame source GOP
	}
	for _, c := range cases {
		p := NewSegmentPlan(c.num, c.den, c.gop, c.seg)
		if got := p.HLSTimeArg(); got != c.want {
			t.Errorf("%d/%d gop=%.6f seg=%.1f: hls_time %q, want %q (%s)",
				c.num, c.den, c.gop, c.seg, got, c.want, p)
		}
	}
}

// TestSegmentPlanDegenerateInputs covers the defensive paths: an unknown frame
// rate must still yield a usable plan rather than a division by zero, and a
// GOP target shorter than one frame must clamp to one frame.
func TestSegmentPlanDegenerateInputs(t *testing.T) {
	p := NewSegmentPlan(0, 0, 2.0, 6.0)
	if p.FPSNum <= 0 || p.FPSDen <= 0 || p.GOPFrames < 1 || p.SegmentFrames < 1 {
		t.Fatalf("unknown frame rate produced an unusable plan: %s", p)
	}
	if _, exact := p.SegmentMicros(); !exact {
		t.Errorf("fallback plan is not microsecond-exact: %s", p)
	}

	tiny := NewSegmentPlan(30, 1, 0.001, 6.0)
	if tiny.GOPFrames != 1 {
		t.Errorf("sub-frame GOP target: GOPFrames=%d, want 1", tiny.GOPFrames)
	}
}

// buildIDRTimes synthesises a source keyframe layout at 60000/1001 fps:
// `count` GOPs of nominalFrames, except every longEvery-th which runs
// longFrames instead. longEvery <= 0 means a perfectly regular grid.
func buildIDRTimes(count, nominalFrames, longEvery, longFrames int) []float64 {
	const num, den = 60000, 1001
	times := make([]float64, 0, count+1)
	frame := 0
	for i := 0; i <= count; i++ {
		times = append(times, float64(frame)*float64(den)/float64(num))
		n := nominalFrames
		if longEvery > 0 && (i+1)%longEvery == 0 {
			n = longFrames
		}
		frame += n
	}
	return times
}

// TestRemuxSegmentsWouldBeUniform encodes the insight that made the remux
// decision worth simulating: what determines whether a stream copy segments
// uniformly is how OFTEN the source runs long, not by how much. All three
// cases below have an identical maximum inter-IDR deviation (117 vs 119
// frames, ~33 ms) and would be indistinguishable to any tolerance on that
// deviation, yet they segment completely differently.
//
// Frequencies mirror the two real 59.94 fps sources this was built for:
// 0.35% off-nominal GOPs remuxes cleanly, 7% does not.
func TestRemuxSegmentsWouldBeUniform(t *testing.T) {
	plan := NewSegmentPlan(60000, 1001, 1.951951, 6.0) // 117-frame GOP, 468-frame segment
	if plan.GOPFrames != 117 || plan.SegmentFrames != 468 {
		t.Fatalf("unexpected plan: %s", plan)
	}

	cases := []struct {
		name      string
		longEvery int
		want      bool
	}{
		{"perfectly regular", 0, true},
		{"0.35% long GOPs (0224-like)", 285, true},
		{"7% long GOPs (0226-like)", 14, false},
	}
	for _, c := range cases {
		idr := buildIDRTimes(1600, 117, c.longEvery, 119)
		got, reason := RemuxSegmentsWouldBeUniform(idr, plan)
		if got != c.want {
			t.Errorf("%s: uniform=%v, want %v (%s)", c.name, got, c.want, reason)
		}
	}
}

// TestSimulateRemuxSegmentsCutRule checks the simulation reproduces the
// muxer's rule — cut at the first keyframe at or past an absolute
// `hls_time × N` threshold — rather than resetting the threshold per segment.
// The distinction is the entire reason a per-segment deficit accumulates.
func TestSimulateRemuxSegmentsCutRule(t *testing.T) {
	// IDRs every 1s, asking for 2.5s segments: cuts land at 3s, 5s, 8s, 10s…
	idr := make([]float64, 0, 21)
	for i := 0; i <= 20; i++ {
		idr = append(idr, float64(i))
	}
	segs := SimulateRemuxSegments(idr, 2.5)
	want := []float64{3, 2, 3, 2, 3, 2, 3}
	if len(segs) < len(want) {
		t.Fatalf("got %d segments, want at least %d: %v", len(segs), len(want), segs)
	}
	for i, w := range want {
		if segs[i] != w {
			t.Fatalf("segment %d = %v, want %v (full: %v)", i, segs[i], w, segs[:len(want)])
		}
	}

	if got := SimulateRemuxSegments([]float64{0}, 2.5); got != nil {
		t.Errorf("single IDR should yield no segments, got %v", got)
	}
	if ok, _ := RemuxSegmentsWouldBeUniform([]float64{0}, NewSegmentPlan(30, 1, 2, 6)); ok {
		t.Error("a source with one IDR must not be judged remuxable")
	}
}

// TestRemuxHLSTimeArgUndercuts confirms the remux margin is strictly positive
// and stays well under one GOP — it exists to absorb source PTS jitter, not to
// move the cut to a different keyframe.
func TestRemuxHLSTimeArgUndercuts(t *testing.T) {
	p := NewSegmentPlan(60000, 1001, 1.951951, 6.0)
	seg, gop := p.SegmentSeconds(), p.GOPSeconds()
	got, err := strconv.ParseFloat(RemuxHLSTimeArg(seg, gop), 64)
	if err != nil {
		t.Fatalf("parse remux hls_time: %v", err)
	}
	margin := seg - got
	if margin <= 0 {
		t.Fatalf("remux hls_time %.6f does not undercut segment %.6f", got, seg)
	}
	if margin >= gop/100 {
		t.Errorf("remux margin %.6fs is too large a fraction of the %.6fs GOP", margin, gop)
	}
}
