package transcoder

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestsPreserveActualCodecMetadata(t *testing.T) {
	dir := t.TempDir()
	variants := []Variant{
		{Name: "high51", Codecs: "avc1.640033", Width: 2560, Height: 1440, FrameRate: 60, VideoBitrateKbps: 15000},
		{Name: "main32", Codecs: "avc1.4D4020", Width: 1280, Height: 720, FrameRate: 60, VideoBitrateKbps: 6000},
		{Name: "inband", Codecs: "avc3.64002A", Width: 1920, Height: 1080, FrameRate: 60, VideoBitrateKbps: 10000},
	}
	for _, track := range []string{"video/high51", "video/main32", "video/inband", "audio/aac_192k"} {
		path := filepath.Join(dir, track)
		if err := os.MkdirAll(path, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "playlist.m3u8"), []byte("#EXTM3U\n#EXTINF:6.000000,\nsegment_0000.m4s\n#EXTINF:2.000000,\nsegment_0001.m4s\n#EXT-X-ENDLIST\n"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := WriteMasterPlaylist(dir, variants, "aac_192k", 192, true); err != nil {
		t.Fatal(err)
	}
	if err := WriteDASHManifest(dir, variants, "aac_192k", 192, 48000, 8, true); err != nil {
		t.Fatal(err)
	}
	hls, err := os.ReadFile(filepath.Join(dir, "master.m3u8"))
	if err != nil {
		t.Fatal(err)
	}
	mpd, err := os.ReadFile(filepath.Join(dir, "manifest.mpd"))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Period struct {
			Sets []struct {
				Reps []struct {
					ID     string `xml:"id,attr"`
					Codecs string `xml:"codecs,attr"`
				} `xml:"Representation"`
			} `xml:"AdaptationSet"`
		} `xml:"Period"`
	}
	if err := xml.Unmarshal(mpd, &document); err != nil {
		t.Fatal(err)
	}
	got := make(map[string]string)
	for _, set := range document.Period.Sets {
		for _, rep := range set.Reps {
			got[rep.ID] = rep.Codecs
		}
	}
	for _, variant := range variants {
		if got[variant.Name] != variant.Codecs {
			t.Fatalf("%s MPD codec = %q", variant.Name, got[variant.Name])
		}
		if !strings.Contains(string(hls), `CODECS="`+variant.Codecs+`,mp4a.40.2"`) {
			t.Fatalf("HLS lost %s codec metadata", variant.Name)
		}
	}
}

func TestMissingCodecMetadataDoesNotPublishOrReplaceManifests(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"master.m3u8", "manifest.mpd"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("existing artifact"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	for _, missing := range []string{"", " \t"} {
		variants := []Variant{{Name: "known", Codecs: "avc1.64002A"}, {Name: "unknown", Codecs: missing}}
		for _, err := range []error{WriteMasterPlaylist(dir, variants, "", 0, false), WriteDASHManifest(dir, variants, "", 0, 0, 8, false)} {
			if err == nil || !strings.Contains(err.Error(), "missing codec metadata") {
				t.Fatalf("expected codec error, got %v", err)
			}
		}
	}
	for _, name := range []string{"master.m3u8", "manifest.mpd"} {
		body, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != "existing artifact" {
			t.Fatalf("%s was replaced on failure", name)
		}
	}
}
