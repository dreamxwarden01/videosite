package transcoder

import (
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"videosite-worker/internal/config"
)

func dimensionTestInit(t *testing.T, path string, width, height int) {
	t.Helper()
	visual := make([]byte, 78)
	binary.BigEndian.PutUint16(visual[24:26], uint16(width))
	binary.BigEndian.PutUint16(visual[26:28], uint16(height))
	entry := codecTestBox("avc1", visual, codecTestBox("avcC", codecTestConfig(77, 64, 32)))
	data := codecTestBox("moov", codecTestTrack("vide", entry, 1))
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func assertDimensionManifests(t *testing.T, dir string, v Variant, audio bool, duration float64, width, height int) {
	t.Helper()
	if err := WriteMasterPlaylist(dir, []Variant{v}, "aac", 192, audio); err != nil {
		t.Fatal(err)
	}
	if err := WriteDASHManifest(dir, []Variant{v}, "aac", 192, 48000, duration, audio); err != nil {
		t.Fatal(err)
	}
	master, err := os.ReadFile(filepath.Join(dir, "master.m3u8"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(master), fmt.Sprintf("RESOLUTION=%dx%d,", width, height)) {
		t.Fatalf("HLS dimensions do not match output: %s", master)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.mpd"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Period struct {
			Sets []struct {
				Reps []struct {
					ID     string `xml:"id,attr"`
					Width  int    `xml:"width,attr"`
					Height int    `xml:"height,attr"`
				} `xml:"Representation"`
			} `xml:"AdaptationSet"`
		} `xml:"Period"`
	}
	if err := xml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	matches := 0
	for _, set := range doc.Period.Sets {
		for _, rep := range set.Reps {
			if rep.ID == v.Name {
				matches++
				if rep.Width != width || rep.Height != height {
					t.Fatalf("DASH dimensions = %dx%d; output = %dx%d", rep.Width, rep.Height, width, height)
				}
			}
		}
	}
	if matches != 1 {
		t.Fatalf("found %d video representations", matches)
	}
}

func TestManifestsUseCompletedVideoDimensions(t *testing.T) {
	for _, tc := range []struct {
		name          string
		width, height int
		remux         bool
	}{
		{"remux722", 1280, 722, true},
		{"remuxFallback", 1276, 720, true},
		{"wideTranscode", 1280, 564, false},
		{"wideLowerTranscode", 854, 376, false},
	} {
		for _, audio := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/audio_%v", tc.name, audio), func(t *testing.T) {
				dir := t.TempDir()
				measuredManifestTrack(t, dir, "video/720p", []int{1000, 2000})
				if audio {
					measuredManifestTrack(t, dir, "audio/aac", []int{300, 400})
				}
				init := filepath.Join(dir, "video", "720p", "init.mp4")
				dimensionTestInit(t, init, tc.width, tc.height)
				// Neither the configured box, predicted scale nor stale remux flag is
				// authoritative after the actual output has been produced.
				profile := FilteredProfile{OutputProfile: config.OutputProfile{Name: "720p", Width: 1280, Height: 720, VideoBitrateKbps: 6000}, OutW: 640, OutH: 360, CanRemux: tc.remux, Plan: NewSegmentPlan(30, 1, 2, 6)}
				v, err := VariantFromInit(profile, init)
				if err != nil {
					t.Fatal(err)
				}
				if v.Width != tc.width || v.Height != tc.height || v.Codecs != "avc1.4D4020" {
					t.Fatalf("metadata from output lost: %+v", v)
				}
				if v.Name != profile.Name || v.VideoBitrateKbps != 6000 || v.FrameRateNum != 30 || v.FrameRateDen != 1 {
					t.Fatalf("unrelated profile metadata changed: %+v", v)
				}
				assertDimensionManifests(t, dir, v, audio, 12, tc.width, tc.height)
			})
		}
	}
}

func TestMissingOutputDimensionsCannotFallBackToPlan(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "init.mp4")
	profile := FilteredProfile{OutputProfile: config.OutputProfile{Name: "720p", Width: 1280, Height: 720}, OutW: 1276, OutH: 720, CanRemux: true}
	for _, dims := range [][2]int{{0, 722}, {1280, 0}} {
		dimensionTestInit(t, path, dims[0], dims[1])
		if v, err := VariantFromInit(profile, path); err == nil || v != (Variant{}) {
			t.Fatalf("invalid dimensions substituted with prediction: %+v/%v", v, err)
		}
	}
	if v, err := VariantFromInit(profile, filepath.Join(dir, "missing.mp4")); err == nil || v != (Variant{}) {
		t.Fatalf("missing output accepted: %+v/%v", v, err)
	}
}
