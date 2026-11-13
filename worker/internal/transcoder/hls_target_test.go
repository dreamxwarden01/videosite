package transcoder

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRewritePlaylistHMACNormalizesGeneratedShortZeroTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "playlist.m3u8")
	input := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:0\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:0.200000,\nsegment_0000.m4s\n#EXTINF:0.100001,\nsegment_0001.m4s\n#EXT-X-ENDLIST\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMediaPlaylist(path); err == nil {
		t.Fatal("shared parser accepted an unnormalized zero target")
	}
	if err := RewritePlaylistHMAC(path); err != nil {
		t.Fatal(err)
	}
	output, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"#EXT-X-TARGETDURATION:1\n", "#EXT-X-VERSION:11\n", "#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n", "#EXT-X-MAP:URI=\"init.mp4?verify={$verify}\"\n", "#EXTINF:0.200000,\nsegment_0000.m4s?verify={$verify}\n", "#EXTINF:0.100001,\nsegment_0001.m4s?verify={$verify}\n"} {
		if !strings.Contains(string(output), required) {
			t.Fatalf("missing normalized or preserved line %q", required)
		}
	}
	playlist, err := readMediaPlaylist(path)
	if err != nil {
		t.Fatal(err)
	}
	if playlist.TargetDurationTicks != 1000000 || len(playlist.Durations) != 2 || playlist.Durations[0] != 200000 || playlist.Durations[1] != 100001 {
		t.Fatalf("normalized playlist = %+v", playlist)
	}
}

func TestRewritePlaylistHMACRefusesInvalidZeroTargetWithoutWriting(t *testing.T) {
	for _, durationLines := range []string{"", "#EXTINF:0.500000,\nsegment_0000.m4s\n", "#EXTINF:6.000000,\nsegment_0000.m4s\n", "#EXTINF:0,\nsegment_0000.m4s\n", "#EXTINF:NaN,\nsegment_0000.m4s\n", "#EXTINF:0.2\nsegment_0000.m4s\n", "#EXTINF:-0.2,\nsegment_0000.m4s\n", "#EXTINF:0.2,\nsegment_0000.m4s\n#EXTINF:1.0,\nsegment_0001.m4s\n"} {
		t.Run(durationLines, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "playlist.m3u8")
			input := "#EXTM3U\n#EXT-X-TARGETDURATION:0\n" + durationLines + "#EXT-X-ENDLIST\n"
			if err := os.WriteFile(path, []byte(input), 0600); err != nil {
				t.Fatal(err)
			}
			if err := RewritePlaylistHMAC(path); err == nil {
				t.Fatal("accepted zero target with missing, long or malformed EXTINF")
			}
			output, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(output) != input {
				t.Fatal("failure changed existing playlist")
			}
		})
	}
}

func TestRewritePlaylistHMACPreservesPositiveTargetAndDurations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "playlist.m3u8")
	input := "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.000001,\nsegment_0000.m4s\n#EXTINF:0.200000,\nsegment_0001.m4s\n#EXT-X-ENDLIST\n"
	if err := os.WriteFile(path, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	if err := RewritePlaylistHMAC(path); err != nil {
		t.Fatal(err)
	}
	output, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"#EXT-X-TARGETDURATION:6\n", "#EXTINF:6.000001,\n", "#EXTINF:0.200000,\n", "segment_0000.m4s?verify={$verify}\n", "segment_0001.m4s?verify={$verify}\n"} {
		if !strings.Contains(string(output), required) {
			t.Fatalf("positive-target rewrite lost %q", required)
		}
	}
}
