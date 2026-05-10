package transcoder

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Variant describes one video rendition in the master.m3u8 (HLS) and
// manifest.mpd (DASH). The fields the two formats share live here;
// WriteMasterPlaylist and WriteDASHManifest consume the same slice.
//
// Codecs is the full RFC 6381 string pulled from the produced init.mp4 via
// ProbeCodecString — e.g. "avc1.64001F". The master.m3u8 CODECS attribute
// and DASH Representation codecs attribute both require this exact form
// (NOT just "avc1"). FrameRate is the integer fps (after any -r cap) used
// to emit the DASH frameRate attribute; HLS doesn't need it.
type Variant struct {
	Name             string
	Width            int
	Height           int
	VideoBitrateKbps int
	Codecs           string
	FrameRate        int
}

// WriteMasterPlaylist writes a master.m3u8 that references one fMP4 video
// playlist per profile plus a single audio rendition (when the job has
// audio).
//
// Layout produced under outputDir:
//
//	master.m3u8
//	video/<variant.Name>/playlist.m3u8     ← referenced via STREAM-INF
//	audio/<audioName>/playlist.m3u8        ← referenced via EXT-X-MEDIA  (hasAudio only)
//
// #EXT-X-VERSION:7 is required for fMP4 segments. QUERYPARAM="verify" is the
// Safari-native mechanism for passing the HMAC token (set by the watch page)
// into every child playlist request; the per-profile playlists already have
// {$verify} substitution in segment + EXT-X-MAP URIs (see RewritePlaylistHMAC).
//
// hasAudio toggles three related pieces of the playlist in lockstep so they
// never drift out of sync:
//   - the `#EXT-X-MEDIA:TYPE=AUDIO` rendition line (emitted iff true)
//   - the `AUDIO="audio"` attribute on each `#EXT-X-STREAM-INF` (emitted iff true)
//   - the `,mp4a.40.2` suffix inside each STREAM-INF's `CODECS` attribute
//
// A stream-inf that declares `AUDIO="audio"` without a matching `#EXT-X-MEDIA`
// line, or that lists an audio codec without a media rendition to play it,
// makes Safari reject the master with "invalid HLS" and Shaka log
// CONTENT_UNSUPPORTED_BY_BROWSER. All three must be gated together.
func WriteMasterPlaylist(outputDir string, variants []Variant, audioName string, audioBitrateKbps int, hasAudio bool) error {
	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	sb.WriteString("#EXT-X-VERSION:7\n")
	sb.WriteString("#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n")

	if hasAudio {
		// Single AAC-LC audio rendition — GROUP-ID="audio" referenced from each STREAM-INF.
		sb.WriteString(fmt.Sprintf(
			"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"%s\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"2\",URI=\"audio/%s/playlist.m3u8?verify={$verify}\"\n",
			audioName, audioName))
	}

	for _, v := range variants {
		bandwidth := v.VideoBitrateKbps * 1000
		if hasAudio {
			bandwidth += audioBitrateKbps * 1000
		}
		codecs := v.Codecs
		if codecs == "" {
			codecs = "avc1.640028" // conservative fallback (High@4.0)
		}
		if hasAudio {
			sb.WriteString(fmt.Sprintf(
				"#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s,mp4a.40.2\",AUDIO=\"audio\"\n",
				bandwidth, v.Width, v.Height, codecs))
		} else {
			sb.WriteString(fmt.Sprintf(
				"#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s\"\n",
				bandwidth, v.Width, v.Height, codecs))
		}
		sb.WriteString(fmt.Sprintf("video/%s/playlist.m3u8?verify={$verify}\n", v.Name))
	}

	masterPath := filepath.Join(outputDir, "master.m3u8")
	return os.WriteFile(masterPath, []byte(sb.String()), 0644)
}

// RewritePlaylistHMAC rewrites a per-profile playlist to include HMAC token variables.
//
// Handles two media-line forms:
//   - ".m4s" segment URIs (CMAF fMP4)
//   - #EXT-X-MAP:URI="init.mp4" init-segment line (fMP4 init segment)
//
// Each gets `?verify={$verify}` appended, so Safari's native HLS stack can
// substitute the real token at playback time via the #EXT-X-DEFINE QUERYPARAM
// declaration injected near the top of the playlist.
func RewritePlaylistHMAC(playlistPath string) error {
	data, err := os.ReadFile(playlistPath)
	if err != nil {
		return fmt.Errorf("read playlist: %w", err)
	}

	lines := strings.Split(string(data), "\n")
	var sb strings.Builder

	wroteVersion := false
	wroteDefine := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "#EXT-X-VERSION:") {
			sb.WriteString("#EXT-X-VERSION:11\n")
			wroteVersion = true
			if !wroteDefine {
				sb.WriteString("#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n")
				wroteDefine = true
			}
			continue
		}

		if strings.HasPrefix(trimmed, "#EXT-X-TARGETDURATION:") && !wroteDefine {
			if !wroteVersion {
				sb.WriteString("#EXT-X-VERSION:11\n")
				wroteVersion = true
			}
			sb.WriteString("#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n")
			wroteDefine = true
		}

		// Rewrite the init-segment pointer to carry ?verify too. ffmpeg
		// writes this as a bare relative path inside URI="…"; we only touch
		// the bits inside the quotes and leave any other attributes alone.
		if strings.HasPrefix(trimmed, "#EXT-X-MAP:") {
			if rewritten, ok := rewriteExtXMapURI(trimmed); ok {
				sb.WriteString(rewritten + "\n")
				continue
			}
		}

		if strings.HasSuffix(trimmed, ".m4s") {
			sb.WriteString(trimmed + "?verify={$verify}\n")
			continue
		}

		if trimmed != "" || line != "" {
			sb.WriteString(line + "\n")
		}
	}

	return os.WriteFile(playlistPath, []byte(strings.TrimRight(sb.String(), "\n")+"\n"), 0644)
}

// rewriteExtXMapURI takes an `#EXT-X-MAP:URI="...",...` line and returns the
// same line with `?verify={$verify}` appended to the URI value. Returns
// ok=false if the URI attribute is missing or already has a query string we
// shouldn't touch.
func rewriteExtXMapURI(line string) (string, bool) {
	key := `URI="`
	start := strings.Index(line, key)
	if start < 0 {
		return line, false
	}
	uriStart := start + len(key)
	end := strings.Index(line[uriStart:], `"`)
	if end < 0 {
		return line, false
	}
	uri := line[uriStart : uriStart+end]
	// Only rewrite if there's no existing query string — ffmpeg writes bare
	// relative paths here, so this is the common case.
	if strings.Contains(uri, "?") {
		return line, false
	}
	newURI := uri + "?verify={$verify}"
	return line[:uriStart] + newURI + line[uriStart+end:], true
}
