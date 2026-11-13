package transcoder

import (
	"fmt"
	"math"
	"math/big"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMeasuredBandwidthModels(t *testing.T) {
	tests := []struct {
		name                string
		sizes               []int64
		durations           []int
		target              int64
		average, peak, dash int64
	}{
		{"constant", []int64{750000, 750000, 750000}, []int{6000000, 6000000, 6000000}, 6000000, 1000000, 1000000, 1000000},
		{"middle burst", []int64{750000, 1500000, 750000}, []int{6000000, 6000000, 6000000}, 6000000, 1333334, 2000000, 1500000},
		{"combined short tail", []int64{750000, 150000}, []int{6000000, 100000}, 6000000, 1180328, 1180328, 1180328},
		{"three short segments", []int64{100, 100, 1000}, []int{1000000, 1000000, 1000000}, 6000000, 3200, 3200, 3200},
		{"single tiny file fallback", []int64{1000}, []int{100000}, 1000000, 80000, 80000, 80000},
		{"one bit per second", []int64{1}, []int{8000000}, 8000000, 1, 1, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := measureSegmentBandwidth(tt.sizes, tt.durations, tt.target, 2000000)
			if err != nil {
				t.Fatal(err)
			}
			if got.Average != tt.average || got.Peak != tt.peak || got.DASH != tt.dash {
				t.Fatalf("average/peak/DASH = %d/%d/%d, want %d/%d/%d", got.Average, got.Peak, got.DASH, tt.average, tt.peak, tt.dash)
			}
			if got.SegmentCount != len(tt.sizes) {
				t.Fatalf("count = %d", got.SegmentCount)
			}
		})
	}
}

// Exhaustive independent rational oracle checks both the duration-restricted
// HLS window deque and the DASH all-starts prefix minimum, including boundaries.
func TestMeasuredBandwidthAgainstExhaustiveWindows(t *testing.T) {
	rng := rand.New(rand.NewSource(8126))
	for trial := 0; trial < 500; trial++ {
		n := rng.Intn(20) + 1
		sizes, durations := make([]int64, n), make([]int, n)
		var totalBytes, totalTicks int64
		for i := range sizes {
			sizes[i] = int64(rng.Intn(100000) + 1)
			durations[i] = rng.Intn(6000000) + 1
			totalBytes += sizes[i]
			totalTicks += int64(durations[i])
		}
		target := int64(rng.Intn(12)+1) * 1000000
		buffer := int64(rng.Intn(4000000) + 1)
		var wantPeak, wantDash int64
		for i := range sizes {
			var size, ticks int64
			for j := i; j < n; j++ {
				size += sizes[j]
				ticks += int64(durations[j])
				if 2*ticks >= target && 2*ticks <= 3*target {
					wantPeak = max(wantPeak, rationalWindowRate(size, ticks))
				}
				wantDash = max(wantDash, rationalWindowRate(size, ticks+buffer))
			}
		}
		wantAverage := rationalWindowRate(totalBytes, totalTicks)
		wantDash = max(wantDash, wantAverage)
		if totalTicks*2 < target {
			wantPeak = wantAverage
		}
		got, err := measureSegmentBandwidth(sizes, durations, target, buffer)
		if wantPeak == 0 {
			if err == nil {
				t.Fatalf("trial %d: no valid HLS window accepted", trial)
			}
			continue
		}
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if got.Average != wantAverage || got.Peak != wantPeak || got.DASH != wantDash {
			t.Fatalf("trial %d: got %+v, want average/peak/DASH %d/%d/%d", trial, got, wantAverage, wantPeak, wantDash)
		}
	}
}

func rationalWindowRate(size, ticks int64) int64 {
	numerator := new(big.Int).Mul(big.NewInt(size), big.NewInt(8000000))
	q, r := new(big.Int), new(big.Int)
	q.QuoRem(numerator, big.NewInt(ticks), r)
	if r.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	return q.Int64()
}

