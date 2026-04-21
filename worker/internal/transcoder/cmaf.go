package transcoder

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// TranscodeVideoCMAF transcodes the video-only track of sourcePath into an fMP4
// HLS rendition at outputDir. Layout produced:
//
//	{outputDir}/init.mp4
//	{outputDir}/segment_0000.m4s
//	{outputDir}/segment_0001.m4s
//	…
//	{outputDir}/playlist.m3u8
//
// No audio is muxed — audio runs as a separate ffmpeg invocation
// (TranscodeAudioCMAF) so the two can run in parallel on separate goroutines.
// Encryption is never applied (CMAF relies on the R2 private-bucket + HMAC
// edge validation posture, not at-rest encryption — see plan doc).
//
// When srcFrameRate > profile.FpsLimit we append `-r fps_limit` to force
// frame-rate downsampling; the flag is a global output option that works on
// every HW path (NVENC/AMF/QSV/VT) and software.
//
// progressCh and errCh behave exactly like RunFFmpegWithProgress — callers
// drain progressCh until close and then read a single error from errCh.
func TranscodeVideoCMAF(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, encoder config.Encoder, duration float64, swDecode bool, logFile string, srcW, srcH int, srcFrameRate float64) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	ffmpegEncoder := hardware.FFmpegEncoderName[encoder.EncoderType]
	if ffmpegEncoder == "" {
		ffmpegEncoder = "libx264"
	}

	hwArgs, vfFilter := resolveHWArgs(encoder, swDecode, srcW, srcH, profile.Width, profile.Height)

	args := buildBaseVideoCMAFArgs(hwArgs, sourcePath, outputDir, profile, ffmpegEncoder, vfFilter)

	// Encoder-specific options (same injection pattern as TranscodeToHLS).
	args = applyEncoderOpts(args, encoder, ffmpegEncoder, profile)

	// FPS downsample: only applies when the source exceeds the profile's cap.
	// Placed before the output file so ffmpeg treats it as output-level.
	if profile.FpsLimit > 0 && srcFrameRate > float64(profile.FpsLimit)+0.01 {
		args = insertBeforeLast(args, "-r", fmt.Sprintf("%d", profile.FpsLimit))
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// RemuxVideoCMAF copies the source's video track into fMP4 HLS without
// re-encoding. Audio is dropped (-an); audio is always produced separately for
// CMAF. Remux is only chosen by the caller when FilterProfiles/ApplyBitrateCaps
// determined that resolution, codec, bitrate, and fps_limit all match —
// otherwise TranscodeVideoCMAF is used.
func RemuxVideoCMAF(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, duration float64, logFile string) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	// ffmpeg's HLS muxer locates the fMP4 init file via strrchr(playlist_url,
	// '/') — on Windows filepath.Join produces backslashes, the search finds
	// no '/', and init.mp4 gets written to the worker's CWD instead of the
	// profile dir. Normalizing to forward slashes here fixes that without
	// affecting macOS (where it's a no-op).
	playlistPath := filepath.ToSlash(filepath.Join(outputDir, "playlist.m3u8"))
	segmentPattern := filepath.ToSlash(filepath.Join(outputDir, "segment_%04d.m4s"))
	initName := "init.mp4"

	args := []string{
		"-i", sourcePath,
		"-map", "0:v:0",
		"-c:v", "copy",
		"-an",
		"-hls_time", fmt.Sprintf("%d", profile.SegmentDuration),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
		playlistPath,
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// TranscodeAudioCMAF produces a single AAC-LC fMP4 HLS audio rendition at
// outputDir. Layout:
//
//	{outputDir}/init.mp4
//	{outputDir}/segment_0000.m4s
//	{outputDir}/playlist.m3u8
//
// loudnormFilter is the filter string from a pass-1 loudnorm analysis (see
// slot.Job.analyzeLoudnessCMAF). Pass "" to encode without normalization —
// the caller decides whether analysis ran, so this function owns only the
// encode pass; start/end/measurement log lines live one level up alongside
// the TS path's equivalents.
//
// progressCb reports encode 0–100 regardless of whether norm is active; the
// caller is responsible for composing it with the analyze pass's own 0–100
// (typical mapping: analyze 0–100 → 0–50, encode 0–100 → 50–100 when norm
// on; encode 0–100 → 0–100 when off).
//
// All ffmpeg paths are forward-slash normalized so the HLS muxer's
// dirname-by-strrchr logic writes init.mp4 into outputDir on Windows (see
// RemuxVideoCMAF for the full backstory).
func TranscodeAudioCMAF(
	ctx context.Context,
	sourcePath, outputDir string,
	audioBitrateKbps, segmentDurationSec int,
	loudnormFilter string,
	duration float64,
	progressCb func(pct int),
	logFile string,
) error {
	os.MkdirAll(outputDir, 0755)

	playlistPath := filepath.ToSlash(filepath.Join(outputDir, "playlist.m3u8"))
	segmentPattern := filepath.ToSlash(filepath.Join(outputDir, "segment_%04d.m4s"))
	initName := "init.mp4"

	args := []string{
		"-i", sourcePath,
		"-vn",
		"-map", "0:a:0",
		"-c:a", "aac",
		"-b:a", fmt.Sprintf("%dk", audioBitrateKbps),
		"-ac", "2",
		"-ar", "48000",
	}
	if loudnormFilter != "" {
		args = append(args, "-af", loudnormFilter)
	}
	args = append(args,
		"-hls_time", fmt.Sprintf("%d", segmentDurationSec),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
		playlistPath,
	)

	progressCh, errCh := RunFFmpegWithProgress(ctx, duration, logFile, args...)
	for pct := range progressCh {
		if progressCb != nil {
			progressCb(pct)
		}
	}
	err := <-errCh
	if err != nil {
		return err
	}
	if progressCb != nil {
		progressCb(100)
	}
	return nil
}

// buildBaseVideoCMAFArgs assembles the shared ffmpeg args for a video-only
// CMAF transcode. Parallel to buildBaseTranscodeArgs (TS path) but:
//   - drops audio (-an) and audio-muxing flags
//   - switches to fMP4 segments (segment_%04d.m4s + init.mp4 via -hls_fmp4_init_filename)
//   - omits -hls_key_info_file (CMAF is never encrypted)
//
// All paths passed to ffmpeg use forward slashes — ffmpeg's HLS muxer locates
// the init file via strrchr(playlist_url, '/'), so Windows-native backslash
// paths send the init segment to the worker's CWD. See RemuxVideoCMAF.
func buildBaseVideoCMAFArgs(hwArgs []string, sourcePath, outputDir string, profile config.OutputProfile, ffmpegEncoder, vfFilter string) []string {
	playlistPath := filepath.ToSlash(filepath.Join(outputDir, "playlist.m3u8"))
	segmentPattern := filepath.ToSlash(filepath.Join(outputDir, "segment_%04d.m4s"))
	initName := "init.mp4"

	args := make([]string, 0, 30+len(hwArgs))
	args = append(args, hwArgs...)
	args = append(args,
		"-i", sourcePath,
		"-map", "0:v:0",
		"-c:v", ffmpegEncoder,
		"-b:v", fmt.Sprintf("%dk", profile.VideoBitrateKbps),
		"-maxrate", fmt.Sprintf("%dk", int(float64(profile.VideoBitrateKbps)*1.2)),
		"-bufsize", fmt.Sprintf("%dk", profile.VideoBitrateKbps*2),
		"-vf", vfFilter,
		"-profile:v", profile.Profile,
		"-an",
		"-g", fmt.Sprintf("%d", profile.GOPSize),
		"-sc_threshold", "0",
		"-hls_time", fmt.Sprintf("%d", profile.SegmentDuration),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
		playlistPath,
	)
	return args
}

// insertBeforeLast inserts extra args immediately before the last element of
// the args slice. Used to place output-level ffmpeg options (like -r) before
// the output filename, which is always at the end of the args we build.
func insertBeforeLast(args []string, extra ...string) []string {
	if len(args) == 0 {
		return append(args, extra...)
	}
	last := args[len(args)-1]
	args = args[:len(args)-1]
	args = append(args, extra...)
	args = append(args, last)
	return args
}
