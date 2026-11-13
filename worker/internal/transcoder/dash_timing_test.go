package transcoder

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUniformDurationCumulativeBoundaries(t *testing.T) {
	clustered, alternating := make([]int, 1000), make([]int, 1000)
	for i := range clustered {
		clustered[i] = 6_000_000
		if i >= 600 {
			clustered[i] = 6_016_000
		}
		alternating[i] = 6_000_000 + (i%2)*16_000
	}
	if got, ok := uniformDurationTicks(clustered); ok {
		t.Fatalf("clustered drift accepted: %d", got)
	}
	if got, ok := uniformDurationTicks(alternating); !ok || got != 6_008_000 {
		t.Fatalf("mean candidate=%d,%v", got, ok)
	}
	if durationCandidateFits(alternating, 6_000_000) {
		t.Fatal("local mode accepted cumulative drift")
	}
	if got, ok := uniformDurationTicks([]int{6_016_000, 6_000_000}); !ok || got != 6_000_000 {
		t.Fatalf("mode tie=%d,%v", got, ok)
	}
	if got, ok := uniformDurationTicks([]int{6_000_000, 6_090_000, 5_910_000, 6_000_000}); !ok || got != 6_000_000 {
		t.Fatalf("bounded 90ms jitter rejected: %d,%v", got, ok)
	}
	for _, durs := range [][]int{nil, {0}, {-1}, {int(^uint(0) >> 1), 1}} {
		if _, ok := uniformDurationTicks(durs); ok {
			t.Fatalf("invalid/overflow accepted: %v", durs)
		}
	}
}