func TestMeasuredBandwidthLargeAndOverflow(t *testing.T) {
	size := int64(1) << 50
	got, err := measureSegmentBandwidth([]int64{size, size}, []int{6000000, 6000000}, 6000000, 2000000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Average != rationalWindowRate(size*2, 12000000) || got.DASH != rationalWindowRate(size*2, 12000000) {
		t.Fatalf("large exact products: %+v", got)
	}
	for _, tt := range []struct {
		name           string
		sizes          []int64
		durations      []int
		target, buffer int64
	}{
		{"empty", nil, nil, 1, 1},
		{"mismatch", []int64{1}, nil, 1, 1},
		{"zero size", []int64{0}, []int{1}, 1, 1},
		{"zero duration", []int64{1}, []int{0}, 1, 1},
		{"negative duration", []int64{1}, []int{-1}, 1, 1},
		{"rate overflow", []int64{math.MaxInt64}, []int{1}, 1, 1},
		{"size sum overflow", []int64{math.MaxInt64/2 + 1, math.MaxInt64/2 + 1}, []int{1000000000, 1000000000}, 1000000000, 1},
		{"time sum overflow", []int64{1, 1}, []int{math.MaxInt64/2 + 1, math.MaxInt64/2 + 1}, 1000000, 1},
		{"buffer sum overflow", []int64{1}, []int{math.MaxInt64 - 1}, math.MaxInt64 - 1, 2},
		{"no valid window", []int64{100}, []int{10000000}, 1000000, 2000000},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := measureSegmentBandwidth(tt.sizes, tt.durations, tt.target, tt.buffer); err == nil {
				t.Fatal("accepted invalid input")
			}
		})
	}
}

func TestMeasureRenditionBandwidthFilesAndPrivateQueries(t *testing.T) {
	dir := t.TempDir()
	for i, size := range []int64{750000, 150000} {
		createBandwidthFile(t, filepath.Join(dir, fmt.Sprintf("segment_%04d.m4s", i)), size)
	}
	createBandwidthFile(t, filepath.Join(dir, "init.mp4"), 10000000)
	path := filepath.Join(dir, "playlist.m3u8")
	content := "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI=\"init.mp4?verify=private-init-token\"\n#EXTINF:6.000000,\nsegment_0000.m4s?verify={$verify}\n#EXTINF:0.100000,\nsegment_0001.m4s?verify=private-segment-token\n#EXT-X-ENDLIST\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := MeasureRenditionBandwidth(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.Bytes != 900000 || got.DurationTicks != 6100000 || got.Peak != 1180328 {
		t.Fatalf("init overhead included or segment measurement wrong: %+v", got)
	}
	for _, buffer := range []float64{0, -1, math.NaN(), math.Inf(1), 1e20, 0.0000001} {
		if _, err := MeasureRenditionBandwidth(path, buffer); err == nil {
			t.Fatalf("accepted buffer %v", buffer)
		}
	}
}

func TestMeasureRenditionBandwidthRejectsUnsafeOrMissingSegments(t *testing.T) {
	for _, name := range []string{"../segment_0000.m4s", "/segment_0000.m4s", "https://example.test/segment_0000.m4s", "sub/segment_0000.m4s", "segment_%2e%2e.m4s", "segment_0000.m4s#fragment", "segment_000.m4s", "segment_0000.m4s\\other", "segment_0001.m4s", "segment_00000.m4s", "missing", "zero", "directory", "symlink"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			uri := name
			switch name {
			case "segment_0001.m4s", "segment_00000.m4s":
				createBandwidthFile(t, filepath.Join(dir, uri), 1000)
			case "missing":
				uri = "segment_0000.m4s"
			case "zero":
				uri = "segment_0000.m4s"
				createBandwidthFile(t, filepath.Join(dir, uri), 0)
			case "directory":
				uri = "segment_0000.m4s"
				if err := os.Mkdir(filepath.Join(dir, uri), 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				uri = "segment_0000.m4s"
				outside := filepath.Join(t.TempDir(), "outside")
				createBandwidthFile(t, outside, 1000)
				if err := os.Symlink(outside, filepath.Join(dir, uri)); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(dir, "playlist.m3u8")
			content := "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n" + uri + "?verify=private-token-must-not-leak\n#EXT-X-ENDLIST\n"
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := MeasureRenditionBandwidth(path, 2)
			if err == nil {
				t.Fatal("accepted unsafe/missing segment")
			}
			if strings.Contains(err.Error(), "private-token") {
				t.Fatalf("query leaked in error: %v", err)
			}
		})
	}
}

func createBandwidthFile(t *testing.T, path string, size int64) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(size); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMeasuredBandwidthManyTinySegments(t *testing.T) {
	const count = 20000
	sizes, durations := make([]int64, count), make([]int, count)
	for i := range sizes {
		sizes[i] = 1
		durations[i] = 1000
	}
	got, err := measureSegmentBandwidth(sizes, durations, 6000000, 2000000)
	if err != nil {
		t.Fatal(err)
	}
	if got.Average != 8000 || got.Peak != 8000 || got.DASH != 8000 {
		t.Fatalf("tiny-segment measurement: %+v", got)
	}
}
