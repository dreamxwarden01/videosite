package transcoder

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"videosite-worker/internal/config"
)

// RemuxToHLS remuxes (copies) a source file to HLS without re-encoding.
// logFile is the path for the FFmpeg log file. Pass "" to skip.
// duration is the source duration in seconds (from ffprobe), used for progress.
// loudnormFilter is the loudnorm audio filter string from BuildLoudnormFilter.
// When non-empty, video is stream-copied but audio is decoded and re-encoded to
// AAC with normalization applied (at audioBitrateKbps). Pass "" for a pure
// stream copy (original behavior — audioBitrateKbps is ignored).
// Returns progress and error channels matching the TranscodeToHLS contract.
func RemuxToHLS(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, audioBitrateKbps int, keyInfoFile string, logFile string, duration float64, loudnormFilter string) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	playlistPath := filepath.Join(outputDir, "playlist.m3u8")
	segmentPattern := filepath.Join(outputDir, "segment_%04d.ts")

	var args []string
	if loudnormFilter != "" {
		// Copy video, re-encode audio with normalization. -ac 2 ensures stereo.
		args = []string{
			"-i", sourcePath,
			"-c:v", "copy",
			"-c:a", "aac",
			"-b:a", fmt.Sprintf("%dk", audioBitrateKbps),
			"-ac", "2",
			"-af", loudnormFilter,
		}
	} else {
		args = []string{
			"-i", sourcePath,
			"-c", "copy",
		}
	}
	args = append(args,
		"-hls_time", fmt.Sprintf("%d", profile.SegmentDuration),
		"-hls_playlist_type", "vod",
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
	)
	if keyInfoFile != "" {
		args = append(args, "-hls_key_info_file", keyInfoFile)
	}
	args = append(args, playlistPath)

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// CMAFVariant describes one video rendition in a CMAF master (HLS) and
// MPD (DASH) manifest. The fields the two formats share live here;
// WriteMasterPlaylistCMAF and WriteDASHManifest consume the same slice.
//
// Codecs is the full RFC 6381 string pulled from the produced init.mp4 via
// ProbeCodecString — e.g. "avc1.64001F". The master.m3u8 CODECS attribute
// and DASH Representation codecs attribute both require this exact form
// (NOT just "avc1"). FrameRate is the integer fps (after any -r cap) used
// to emit the DASH frameRate attribute; HLS doesn't need it.
type CMAFVariant struct {
	Name             string
	Width            int
	Height           int
	VideoBitrateKbps int
	Codecs           string
	FrameRate        int
}

// WriteMasterPlaylistCMAF writes a CMAF-style master.m3u8 that references one
// fMP4 video playlist per profile plus a single audio rendition.
//
// Layout produced under outputDir:
//
//	master.m3u8
//	video/<variant.Name>/playlist.m3u8     ← referenced via STREAM-INF
//	audio/<audioName>/playlist.m3u8        ← referenced via EXT-X-MEDIA
//
// #EXT-X-VERSION:7 is required for fMP4 segments. QUERYPARAM="verify" is the
// Safari-native mechanism for passing the HMAC token (set by the watch page)
// into every child playlist request; the per-profile playlists already have
// {$verify} substitution in segment + EXT-X-MAP URIs (see RewritePlaylistHMAC).
func WriteMasterPlaylistCMAF(outputDir string, variants []CMAFVariant, audioName string, audioBitrateKbps int) error {
	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	sb.WriteString("#EXT-X-VERSION:7\n")
	sb.WriteString("#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n")

	// Single AAC-LC audio rendition — GROUP-ID="audio" referenced from each STREAM-INF.
	sb.WriteString(fmt.Sprintf(
		"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"%s\",DEFAULT=YES,AUTOSELECT=YES,CHANNELS=\"2\",URI=\"audio/%s/playlist.m3u8?verify={$verify}\"\n",
		audioName, audioName))

	for _, v := range variants {
		bandwidth := v.VideoBitrateKbps*1000 + audioBitrateKbps*1000
		codecs := v.Codecs
		if codecs == "" {
			codecs = "avc1.640028" // conservative fallback (High@4.0)
		}
		sb.WriteString(fmt.Sprintf(
			"#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d,CODECS=\"%s,mp4a.40.2\",AUDIO=\"audio\"\n",
			bandwidth, v.Width, v.Height, codecs))
		sb.WriteString(fmt.Sprintf("video/%s/playlist.m3u8?verify={$verify}\n", v.Name))
	}

	masterPath := filepath.Join(outputDir, "master.m3u8")
	return os.WriteFile(masterPath, []byte(sb.String()), 0644)
}