func timingPlaylist(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "playlist.m3u8")
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}
func TestMediaPlaylistPairsAndRetainsURIs(t *testing.T) {
	p, err := readMediaPlaylist(timingPlaylist(t, "#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.016000,title\nsegment_0000.m4s?verify={$verify}\n#EXTINF:0.1234567,\nsegment_0001.m4s\n#EXT-X-ENDLIST\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Durations) != 2 || p.Durations[0] != 6_016_000 || p.Durations[1] != 123_457 || p.TargetDurationTicks != 7_000_000 || p.URIs[0] != "segment_0000.m4s?verify={$verify}" {
		t.Fatalf("metadata=%#v", p)
	}
	p, err = readMediaPlaylist(timingPlaylist(t, "#EXTM3U\n#EXTINF:1,\na.m4s\n"))
	if err != nil || p.TargetDurationTicks != 0 {
		t.Fatalf("old fixture: %#v %v", p, err)
	}
}
func TestMediaPlaylistRejectsMalformedInput(t *testing.T) {
	for _, value := range []string{"NaN", "Inf", "+Inf", "-Inf", "1e2", "0", "-1", "+1", ".5", "1.", "1.2.3", "1 2", "0.0000001", "18446744073709551615", "9223372036854.775808"} {
		t.Run(value, func(t *testing.T) {
			if _, err := readMediaPlaylist(timingPlaylist(t, "#EXTM3U\n#EXTINF:"+value+",\na.m4s?private=query\n")); err == nil {
				t.Fatalf("accepted %q", value)
			}
		})
	}
	for _, body := range []string{
		"#EXTINF:6,\na.m4s\n", "#EXTM3U\n#EXTINF:6,\n", "#EXTM3U\na.m4s?private=query\n",
		"#EXTM3U\n#EXTINF:6,\n#EXTINF:6,\na.m4s\n", "#EXTM3U\n#EXTINF:6\na.m4s\n",
		"#EXTM3U\n#EXTINF:6,\n#EXT-X-ENDLIST\n", "#EXTM3U\n#EXT-X-ENDLIST\n#EXTINF:6,\na.m4s\n",
		"#EXTM3U\n#EXT-X-BYTERANGE:1@0\n#EXTINF:6,\na.m4s\n", "#EXTM3U\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\na.m4s\n",
		"#EXTM3U\n#EXT-X-TARGETDURATION:6.0\n#EXTINF:6,\na.m4s\n", "#EXTM3U\n#EXT-X-TARGETDURATION:0\n#EXTINF:6,\na.m4s\n",
		"#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-TARGETDURATION:7\n#EXTINF:6,\na.m4s\n",
		"#EXTM3U\n#EXTINF:9223372036854,\na.m4s\n#EXTINF:6,\nb.m4s\n",
		"#EXTM3U\n#EXTINF:6,\n" + strings.Repeat("s", 1024*1024) + "?private=query\n",
	} {
		_, err := readMediaPlaylist(timingPlaylist(t, body))
		if err == nil {
			t.Fatal("accepted malformed input")
		}
		if strings.Contains(err.Error(), "private=query") {
			t.Fatal("URI query leaked")
		}
	}
}
func TestISODurationPrecisionAndCarry(t *testing.T) {
	for ticks, want := range map[int]string{1: "PT0.000001S", 1234567: "PT1.234567S", 59999999: "PT59.999999S", 60000000: "PT1M", 3600000000: "PT1H", 3660123456: "PT1H1M0.123456S"} {
		if got := formatISODurationTicks(ticks); got != want {
			t.Fatalf("%d: %q != %q", ticks, got, want)
		}
	}
	if got := formatISODuration(59.9999996); got != "PT1M" {
		t.Fatalf("minute carry=%s", got)
	}
	for _, sec := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64} {
		if _, err := durationSecondsTicks(sec); err == nil {
			t.Fatalf("accepted source duration %v", sec)
		}
	}
}
func writeTimingMPD(t *testing.T, video, audio []int, duration float64) string {
	t.Helper()
	dir := t.TempDir()
	for name, durs := range map[string][]int{"video/test": video, "audio/aac": audio} {
		if durs == nil {
			continue
		}
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		var body strings.Builder
		body.WriteString("#EXTM3U\n")
		target := 1
		for _, d := range durs {
			if n := (d + dashTimescale - 1) / dashTimescale; n > target {
				target = n
			}
		}
		fmt.Fprintf(&body, "#EXT-X-TARGETDURATION:%d\n", target)
		for i, d := range durs {
			fmt.Fprintf(&body, "#EXTINF:%d.%06d,\nsegment_%04d.m4s\n", d/dashTimescale, d%dashTimescale, i)
			if err := os.WriteFile(filepath.Join(path, fmt.Sprintf("segment_%04d.m4s", i)), []byte{1}, 0644); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(path, "playlist.m3u8"), []byte(body.String()), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteDASHManifest(dir, []Variant{{Name: "test", Codecs: "avc1.64002A", VideoBitrateKbps: 1000, FrameRate: 30}}, "aac", 192, 48000, duration, audio != nil); err != nil {
		t.Fatal(err)
	}
	mpd, err := os.ReadFile(filepath.Join(dir, "manifest.mpd"))
	if err != nil {
		t.Fatal(err)
	}
	return string(mpd)
}
func TestDASHCompactTailAndEffectiveDuration(t *testing.T) {
	for _, tc := range []struct {
		name    string
		durs    []int
		source  float64
		compact bool
	}{
		{"short partial", []int{6_000_000, 123_456}, 6.123456, true},
		{"single segment", []int{123_456}, .123456, false},
		{"oversized tail", []int{6_000_000, 7_000_000}, 13, false},
		{"tiny tail reduces implicit count", []int{6_000_000, 5_990_000, 6_000_000, 1}, 17.990001, false},
		{"source cap changes count", []int{6_000_000, 6_000_000, 1_000_000}, 6, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mpd := writeTimingMPD(t, tc.durs, nil, tc.source)
			if got := !strings.Contains(mpd, "<SegmentTimeline>"); got != tc.compact {
				t.Fatalf("compact=%v want %v: %s", got, tc.compact, mpd)
			}
		})
	}
	mpd := writeTimingMPD(t, []int{6_000_000, 2_123_456}, []int{6_000_000, 2_123_455}, 9)
	if !strings.Contains(mpd, `mediaPresentationDuration="PT8.123455S"`) {
		t.Fatalf("shortest precision lost: %s", mpd)
	}
	long := make([]int, 10001)
	for i := range long {
		long[i] = 6_000_000
	}
	long[len(long)-1] = 123_456
	if mpd := writeTimingMPD(t, long, nil, 60_000.123456); strings.Contains(mpd, "<SegmentTimeline>") || !strings.Contains(mpd, `mediaPresentationDuration="PT16H40M0.123456S"`) {
		t.Fatalf("long compactness/precision: %s", mpd)
	}
}

func TestDASHInvalidTimingPreservesExistingManifest(t *testing.T) {
	dir := t.TempDir()
	track := filepath.Join(dir, "video", "test")
	if err := os.MkdirAll(track, 0755); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(dir, "manifest.mpd")
	if err := os.WriteFile(manifest, []byte("existing"), 0644); err != nil {
		t.Fatal(err)
	}
	variants := []Variant{{Name: "test", Codecs: "avc1.64002A", FrameRate: 30}}
	for _, tc := range []struct {
		duration float64
		body     string
	}{
		{math.NaN(), "#EXTM3U\n#EXTINF:1,\na.m4s\n"},
		{math.Inf(1), "#EXTM3U\n#EXTINF:1,\na.m4s\n"},
		{0, "#EXTM3U\n#EXTINF:1,\na.m4s\n"},
		{1, "#EXTM3U\n#EXTINF:NaN,\na.m4s\n"},
		{1, "#EXTM3U\n#EXTINF:1,\n#EXTINF:1,\nb.m4s\n"},
	} {
		if err := os.WriteFile(filepath.Join(track, "playlist.m3u8"), []byte(tc.body), 0644); err != nil {
			t.Fatal(err)
		}
		if err := WriteDASHManifest(dir, variants, "", 0, 0, tc.duration, false); err == nil {
			t.Fatal("invalid timing accepted")
		}
		got, err := os.ReadFile(manifest)
		if err != nil || string(got) != "existing" {
			t.Fatalf("manifest replaced after error: %q %v", got, err)
		}
	}
}

func TestDASHMeanRetainsCompactnessWhenModeImpliesWrongCount(t *testing.T) {
	durs := []int{6_000_000, 5_990_000, 6_000_000, 2}
	period := 17_990_002
	if !durationCandidateFits(durs[:3], 6_000_000) || compactDurationCovers(durs, 6_000_000, period) {
		t.Fatal("fixture must pass mode boundary checks but fail final count")
	}
	if got, ok := compactDurationForPeriod(durs, period); !ok || got != 5_996_667 {
		t.Fatalf("mean final-period candidate = %d,%v", got, ok)
	}
	mpd := writeTimingMPD(t, durs, nil, 17.990002)
	if strings.Contains(mpd, "<SegmentTimeline>") || !strings.Contains(mpd, `duration="5996667"`) {
		t.Fatalf("mean did not preserve compact MPD: %s", mpd)
	}
}
