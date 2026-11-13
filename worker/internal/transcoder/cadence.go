package transcoder

import (
	"fmt"
	"math"
	"sort"
)

// CadenceKind describes evidence from every presentation timestamp. Container
// r_frame_rate and avg_frame_rate alone never establish constant frame rate.
type CadenceKind string

const (
	CadenceUnknown CadenceKind = "unknown"
	CadenceCFR     CadenceKind = "cfr"
	CadenceVFR     CadenceKind = "vfr"
)

// CadenceInfo describes the first video stream's full presentation grid. Rate
// is populated only for CFR, after validating every timestamp. One timestamp
// tick of bounded grid error is accepted for quantized rational clocks (for
// example 60000/1001 represented by alternating 1501/1502 ticks at 90 kHz).
// FrameCount is the number of observed packets/samples, not a decoded count.
// This packet-level classification assumes one video frame per sample; codecs
// with packet/frame aggregation should be treated conservatively by callers.
type CadenceInfo struct {
	Kind       CadenceKind
	RateNum    int
	RateDen    int
	FrameCount int64
	Reason     string
}

// cadenceFrameCap bounds classification work, including the allocation-free
// decode timeline. Reordered CTTS/packet PTS also need a sorted int64 array;
// source-index expansion is charged against its shared allocation budget.
const cadenceFrameCap = 8 << 20

func unknownCadence(n int64, reason string) CadenceInfo {
	return CadenceInfo{Kind: CadenceUnknown, FrameCount: n, Reason: reason}
}

func cadenceFromRuns(stts, ctts []runEntry, scale uint32, hints *ProbeResult) CadenceInfo {
	var n int64
	for _, r := range stts {
		n += int64(r.count)
	}
	if n > cadenceFrameCap {
		return unknownCadence(n, "frame count exceeds cadence analysis cap")
	}
	if scale == 0 || n < 3 {
		return unknownCadence(n, "insufficient presentation timestamps")
	}
	// A pure decode timeline is already ordered and can be replayed without a
	// per-frame array. Edit lists accepted by the index reader only translate
	// timestamps, so neither their media offset nor empty delay changes cadence.
	if len(ctts) == 0 {
		walk := func(visit func(int64)) {
			var pts int64
			for _, r := range stts {
				for j := uint32(0); j < r.count; j++ {
					visit(pts)
					pts += r.value
				}
			}
		}
		return classifyCadence(n, int64(scale), 1, walk, hints)
	}
	pts := make([]int64, 0, int(n))
	c := newRunCursor(ctts)
	var dts int64
	for _, r := range stts {
		for j := uint32(0); j < r.count; j++ {
			offset := c.peek()
			if offset > 0 && dts > math.MaxInt64-offset {
				return unknownCadence(n, "composition timeline overflow")
			}
			pts = append(pts, dts+offset)
			c.skip(1)
			dts += r.value
		}
	}
	return cadenceFromPTS(pts, int64(scale), hints)
}

func cadenceFromPTS(pts []int64, scale int64, hints *ProbeResult) CadenceInfo {
	return cadenceFromPTSWithTick(pts, scale, 1, hints)
}

// cadenceFromPTSWithTick sorts its private caller-owned timestamp slice in place.
func cadenceFromPTSWithTick(pts []int64, scale, tick int64, hints *ProbeResult) CadenceInfo {
	if len(pts) < 3 || scale <= 0 {
		return unknownCadence(int64(len(pts)), "insufficient presentation timestamps")
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i] < pts[j] })
	return classifyCadence(int64(len(pts)), scale, tick, func(visit func(int64)) {
		for _, p := range pts {
			visit(p)
		}
	}, hints)
}

type cadenceRate struct{ num, den int }

func classifyCadence(n, scale, tick int64, walk func(func(int64)), hints *ProbeResult) CadenceInfo {
	var first, last, previous, delta int64
	var i int64
	constant, monotonic := true, true
	walk(func(p int64) {
		if i == 0 {
			first = p
		} else {
			if p <= previous {
				monotonic = false
			}
			if i == 1 {
				delta = p - previous
			} else if p-previous != delta {
				constant = false
			}
		}
		previous = p
		last = p
		i++
	})
	if first < 0 && last > math.MaxInt64+first {
		return unknownCadence(n, "presentation span overflow")
	}
	if !monotonic || last <= first {
		return unknownCadence(n, "duplicate or invalid presentation timestamps")
	}
	if float64(last-first)/float64(n-1) < 2*float64(tick) {
		return unknownCadence(n, "timestamp clock too coarse to establish cadence")
	}
	// An exact constant start delta outranks metadata averages, which may
	// include a shortened or extended last sample. Hints still require proof.
	rates := []cadenceRate{}
	if constant {
		rates = append(rates, reducedCadenceRate(scale, delta))
	}
	if hints != nil {
		rates = append(rates, cadenceRate{hints.FrameRateNum, hints.FrameRateDen}, cadenceRate{hints.AvgFrameRateNum, hints.AvgFrameRateDen})
	}
	for _, r := range []cadenceRate{{24000, 1001}, {30000, 1001}, {60000, 1001}, {120000, 1001}, {24, 1}, {25, 1}, {30, 1}, {48, 1}, {50, 1}, {60, 1}, {100, 1}, {120, 1}} {
		rates = append(rates, r)
	}
	// An endpoint slope is only a candidate, never CFR evidence: every prefix
	// must still fit. Reduce its rational rather than guessing an integer FPS.
	// Products are bounded explicitly, since untrusted movie indexes can span
	// timestamps far beyond the duration of a realistic source.
	if n-1 <= math.MaxInt64/scale && last-first > 0 {
		rates = append(rates, reducedCadenceRate((n-1)*scale, last-first))
	}
	for _, r := range rates {
		r = reducedCadenceRate(int64(r.num), int64(r.den))
		if r.num <= 0 || r.den <= 0 {
			continue
		}
		period := float64(scale) * float64(r.den) / float64(r.num)
		// A timebase with fewer than two ticks per frame cannot distinguish CFR
		// from substantial timestamp variability reliably.
		if period < 2*float64(tick) {
			continue
		}
		valid := true
		var j int64
		walk(func(p int64) {
			if math.Abs(float64(p-first)-float64(j)*period) > float64(tick)+0.000001 {
				valid = false
			}
			j++
		})
		if valid {
			r = reducedCadenceRate(int64(r.num), int64(r.den))
			return CadenceInfo{Kind: CadenceCFR, RateNum: r.num, RateDen: r.den, FrameCount: n, Reason: "all presentation timestamps fit one rational frame grid"}
		}
	}
	if constant {
		return unknownCadence(n, "constant grid rate exceeds supported rational bounds")
	}
	return CadenceInfo{Kind: CadenceVFR, FrameCount: n, Reason: fmt.Sprintf("presentation timestamps depart from a constant grid (timebase 1/%d)", scale)}
}

func reducedCadenceRate(num, den int64) cadenceRate {
	if num <= 0 || den <= 0 {
		return cadenceRate{}
	}
	a, b := num, den
	for b != 0 {
		a, b = b, a%b
	}
	num /= a
	den /= a
	// Keep finite-span candidates from feeding enormous integer operands into
	// GOP planning; ordinary media rational clocks reduce far below this bound.
	if num > 1_000_000_000 || den > 1_000_000_000 {
		return cadenceRate{}
	}
	if int64(int(num)) != num || int64(int(den)) != den {
		return cadenceRate{}
	}
	return cadenceRate{int(num), int(den)}
}
