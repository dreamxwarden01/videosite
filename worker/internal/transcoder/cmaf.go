package transcoder

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	audioStreamCount int,
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
	}

	// Route audio either as a simple `-map 0:a:0` single-track with optional
	// `-af loudnorm=...` (the original happy path, byte-identical for N=1),
	// or as a `-filter_complex` chain that amix-merges N ≥ 2 tracks and then
	// (optionally) applies loudnorm on the merged signal before it hits the
	// AAC encoder. buildAudioFilterChain centralises the branch so both
	// encode and analyze paths stay identical.
	filterComplex, mapTarget, useFilterComplex := buildAudioFilterChain(audioStreamCount, loudnormFilter)
	if useFilterComplex {
		args = append(args, "-filter_complex", filterComplex, "-map", mapTarget)
	} else {
		args = append(args, "-map", mapTarget)
		if loudnormFilter != "" {
			args = append(args, "-af", loudnormFilter)
		}
	}

	args = append(args,
		"-c:a", "aac",
		"-b:a", fmt.Sprintf("%dk", audioBitrateKbps),
		"-ac", "2",
		"-ar", "48000",
	)
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

// buildAudioFilterChain decides how audio should be routed through ffmpeg.
//
// Three distinct cases drive this:
//
//  1. streamCount ≤ 1 (single track, the overwhelming majority of sources):
//     emit nothing special. Caller uses `-map 0:a:0` and, if loudnorm is
//     desired, passes the filter via `-af`. This keeps the happy path
//     byte-identical to pre-change — no filter_complex, no amix overhead,
//     no new failure modes.
//
//  2. streamCount ≥ 2 without loudnorm: build an amix-only filter_complex
//     that sums every audio input and routes the mix label as the map
//     target. `normalize=0` is deliberate: the default `normalize=1` divides
//     every input's level by N, which pushes quiet screen-recording audio
//     to voice-track level — blowing out the voice after loudnorm applies
//     its global gain. With normalize=0 the mic stays mic-loud and the
//     screencast stays screencast-quiet, preserving the relative loudness
//     the user actually recorded.
//
//  3. streamCount ≥ 2 with loudnorm: same amix, then the loudnorm filter
//     runs on the merged signal (single chain, no intermediate file). Pass
//     1 analyzes the merged signal's R128 stats; pass 2 encodes with
//     linear=true gain. Chaining amix → loudnorm inside one filter_complex
//     is what makes "merge before normalize" automatic in the graph.
//
// Return values:
//   - filterComplexArg: the complete `-filter_complex` value (or "" when
//     useFilterComplex == false).
//   - mapTarget: either "0:a:0" (single-track) or "[mix]" (multi-track).
//   - useFilterComplex: whether the caller should pass
//     `-filter_complex <arg> -map <target>` or the simpler
//     `-map 0:a:0 [-af loudnorm=...]` form.
//
// The labels inside the filter graph are stable: inputs are [0:a:0],
// [0:a:1], … [0:a:N-1]; the final output is always [mix]. Callers rely on
// "[mix]" as a fixed sentinel.
func buildAudioFilterChain(streamCount int, loudnormFilter string) (filterComplexArg, mapTarget string, useFilterComplex bool) {
	if streamCount <= 1 {
		return "", "0:a:0", false
	}
	var inputs strings.Builder
	for i := 0; i < streamCount; i++ {
		fmt.Fprintf(&inputs, "[0:a:%d]", i)
	}
	chain := fmt.Sprintf("%samix=inputs=%d:normalize=0", inputs.String(), streamCount)
	if loudnormFilter != "" {
		chain += "," + loudnormFilter
	}
	chain += "[mix]"
	return chain, "[mix]", true
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
