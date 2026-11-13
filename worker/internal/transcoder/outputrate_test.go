package transcoder

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"testing"
	"videosite-worker/internal/config"
)

func TestOutputFrameRateSelectsAndCapsRationalGrid(t *testing.T) {
	nominal := &ProbeResult{FrameRateNum: 60, FrameRateDen: 1, AvgFrameRateNum: 24000, AvgFrameRateDen: 1001}
	for _, tc := range []struct {
		name            string
		probe           *ProbeResult
		cadence         CadenceInfo
		limit, num, den int
		reason          string
	}{
		{"verified CFR wins", nominal, CadenceInfo{Kind: CadenceCFR, RateNum: 60000, RateDen: 1001}, 0, 60000, 1001, "verified CFR"},
		{"low CFR remains below one", nominal, CadenceInfo{Kind: CadenceCFR, RateNum: 1, RateDen: 5}, 30, 1, 5, "verified CFR"},
		{"profile cap 30", nominal, CadenceInfo{Kind: CadenceCFR, RateNum: 60000, RateDen: 1001}, 30, 30, 1, "profile CFR cap"},
		{"profile cap 15", nominal, CadenceInfo{Kind: CadenceCFR, RateNum: 60000, RateDen: 1001}, 15, 15, 1, "profile CFR cap"},
		{"VFR uses average", nominal, CadenceInfo{Kind: CadenceVFR, RateNum: 60, RateDen: 1}, 0, 24000, 1001, "average"},
		{"unknown uses average", nominal, CadenceInfo{Kind: CadenceUnknown}, 0, 24000, 1001, "average"},
		{"average reduced", &ProbeResult{AvgFrameRateNum: 120000, AvgFrameRateDen: 2002}, CadenceInfo{Kind: CadenceVFR}, 0, 60000, 1001, "average"},
		{"invalid CFR uses average", nominal, CadenceInfo{Kind: CadenceCFR, RateNum: 30, RateDen: 0}, 0, 24000, 1001, "average"},
		{"nominal fallback", &ProbeResult{FrameRateNum: 1, FrameRateDen: 5, AvgFrameRateNum: 30}, CadenceInfo{Kind: CadenceVFR}, 0, 1, 5, "nominal"},
		{"unknown default", nil, CadenceInfo{}, 0, 30, 1, "default"},
		{"invalid rates default", &ProbeResult{FrameRateNum: -1, FrameRateDen: 1, AvgFrameRateNum: 1_000_000_001, AvgFrameRateDen: 1}, CadenceInfo{}, 0, 30, 1, "default"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			n, d, reason := OutputFrameRate(tc.probe, tc.cadence, tc.limit)
			if n != tc.num || d != tc.den || !strings.Contains(reason, tc.reason) {
				t.Fatalf("got %d/%d (%s), want %d/%d (%s)", n, d, reason, tc.num, tc.den, tc.reason)
			}
		})
	}
}

func TestRationalOutputArgsKeepFrameRateAndGOPGridTogether(t *testing.T) {
	for _, rate := range [][2]int{{60000, 1001}, {1, 5}, {30, 1}, {15, 1}} {
		t.Run(fmt.Sprintf("%d_%d", rate[0], rate[1]), func(t *testing.T) {
			plan := NewSegmentPlan(rate[0], rate[1], 2, 6)
			args := buildBaseVideoArgs(nil, "input.mp4", t.TempDir(), config.OutputProfile{VideoBitrateKbps: 1234, Profile: "high"}, plan, "libx264", "scale=1280:720")
			for key, want := range map[string]string{"-r": fmt.Sprintf("%d/%d", rate[0], rate[1]), "-fps_mode": "cfr", "-g": strconv.Itoa(plan.GOPFrames), "-force_key_frames": fmt.Sprintf("expr:eq(mod(n,%d),0)", plan.GOPFrames), "-hls_time": plan.HLSTimeArg()} {
				found := 0
				for i, arg := range args {
					if arg == key {
						found++
						if i+1 >= len(args) || args[i+1] != want {
							t.Fatalf("%s does not match plan %q: %v", key, want, args)
						}
					}
				}
				if found != 1 {
					t.Fatalf("%s occurs %d times", key, found)
				}
			}
			if plan.GOPFrames < 1 || plan.SegmentFrames%plan.GOPFrames != 0 {
				t.Fatalf("invalid frame grid: %s", plan)
			}
		})
	}
}

func TestUnusualRationalPlanAvoidsUnboundedExactAlignment(t *testing.T) {
	plan := NewSegmentPlan(1001, 1000, 2, 6)
	if plan.GOPFrames != 2 || plan.SegmentFrames != 8 {
		t.Fatalf("unusual rate plan changed frame-grid ceil: %s", plan)
	}
	if got, budget := plan.SegmentSeconds(), math.Max(12, 6+plan.GOPSeconds()); got < 6 || got > budget {
		t.Fatalf("unbounded segment %.6f > %.6f", got, budget)
	}
	micros, exact := plan.SegmentMicros()
	if exact {
		t.Fatal("fixture should require nonexact microseconds")
	}
	wantFloor := int64(plan.SegmentFrames) * int64(plan.FPSDen) * 1_000_000 / int64(plan.FPSNum)
	if micros != wantFloor || plan.HLSTimeArg() != fmt.Sprintf("%d.%06d", wantFloor/1_000_000, wantFloor%1_000_000) {
		t.Fatalf("hls_time is not floored once: %s (%d)", plan.HLSTimeArg(), micros)
	}
	// One frame is the minimum even when the requested GOP is much shorter.
	low := NewSegmentPlan(1, 1000, 2, 6)
	if low.GOPFrames != 1 || low.SegmentFrames != 1 || low.HLSTimeArg() != "1000.000000" {
		t.Fatalf("very low rate minimum frame: %s", low)
	}
	for _, tc := range []struct {
		n, d, frames int
		arg          string
	}{{30, 1, 180, "6.000000"}, {24000, 1001, 144, "6.006000"}, {60000, 1001, 360, "6.006000"}, {1, 5, 2, "10.000000"}} {
		p := NewSegmentPlan(tc.n, tc.d, 2, 6)
		if _, exact := p.SegmentMicros(); !exact || p.SegmentFrames != tc.frames || p.HLSTimeArg() != tc.arg {
			t.Fatalf("common plan changed %d/%d: %s", tc.n, tc.d, p)
		}
	}
}
