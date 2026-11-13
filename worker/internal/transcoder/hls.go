package transcoder

import (
	"fmt"
	"math"
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
// (NOT just "avc1"). Rational frame-rate fields describe the output grid.
// VideoBitrateKbps remains an encoding target; manifests measure their rates.
type Variant struct {
	Name             string
	Width            int
	Height           int
	VideoBitrateKbps int
	Codecs           string
	FrameRate        int // legacy whole-number input; rational fields take precedence
	FrameRateNum     int
	FrameRateDen     int
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
	if err := validateVariantCodecs(variants); err != nil {
		return err
	}
	var audioRates RenditionBandwidth
	if hasAudio {
		var err error
		audioRates, err = MeasureRenditionBandwidth(filepath.Join(outputDir, "audio", audioName, "playlist.m3u8"), dashMinBufferTimeSeconds)
		if err != nil {
			return fmt.Errorf("measure audio bandwidth: %w", err)
		}
	}
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
		rates, err := MeasureRenditionBandwidth(filepath.Join(outputDir, "video", v.Name, "playlist.m3u8"), dashMinBufferTimeSeconds)
		if err != nil {
			return fmt.Errorf("measure video bandwidth %s: %w", v.Name, err)
		}
		if rates.Peak > math.MaxInt64-audioRates.Peak || rates.Average > math.MaxInt64-audioRates.Average {
			return fmt.Errorf("combined bandwidth overflow")
		}
		bandwidth, average := rates.Peak+audioRates.Peak, rates.Average+audioRates.Average
		codecs := v.Codecs
		if hasAudio {
			sb.WriteString(fmt.Sprintf(
				"#EXT-X-STREAM-INF:BANDWIDTH=%d,AVERAGE-BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s,mp4a.40.2\",AUDIO=\"audio\"\n",
				bandwidth, average, v.Width, v.Height, codecs))
		} else {
			sb.WriteString(fmt.Sprintf(
				"#EXT-X-STREAM-INF:BANDWIDTH=%d,AVERAGE-BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s\"\n",
				bandwidth, average, v.Width, v.Height, codecs))
		}
		sb.WriteString(fmt.Sprintf("video/%s/playlist.m3u8?verify={$verify}\n", v.Name))
	}

	masterPath := filepath.Join(outputDir, "master.m3u8")
	return os.WriteFile(masterPath, []byte(sb.String()), 0644)
}

func validateVariantCodecs(variants []Variant) error {
	for _, v := range variants {
		if strings.TrimSpace(v.Codecs) == "" {
			return fmt.Errorf("missing codec metadata for variant %q", v.Name)
		}
	}
	return nil
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
	// FFmpeg can round a sub-half-second file's TARGETDURATION down to zero.
	// Our finalized playlists require a positive target; normalize this edge case only
	// when every EXTINF is positive and also rounds to zero. Keep the shared
	// parser strict so arbitrary zero targets are never accepted by our pipeline.
	normalizeZeroTarget := false
	for _, line := range lines {
		if strings.TrimSpace(line) == "#EXT-X-TARGETDURATION:0" {
			normalizeZeroTarget = true
		}
	}
	if normalizeZeroTarget {
		segments := 0
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "#EXTINF:") {
				continue
			}
			value, _, hasSeparator := strings.Cut(strings.TrimPrefix(trimmed, "#EXTINF:"), ",")
			ticks, durationErr := decimalDurationTicks(value)
			if !hasSeparator || durationErr != nil || ticks >= 500000 {
				return fmt.Errorf("cannot normalize zero HLS target with invalid or non-short segment duration")
			}
			segments++
		}
		if segments == 0 {
			return fmt.Errorf("cannot normalize zero HLS target without media durations")
		}
	}
	var sb strings.Builder

	wroteVersion := false
	wroteDefine := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if normalizeZeroTarget && trimmed == "#EXT-X-TARGETDURATION:0" {
			line, trimmed = "#EXT-X-TARGETDURATION:1", "#EXT-X-TARGETDURATION:1"
		}

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
