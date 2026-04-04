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
// AAC with normalization applied. Pass "" for a pure stream copy (original behavior).
// Returns progress and error channels matching the TranscodeToHLS contract.
func RemuxToHLS(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, keyInfoFile string, logFile string, duration float64, loudnormFilter string) (<-chan int, <-chan error) {
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
			"-b:a", fmt.Sprintf("%dk", profile.AudioBitrateKbps),
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

// WriteMasterPlaylist writes a master.m3u8 referencing profile playlists.
// HMAC query parameters are always included — they are harmlessly ignored
// when no HMAC rule is deployed, but required for Safari if HMAC is enabled
// (old videos without them would be inaccessible).
func WriteMasterPlaylist(outputDir string, profiles []FilteredProfile) error {
	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	sb.WriteString("#EXT-X-DEFINE:QUERYPARAM=\"verify\"\n")

	for _, p := range profiles {
		bandwidth := p.VideoBitrateKbps*1000 + p.AudioBitrateKbps*1000
		sb.WriteString(fmt.Sprintf("#EXT-X-STREAM-INF:BANDWIDTH=%d,RESOLUTION=%dx%d\n",
			bandwidth, p.Width, p.Height))
		sb.WriteString(fmt.Sprintf("%s/playlist.m3u8?verify={$verify}\n", p.Name))
	}

	masterPath := filepath.Join(outputDir, "master.m3u8")
	return os.WriteFile(masterPath, []byte(sb.String()), 0644)
}

// RewritePlaylistHMAC rewrites a per-profile playlist to include HMAC token variables.
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

		if strings.HasSuffix(trimmed, ".ts") {
			sb.WriteString(trimmed + "?verify={$verify}\n")
			continue
		}

		if trimmed != "" || line != "" {
			sb.WriteString(line + "\n")
		}
	}

	return os.WriteFile(playlistPath, []byte(strings.TrimRight(sb.String(), "\n")+"\n"), 0644)
}

// buildBaseTranscodeArgs builds the common FFmpeg args for TranscodeToHLS.
// Platform-specific TranscodeToHLS implementations call this to avoid duplication.
func buildBaseTranscodeArgs(hwArgs []string, sourcePath, outputDir string, profile config.OutputProfile, ffmpegEncoder, vfFilter, loudnormFilter, keyInfoFile string) []string {
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
		"-b:a", fmt.Sprintf("%dk", profile.AudioBitrateKbps),
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