// WriteMasterPlaylist writes a master.m3u8 referencing profile playlists.
// HMAC query parameters are always included — they are harmlessly ignored
// when no HMAC rule is deployed, but required for Safari if HMAC is enabled
// (old videos without them would be inaccessible).
// audioBitrateKbps is the site-wide AAC bitrate (same value muxed into every
// per-profile playlist), used to compute BANDWIDTH per variant.
func WriteMasterPlaylist(outputDir string, profiles []FilteredProfile, audioBitrateKbps int) error {
	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	sb.WriteString("#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n")

	for _, p := range profiles {
		bandwidth := p.VideoBitrateKbps*1000 + audioBitrateKbps*1000
		sb.WriteString(fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n",
			bandwidth, p.Width, p.Height))
		sb.WriteString(fmt.Sprintf("%s/playlist.m3u8?verify={$verify}\n", p.Name))
	}

	masterPath := filepath.Join(outputDir, "master.m3u8")
	return os.WriteFile(masterPath, []byte(sb.String()), 0644)
}

// RewritePlaylistHMAC rewrites a per-profile playlist to include HMAC token variables.
//
// Handles three media-line forms:
//   - ".ts" segment URIs (legacy MPEG-TS)
//   - ".m4s" segment URIs (CMAF fMP4)
//   - #EXT-X-MAP:URI="init.mp4" init-segment line (CMAF fMP4 only)
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

		// CMAF: rewrite the init-segment pointer to carry ?verify too. ffmpeg
		// writes this as a bare relative path inside URI="…"; we only touch
		// the bits inside the quotes and leave any other attributes alone.
		if strings.HasPrefix(trimmed, "#EXT-X-MAP:") {
			if rewritten, ok := rewriteExtXMapURI(trimmed); ok {
				sb.WriteString(rewritten + "\n")
				continue
			}
		}

		if strings.HasSuffix(trimmed, ".ts") || strings.HasSuffix(trimmed, ".m4s") {
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

// buildBaseTranscodeArgs builds the common FFmpeg args for TranscodeToHLS.
// Platform-specific TranscodeToHLS implementations call this to avoid duplication.
//
// audioBitrateKbps is the site-wide AAC bitrate (the per-profile field was
// removed when audio became site-wide; for TS this still runs in-process with
// the video transcode).
func buildBaseTranscodeArgs(hwArgs []string, sourcePath, outputDir string, profile config.OutputProfile, audioBitrateKbps int, ffmpegEncoder, vfFilter, loudnormFilter, keyInfoFile string) []string {
	playlistPath := filepath.Join(outputDir, "playlist.m3u8")
	segmentPattern := filepath.Join(outputDir, "segment_%04d.ts")

	args := make([]string, 0, 30+len(hwArgs))
	args = append(args, hwArgs...)
	args = append(args,
		"-i", sourcePath,
		"-c:v", ffmpegEncoder,
		"-b:v", fmt.Sprintf("%dk", profile.VideoBitrateKbps),
		"-maxrate", fmt.Sprintf("%dk", int(float64(profile.VideoBitrateKbps)*1.2)),
		"-bufsize", fmt.Sprintf("%dk", profile.VideoBitrateKbps*2),
		"-vf", vfFilter,
		"-profile:v", profile.Profile,
		"-c:a", "aac",
		"-b:a", fmt.Sprintf("%dk", audioBitrateKbps),
		"-ac", "2",
	)
	if loudnormFilter != "" {
		args = append(args, "-af", loudnormFilter)
	}
	args = append(args,
		"-g", fmt.Sprintf("%d", profile.GOPSize),
		"-sc_threshold", "0",
		"-hls_time", fmt.Sprintf("%d", profile.SegmentDuration),
		"-hls_playlist_type", "vod",
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
	)
	if keyInfoFile != "" {
		args = append(args, "-hls_key_info_file", keyInfoFile)
	}
	args = append(args, playlistPath)

	return args
}

// insertAfter inserts extra args after a specific argument value in the args slice.
func insertAfter(args []string, after string, extra ...string) []string {
	for i, a := range args {
		if a == after {
			result := make([]string, 0, len(args)+len(extra))
			result = append(result, args[:i+1]...)
			result = append(result, extra...)
			result = append(result, args[i+1:]...)
			return result
		}
	}
	return args
}
