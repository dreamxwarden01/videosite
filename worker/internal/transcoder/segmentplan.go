package transcoder

import (
	"fmt"
	"math"
)

// SegmentPlan is the segmentation decision for one rendition, expressed in
// whole frames rather than seconds.
//
// Why frames: FFmpeg's HLS muxer does not compare each segment against a
// target length. It accumulates an absolute threshold — `hls_time × N`, in
// integer microseconds, measured from the first packet — and cuts at the first
// keyframe at or past it. Any per-segment difference between the value we hand
// it and the length the encoder actually produces therefore accumulates, and
// once the accumulated deficit reaches one GOP the muxer cuts a whole GOP
// early. That is a single odd segment in an otherwise uniform playlist, which
// is enough to fail the DASH uniformity check and force SegmentTimeline.
//
// A frame count removes the possibility rather than shrinking it. The GOP and
// the segment are both integer frame counts, the segment is a whole number of
// GOPs, and the resulting duration is converted back to time through the exact
// frame-rate rational — so `hls_time` is precisely what the encoder emits and
// the threshold tracks the media forever. This is the same choice Cloudflare
// Stream makes (4.000 s at 15 fps = 60 frames, published as
// `duration="60000" timescale="15000"`).
//
// The plan is resolved once per rendition and then passed to FFmpeg verbatim.
// Nothing downstream re-derives it from seconds.
type SegmentPlan struct {
	FPSNum        int // output frame rate numerator (e.g. 24000)
	FPSDen        int // output frame rate denominator (e.g. 1001)
	GOPFrames     int // keyint, in frames
	SegmentFrames int // segment length in frames; always a whole number of GOPs
}

// defaultPlanFPS is the frame rate assumed when the probe could not report one.
// 30/1 matches the site-wide profile default and keeps the plan well-formed.
const defaultPlanFPSNum, defaultPlanFPSDen = 30, 1

// NewSegmentPlan resolves the target GOP and segment durations (in seconds)
// onto the output frame grid.
//
// The GOP is the frame count closest to targetGOPSec — round, not ceil, so a
// 2.0 s target at 23.976 fps lands on 48 frames (2.002 s) rather than 49.
// The segment is the smallest whole number of GOPs at or past targetSegSec,
// preserving the previous ceil-to-GOP-multiple behaviour.
//
// The segment count is then nudged up, if needed, to the nearest multiple that
// makes its duration a whole number of microseconds — see
// microsecondAlignedGOPs. In every frame rate this project has encountered the
// natural choice is already aligned and no adjustment happens; the step exists
// so an unusual rate degrades into a slightly longer segment instead of into
// accumulating drift.
func NewSegmentPlan(fpsNum, fpsDen int, targetGOPSec, targetSegSec float64) SegmentPlan {
	if fpsNum <= 0 || fpsDen <= 0 {
		fpsNum, fpsDen = defaultPlanFPSNum, defaultPlanFPSDen
	}
	fps := float64(fpsNum) / float64(fpsDen)

	gopFrames := int(math.Round(targetGOPSec * fps))
	if gopFrames < 1 {
		gopFrames = 1
	}

	gopSec := float64(gopFrames) * float64(fpsDen) / float64(fpsNum)
	gops := int(math.Ceil(targetSegSec/gopSec - 1e-9))
	if gops < 1 {
		gops = 1
	}
	if step := microsecondAlignedGOPs(fpsNum, fpsDen, gopFrames); step > 1 {
		gops = ((gops + step - 1) / step) * step
	}

	return SegmentPlan{
		FPSNum:        fpsNum,
		FPSDen:        fpsDen,
		GOPFrames:     gopFrames,
		SegmentFrames: gops * gopFrames,
	}
}

// microsecondAlignedGOPs returns the GOP-count multiple required for a
// segment's duration to be a whole number of microseconds.
//
// FFmpeg parses -hls_time as an int64 microsecond duration, so a segment whose
// true length is not a whole microsecond can never be expressed exactly and
// reintroduces the per-segment deficit this type exists to remove. A segment
// of S frames lasts S·FPSDen/FPSNum seconds, i.e. S·FPSDen·10^6/FPSNum µs,
// which is integral exactly when FPSNum/gcd(FPSNum, FPSDen·10^6) divides S.
//
// Returns 1 when the natural segment length is already aligned, which is the
// case for every rate we ship against (integer rates, and the 1001-family:
// 24000/1001 needs S divisible by 6, and a 48-frame GOP already is).
func microsecondAlignedGOPs(fpsNum, fpsDen, gopFrames int) int {
	need := fpsNum / gcd(fpsNum, fpsDen*1_000_000)
	if need <= 1 {
		return 1
	}
	// S = gops × gopFrames must be a multiple of `need`; the GOP already
	// supplies gcd(gopFrames, need) of it.
	return need / gcd(gopFrames, need)
}

