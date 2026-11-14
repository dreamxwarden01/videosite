package transcoder

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requireQueryParamVersion11(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	playlist := string(body)
	if !strings.HasPrefix(playlist, "#EXTM3U\n#EXT-X-VERSION:11\n#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n") {
		t.Fatalf("QUERYPARAM playlist must declare version 11: %s", playlist)
	}
	if strings.Count(playlist, "#EXT-X-VERSION:") != 1 || strings.Count(playlist, "#EXT-X-DEFINE:") != 1 {
		t.Fatalf("duplicate version or variable declaration: %s", playlist)
	}
	return playlist
}

func TestMasterPlaylistQueryParamRequiresVersion11(t *testing.T) {
	for _, audio := range []bool{false, true} {
		t.Run(fmt.Sprintf("audio_%v", audio), func(t *testing.T) {
			dir := t.TempDir()
			measuredManifestTrack(t, dir, "video/test", []int{6000})
			if audio {
				measuredManifestTrack(t, dir, "audio/aac", []int{750})
			}
			variant := Variant{Name: "test", Codecs: "avc1.64001F", Width: 1280, Height: 720}
			if err := WriteMasterPlaylist(dir, []Variant{variant}, "aac", 192, audio); err != nil {
				t.Fatal(err)
			}
			playlist := requireQueryParamVersion11(t, filepath.Join(dir, "master.m3u8"))
			if !strings.Contains(playlist, "video/test/playlist.m3u8?verify={$verify}\n") {
				t.Fatal("master lost video token substitution")
			}
			if audio && !strings.Contains(playlist, `URI="audio/aac/playlist.m3u8?verify={$verify}"`) {
				t.Fatal("master lost audio token substitution")
			}
		})
	}
}

func TestRewrittenMediaPlaylistQueryParamRequiresVersion11(t *testing.T) {
	for _, version := range []string{"", "#EXT-X-VERSION:7\n"} {
		t.Run(fmt.Sprintf("version_%q", version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "playlist.m3u8")
			input := "#EXTM3U\n" + version + "#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.000000,\nsegment_0000.m4s\n#EXT-X-ENDLIST\n"
			if err := os.WriteFile(path, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			if err := RewritePlaylistHMAC(path); err != nil {
				t.Fatal(err)
			}
			playlist := requireQueryParamVersion11(t, path)
			for _, uri := range []string{`URI="init.mp4?verify={$verify}"`, "segment_0000.m4s?verify={$verify}\n"} {
				if !strings.Contains(playlist, uri) {
					t.Fatalf("media lost token substitution %q", uri)
				}
			}
		})
	}
}
