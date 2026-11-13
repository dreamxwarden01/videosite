package transcoder

import (
	"fmt"
	"math"
	"math/bits"
	"os"
	"path/filepath"
	"strings"
)

// RenditionBandwidth contains measured media-segment rates in bits/second.
// Initialization segments and transport overhead are excluded. DurationTicks
// uses the same microsecond timebase as the generated media playlists.
type RenditionBandwidth struct {
	Average       int64
	Peak          int64
	DASH          int64
	Bytes         int64
	DurationTicks int64
	SegmentCount  int
}

// MeasureRenditionBandwidth measures completed local CMAF output. Segment
// payloads are never read. The canonical generated segment_%04d.m4s sequence
// starting at zero is required, matching DASH's startNumber and media template.
// Query strings are discarded before filesystem use.
func MeasureRenditionBandwidth(playlistPath string, minBufferTimeSeconds float64) (RenditionBandwidth, error) {
	var zero RenditionBandwidth
	if math.IsNaN(minBufferTimeSeconds) || math.IsInf(minBufferTimeSeconds, 0) || minBufferTimeSeconds <= 0 || minBufferTimeSeconds*1e6 >= float64(math.MaxInt64) {
		return zero, fmt.Errorf("invalid DASH minimum buffer time")
	}
	// Round down so precision loss cannot overstate the available buffer.
	bufferTicks := int64(math.Floor(minBufferTimeSeconds * 1e6))
	if bufferTicks <= 0 {
		return zero, fmt.Errorf("DASH minimum buffer time is below one microsecond")
	}
	playlist, err := readMediaPlaylist(playlistPath)
	if err != nil {
		return zero, fmt.Errorf("read bandwidth playlist: %w", err)
	}
	if playlist.TargetDurationTicks <= 0 {
		return zero, fmt.Errorf("bandwidth playlist requires a positive target duration")
	}
	root, err := os.OpenRoot(filepath.Dir(playlistPath))
	if err != nil {
		return zero, fmt.Errorf("open media segment directory: %w", err)
	}
	defer root.Close()
	sizes := make([]int64, len(playlist.URIs))
	for i, uri := range playlist.URIs {
		name, _, _ := strings.Cut(uri, "?")
		if !generatedSegmentBasename(name) || name != fmt.Sprintf("segment_%04d.m4s", i) {
			// Never include the original URI: it may carry a private HMAC token.
			return zero, fmt.Errorf("invalid media segment URI at index %d", i)
		}
		// Root confines resolution even if the directory is renamed concurrently;
		// Lstat rejects symbolic links without following them or reading bodies.
		info, err := root.Lstat(name)
		if err != nil {
			return zero, fmt.Errorf("stat media segment at index %d: %w", i, err)
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 {
			return zero, fmt.Errorf("media segment at index %d must be a nonempty regular file", i)
		}
		sizes[i] = info.Size()
	}
	return measureSegmentBandwidth(sizes, playlist.Durations, int64(playlist.TargetDurationTicks), bufferTicks)
}

func generatedSegmentBasename(name string) bool {
	if !strings.HasPrefix(name, "segment_") || !strings.HasSuffix(name, ".m4s") {
		return false
	}
	digits := name[len("segment_") : len(name)-len(".m4s")]
	if len(digits) < 4 {
		return false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func measureSegmentBandwidth(sizes []int64, durations []int, targetTicks, bufferTicks int64) (RenditionBandwidth, error) {
	var result RenditionBandwidth
	if len(sizes) == 0 || len(sizes) != len(durations) || targetTicks <= 0 || bufferTicks <= 0 {
		return result, fmt.Errorf("invalid bandwidth measurement inputs")
	}
	bytePrefix := make([]int64, len(sizes)+1)
	timePrefix := make([]int64, len(sizes)+1)
	var upper int64
	for i, size := range sizes {
		duration := int64(durations[i])
		if size <= 0 || duration <= 0 || size > math.MaxInt64-bytePrefix[i] || duration > math.MaxInt64-timePrefix[i] {
			return result, fmt.Errorf("invalid or overflowing media segment at index %d", i)
		}
		bytePrefix[i+1] = bytePrefix[i] + size
		timePrefix[i+1] = timePrefix[i] + duration
		rate, err := ceilMediaRate(size, duration)
		if err != nil {
			return result, fmt.Errorf("segment rate at index %d: %w", i, err)
		}
		if rate > upper {
			upper = rate
		}
	}
	result.Bytes = bytePrefix[len(sizes)]
	result.DurationTicks = timePrefix[len(sizes)]
	result.SegmentCount = len(sizes)
	if bufferTicks > math.MaxInt64-result.DurationTicks {
		return RenditionBandwidth{}, fmt.Errorf("DASH buffered duration overflows")
	}
	var err error
	result.Average, err = ceilMediaRate(result.Bytes, result.DurationTicks)
	if err != nil {
		return RenditionBandwidth{}, err
	}

	// RFC 8216 section 4.1: include EVERY contiguous set whose duration
	// lies in [0.5*T, 1.5*T], including combinations ending in a short tail.
	// The RFC defines no peak if an entire short file is below 0.5*T;
	// use its measured average as an explicit conservative fallback then.
	minimum := targetTicks/2 + targetTicks%2
	maximum := int64(math.MaxInt64)
	if targetTicks <= math.MaxInt64-targetTicks/2 {
		maximum = targetTicks + targetTicks/2
	}
	if result.DurationTicks < minimum {
		result.Peak = result.Average
	} else {
		found := false
		deque := make([]int, len(sizes)+1)
		feasible := func(rate int64) bool {
			head, tail, next := 0, 0, 0
			for end := 1; end < len(timePrefix); end++ {
				for next < end && timePrefix[end]-timePrefix[next] >= minimum {
					// Keep prefix minima of bytes*8e6-rate*time. The
					// difference comparison uses exact 128-bit products.
					for tail > head && !prefixScoreLess(deque[tail-1], next, bytePrefix, timePrefix, rate) {
						tail--
					}
					deque[tail] = next
					tail++
					next++
				}
				for head < tail && timePrefix[end]-timePrefix[deque[head]] > maximum {
					head++
				}
				if head < tail {
					found = true
					start := deque[head]
					if mediaRateExceeds(bytePrefix[end]-bytePrefix[start], timePrefix[end]-timePrefix[start], rate) {
						return false
					}
				}
			}
			return true
		}
		result.Peak = leastFeasibleRate(upper, feasible)
		feasible(result.Peak) // Also inspect windows when upper == 1.
		if !found {
			return RenditionBandwidth{}, fmt.Errorf("no contiguous media window satisfies HLS target duration")
		}
	}

	// Segment-boundary leaky-bucket model: starting at ANY segment, bytes
	// through each segment endpoint must arrive within elapsed media time+B.
	// Thus required rate = ceil(max_windows(8*bytes/(duration+B))). This is
	// an exact envelope for piecewise-linear segment consumption, not a claim
	// about unmeasured sample-level bursts inside CMAF segments. DASH-IF's
	// minBufferTime model assumes ideal progressive delivery. See section
	// 3.2.8: https://dashif.org/docs/DASH-IF-IOP-v4.2-clean.htm . Bento4's
	// mp4utils.ComputeBandwidth uses a related, order-dependent approximation;
	// do not copy its first-segment seed or one-pass adjustment here.
	result.DASH = leastFeasibleRate(upper, func(rate int64) bool {
		start := 0
		for end := 1; end < len(timePrefix); end++ {
			if mediaRateExceeds(bytePrefix[end]-bytePrefix[start], timePrefix[end]-timePrefix[start]+bufferTicks, rate) {
				return false
			}
			if prefixScoreLess(end, start, bytePrefix, timePrefix, rate) {
				start = end
			}
		}
		return true
	})
	// Finite clips can exploit the initial buffer to produce an envelope below
	// their average. Retain the measured average as a conservative floor. This
	// segment-level estimate still makes no intra-segment sample compliance claim.
	result.DASH = max(result.DASH, result.Average)
	return result, nil
}

// Both feasibility checks are linear; integer binary search bounds each one
// to at most 63 passes, even for tiny segments or arbitrarily long playlists.
func leastFeasibleRate(upper int64, feasible func(int64) bool) int64 {
	lower := int64(1)
	for lower < upper {
		middle := lower + (upper-lower)/2
		if feasible(middle) {
			upper = middle
		} else {
			lower = middle + 1
		}
	}
	return lower
}

func prefixScoreLess(a, b int, bytes, ticks []int64, rate int64) bool {
	if a < b {
		return compareProducts(uint64(bytes[b]-bytes[a]), 8_000_000, uint64(ticks[b]-ticks[a]), uint64(rate)) > 0
	}
	return compareProducts(uint64(bytes[a]-bytes[b]), 8_000_000, uint64(ticks[a]-ticks[b]), uint64(rate)) < 0
}

func mediaRateExceeds(size, ticks, rate int64) bool {
	return compareProducts(uint64(size), 8_000_000, uint64(ticks), uint64(rate)) > 0
}

func compareProducts(a, b, c, d uint64) int {
	ah, al := bits.Mul64(a, b)
	ch, cl := bits.Mul64(c, d)
	if ah < ch || (ah == ch && al < cl) {
		return -1
	}
	if ah == ch && al == cl {
		return 0
	}
	return 1
}

func ceilMediaRate(size, ticks int64) (int64, error) {
	hi, lo := bits.Mul64(uint64(size), 8_000_000)
	if hi >= uint64(ticks) {
		return 0, fmt.Errorf("measured bandwidth overflows")
	}
	quotient, remainder := bits.Div64(hi, lo, uint64(ticks))
	if quotient > math.MaxInt64 || (quotient == math.MaxInt64 && remainder != 0) {
		return 0, fmt.Errorf("measured bandwidth overflows")
	}
	if remainder != 0 {
		quotient++
	}
	return int64(quotient), nil
}