func gcd(a, b int) int {
	if a < 0 {
		a = -a
	}
	if b < 0 {
		b = -b
	}
	for b != 0 {
		a, b = b, a%b
	}
	if a == 0 {
		return 1
	}
	return a
}

// GOPSeconds returns the GOP length in seconds. Derived, never authoritative —
// FFmpeg is given GOPFrames.
func (p SegmentPlan) GOPSeconds() float64 {
	if p.FPSNum <= 0 {
		return 0
	}
	return float64(p.GOPFrames) * float64(p.FPSDen) / float64(p.FPSNum)
}

// SegmentSeconds returns the segment length in seconds. Derived; used for
// manifests and logging.
func (p SegmentPlan) SegmentSeconds() float64 {
	if p.FPSNum <= 0 {
		return 0
	}
	return float64(p.SegmentFrames) * float64(p.FPSDen) / float64(p.FPSNum)
}

// SegmentMicros returns the segment length in microseconds along with whether
// it is exact. When exact, the value passed to -hls_time is bit-for-bit the
// length the encoder produces.
func (p SegmentPlan) SegmentMicros() (int64, bool) {
	if p.FPSNum <= 0 {
		return 0, false
	}
	num := int64(p.SegmentFrames) * int64(p.FPSDen) * 1_000_000
	if num%int64(p.FPSNum) != 0 {
		return num / int64(p.FPSNum), false
	}
	return num / int64(p.FPSNum), true
}

// HLSTimeArg formats the -hls_time value for a transcode.
//
// No safety margin is subtracted. The encoder is pinned to this exact frame
// grid by -force_key_frames on the frame number, so the threshold and the
// keyframe coincide on every segment and `>=` is satisfied at the intended
// cut. Subtracting a margin here is what previously produced one short segment
// every GOPSeconds÷margin segments.
func (p SegmentPlan) HLSTimeArg() string {
	us, _ := p.SegmentMicros()
	return fmt.Sprintf("%.6f", float64(us)/1e6)
}

// KeyframeExpr returns the -force_key_frames expression pinning IDRs to the
// frame grid.
//
// Frame number, not time. The time form (`gte(t, n_forced*G)`) has to restate
// the GOP as a float, and any error in that float — including a deliberate
// epsilon — is multiplied by the forced-keyframe counter and walks the grid
// off the frame boundary. `mod(n, G) == 0` is integer arithmetic on the
// encoder's own frame counter and cannot drift.
//
// Verified to produce IDRs on every one of libx264, h264_nvenc and h264_qsv
// (the hardware encoders additionally need their forced-IDR flag — see
// applyEncoderOpts).
func (p SegmentPlan) KeyframeExpr() string {
	return fmt.Sprintf("expr:eq(mod(n,%d),0)", p.GOPFrames)
}

// String renders the plan for the decision log.
func (p SegmentPlan) String() string {
	us, exact := p.SegmentMicros()
	note := ""
	if !exact {
		note = " (segment not µs-exact; hls_time rounded)"
	}
	return fmt.Sprintf("%d/%d fps, GOP %d frames (%.6fs), segment %d frames (%.6fs = %dµs)%s",
		p.FPSNum, p.FPSDen, p.GOPFrames, p.GOPSeconds(), p.SegmentFrames, p.SegmentSeconds(), us, note)
}

// remuxSafetyGOPDivisor sizes the margin subtracted from -hls_time on the
// REMUX path only, as a fraction of the GOP.
//
// Remux cannot use the exact value a transcode uses. We do not own the source
// timebase, and a source whose frame duration is not a whole number of its own
// ticks has keyframe timestamps that wobble either side of the nominal grid —
// a 59.94 fps source in a 1/90000 timebase alternates 1501/1502 ticks per
// frame, so IDR PTS land microseconds below the exact threshold about half the
// time and the muxer skips a GOP. Measured on such a source: an exact
// hls_time produced 78 misplaced segments where a margin produced 1.
//
// The margin has to stay proportional to the GOP, because the deficit it
// creates is what eventually costs a segment: the first misplaced cut arrives
// after GOP÷margin segments, so a fixed 1 ms margin broke a 0.5 s-GOP source
// after 500 segments (50 min) while leaving a 2 s-GOP source alone for 2000
// (3 h 20 m). At GOP/4000 that horizon is a constant 4000 segments — about
// 6.7 h at 6 s segments — for every source.
const remuxSafetyGOPDivisor = 4000

// RemuxHLSTime returns the -hls_time value for a stream copy, where the
// keyframe positions are the source's and we can only approach them.
//
// Quantised to whole microseconds because that is what FFmpeg parses the
// option into. Doing it here rather than at formatting time means
// RemuxSegmentsWouldBeUniform simulates against exactly the threshold the
// muxer will use, not a value that differs in the last decimal.
func RemuxHLSTime(segmentSec, gopSec float64) float64 {
	margin := gopSec / remuxSafetyGOPDivisor
	if margin <= 0 || margin >= segmentSec {
		margin = segmentSec / remuxSafetyGOPDivisor
	}
	return math.Round((segmentSec-margin)*1e6) / 1e6
}

// RemuxHLSTimeArg formats RemuxHLSTime for the command line.
func RemuxHLSTimeArg(segmentSec, gopSec float64) string {
	return fmt.Sprintf("%.6f", RemuxHLSTime(segmentSec, gopSec))
}

// SimulateRemuxSegments predicts the segment durations a stream copy would
// produce from a source with the given IDR timestamps.
//
// It reproduces FFmpeg's HLS muxer cut rule: the muxer keeps an absolute
// threshold of `hls_time × N` measured from the first packet and starts a new
// segment at the first keyframe at or past it. A stream copy adds nothing of
// its own — the cut points are exactly the source IDRs — so the whole playlist
// is predictable from the index we already read, before spending any I/O.
//
// Checked against production output for two 59.94 fps sources whose remuxed
// renditions were 1027 and 1565 segments long: the prediction matched the
// shipped playlists segment for segment, with no mismatches.
//
// Returns the full segments only; there is no trailing partial, since the
// media after the last cut is not represented in the IDR list.
func SimulateRemuxSegments(idrTimes []float64, hlsTimeSec float64) []float64 {
	if len(idrTimes) < 2 || hlsTimeSec <= 0 {
		return nil
	}
	// The comparison FFmpeg makes is exact; this epsilon only absorbs the
	// float representation of timestamps that are exact rationals in the
	// source timebase, so a boundary landing precisely on the threshold is
	// treated as reaching it rather than missing it by an ULP.
	const eps = 1e-9

	start := idrTimes[0]
	segStart := start
	number := 1
	out := make([]float64, 0, int(float64(len(idrTimes))/2)+1)
	for _, t := range idrTimes[1:] {
		if t-start >= float64(number)*hlsTimeSec-eps {
			out = append(out, t-segStart)
			segStart = t
			number++
		}
	}
	return out
}

// RemuxSegmentsWouldBeUniform reports whether a stream copy of this source
// would produce a playlist that passes the same uniformity test
// WriteDASHManifest applies, and a short human-readable reason for the log.
//
// This exists because "is the source GOP constant enough to remux" cannot be
// answered by a tolerance on inter-IDR deviation. Two 59.94 fps lectures
// measured 0.0339 s and 0.0317 s maximum deviation — indistinguishable to any
// threshold — yet one remuxes to a uniform playlist and the other cannot,
// because what actually matters is how OFTEN the source runs long, not by how
// much. The first carried 22 off-nominal GOPs in 6259 (0.35%); the second
// carried 286 in 4100 (7%), and each one nudges the media clock ahead of the
// muxer's fixed threshold until it slips a whole GOP.
//
// Simulating the outcome answers the real question directly, so the bit-exact
// copy is kept wherever it genuinely works and only the sources that would
// produce a ragged playlist pay for a re-encode.
func RemuxSegmentsWouldBeUniform(idrTimes []float64, plan SegmentPlan) (bool, string) {
	if len(idrTimes) < 2 {
		return false, "source has too few IDRs to predict segmentation"
	}
	segs := SimulateRemuxSegments(idrTimes, RemuxHLSTime(plan.SegmentSeconds(), plan.GOPSeconds()))
	if len(segs) < 2 {
		return false, "source yields fewer than two segments"
	}

	ticks := make([]int, len(segs))
	for i, s := range segs {
		ticks[i] = int(math.Round(s * float64(dashTimescale)))
	}
	modal, ok := uniformModalTicks(ticks)
	if ok {
		return true, fmt.Sprintf("%d segments, all within tolerance of %.6fs", len(segs), float64(modal)/float64(dashTimescale))
	}

	// Report the worst offender — it is the number an operator wants when
	// deciding whether a re-encode was justified.
	worstIdx, worstDev := 0, 0
	best, _ := modalOf(ticks)
	for i, tk := range ticks {
		dev := tk - best
		if dev < 0 {
			dev = -dev
		}
		if dev > worstDev {
			worstIdx, worstDev = i, dev
		}
	}
	return false, fmt.Sprintf("%d segments, worst deviation %.0fms at segment %d (modal %.6fs)",
		len(segs), float64(worstDev)/1000, worstIdx, float64(best)/float64(dashTimescale))
}

// modalOf returns the most common value in the slice and its count.
func modalOf(v []int) (int, int) {
	counts := make(map[int]int, len(v))
	var modal, modalCount int
	for _, x := range v {
		counts[x]++
		if counts[x] > modalCount {
			modal, modalCount = x, counts[x]
		}
	}
	return modal, modalCount
}
