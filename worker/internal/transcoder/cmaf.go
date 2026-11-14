package transcoder

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// TranscodeVideo transcodes the video-only track of sourcePath into an fMP4
// HLS rendition at outputDir. Layout produced:
//
//	{outputDir}/init.mp4
//	{outputDir}/segment_0000.m4s
//	{outputDir}/segment_0001.m4s
//	…
//	{outputDir}/playlist.m3u8
//
// No audio is muxed — audio runs as a separate ffmpeg invocation
// (TranscodeAudio) so the two can run in parallel on separate goroutines.
// Output is never encrypted (we rely on the R2 private-bucket + HMAC edge
// validation posture, not at-rest encryption — see plan doc).
//
// Every re-encode explicitly realizes the plan's rational CFR grid. This keeps
// frame-count GOPs meaningful for VFR inputs as well as profile FPS caps.
//
// progressCh and errCh behave exactly like RunFFmpegWithProgress — callers
// drain progressCh until close and then read a single error from errCh.
func TranscodeVideo(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, plan SegmentPlan, encoder config.Encoder, duration float64, swDecode bool, logFile string, outW, outH int, srcFrameRate float64) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	ffmpegEncoder := hardware.FFmpegEncoderName[encoder.EncoderType]
	if ffmpegEncoder == "" {
		ffmpegEncoder = "libx264"
	}

	// outW/outH are the actual encoded dims (bounding-box fit, aspect-preserving,
	// even, never upscaled — computed by ActualOutputDims in the job runner).
	// They're handed straight to every filter so the encoder output matches what
	// the HLS / DASH manifests advertise.
	hwArgs, vfFilter := resolveHWArgs(encoder, swDecode, outW, outH)

	args := buildBaseVideoArgs(hwArgs, sourcePath, outputDir, profile, plan, ffmpegEncoder, vfFilter)

	// Encoder-specific options.
	args = applyEncoderOpts(args, encoder, ffmpegEncoder, profile)

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// RemuxVideo copies the source's video track into fMP4 HLS without
// re-encoding. Audio is dropped (-an); audio is always produced separately.
// Remux is only chosen by the caller when FilterProfiles/ApplyBitrateCaps
// determined that resolution, codec, bitrate, and fps_limit all match —
// otherwise TranscodeVideo is used.
func RemuxVideo(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, plan SegmentPlan, duration float64, logFile string) (<-chan int, <-chan error) {
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
		// Remux keeps a margin under the true segment length — unlike the
		// transcode path, which passes the exact value. See
		// remuxSafetyGOPDivisor for why a stream copy cannot be exact and why
		// the margin scales with the GOP instead of being a fixed 1 ms.
		"-hls_time", RemuxHLSTimeArg(plan.SegmentSeconds(), plan.GOPSeconds()),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
		playlistPath,
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// Legacy mapping fallback; the processing graph requires a known native rate.
const defaultAudioSampleRate = 48000

// aacSampleRates are the rates AAC-LC can represent, per the MPEG-4 sampling
// frequency index.
var aacSampleRates = []int{7350, 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000}

// AACSampleRate maps onto the nearest AAC-LC rate for legacy callers. The
// processing graph accepts only positive exact matches, preserving native rate.
func AACSampleRate(srcHz int) int {
	if srcHz <= 0 {
		return defaultAudioSampleRate
	}
	best, bestDist := defaultAudioSampleRate, -1
	for _, r := range aacSampleRates {
		d := r - srcHz
		if d < 0 {
			d = -d
		}
		if bestDist < 0 || d < bestDist {
			best, bestDist = r, d
		}
	}
	return best
}

// TranscodeAudio produces a stereo AAC-LC CMAF rendition. The bitrate is an
// configured bits/second encoder target; source-reported averages are not fed
// back. Native AAC may use less for simple content. It is not a hard
// per-packet or transport-rate ceiling.
//
// Source-rate preservation, common-epoch clock repair, mixing, padding and
// trimming are shared with the loudness analysis pass. Complete segments use
// an integer AAC sample plan; the final AAC packet/segment may be shorter.
func TranscodeAudio(
	ctx context.Context,
	sourcePath, outputDir string,
	audioBitrateBps int64,
	segmentDurationSec float64,
	sourceSampleRateHz int,
	loudnormFilter string,
	audioStreamCount int,
	duration float64,
	progressCb func(pct int),
	logFile string,
) error {
	if audioBitrateBps <= 0 {
		return fmt.Errorf("audio bitrate target must be positive")
	}
	graph, err := buildAudioFilterGraph(audioStreamCount, sourceSampleRateHz, loudnormFilter, duration)
	if err != nil {
		return err
	}
	plan, err := NewAudioSegmentPlan(segmentDurationSec, sourceSampleRateHz, duration)
	if err != nil {
		return err
	}
	durationArg, err := audioPresentationDurationArg(duration)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return err
	}
	playlistPath := filepath.ToSlash(filepath.Join(outputDir, "playlist.m3u8"))
	segmentPattern := filepath.ToSlash(filepath.Join(outputDir, "segment_%04d.m4s"))
	args := []string{
		"-i", sourcePath, "-vn", "-filter_complex", graph, "-map", "[mix]",
		"-c:a", "aac", "-b:a", fmt.Sprintf("%d", audioBitrateBps),
		"-ac", "2", "-ar", fmt.Sprintf("%d", sourceSampleRateHz),
		"-t", durationArg,
		"-hls_time", plan.TargetArgument(), "-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
		"-hls_segment_filename", segmentPattern, "-hls_flags", "independent_segments", playlistPath,
	}
	progressCh, errCh := RunFFmpegWithProgress(ctx, duration, logFile, args...)
	for pct := range progressCh {
		if progressCb != nil {
			progressCb(pct)
		}
	}
	if err := <-errCh; err != nil {
		return err
	}
	if progressCb != nil {
		progressCb(100)
	}
	return nil
}

// buildBaseVideoArgs assembles the shared ffmpeg args for a video-only
// transcode. Output is fMP4 segments (segment_%04d.m4s + init.mp4 via
// -hls_fmp4_init_filename) with no audio (-an) and no encryption. Audio is
// always produced separately via TranscodeAudio.
//
// All paths passed to ffmpeg use forward slashes — ffmpeg's HLS muxer locates
// the init file via strrchr(playlist_url, '/'), so Windows-native backslash
// paths send the init segment to the worker's CWD. See RemuxVideo.
//
// plan carries the resolved frame counts for this rendition (already built on
// the effective output fps, i.e. after any profile.FpsLimit cap). Both the
// keyint and the segment length come from it, so the two cannot disagree.
func buildBaseVideoArgs(hwArgs []string, sourcePath, outputDir string, profile config.OutputProfile, plan SegmentPlan, ffmpegEncoder, vfFilter string) []string {
	playlistPath := filepath.ToSlash(filepath.Join(outputDir, "playlist.m3u8"))
	segmentPattern := filepath.ToSlash(filepath.Join(outputDir, "segment_%04d.m4s"))
	initName := "init.mp4"

	args := make([]string, 0, 32+len(hwArgs))
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
		"-r", fmt.Sprintf("%d/%d", plan.FPSNum, plan.FPSDen),
		"-fps_mode", "cfr",
		"-an",
		// -g and -force_key_frames state the same frame count two ways: -g is
		// the encoder's own GOP ceiling, the expression pins each IDR to a
		// frame index. Both are integers off plan.GOPFrames, so there is no
		// float to disagree about.
		//
		// Scene-cut IDRs are explicitly NOT suppressed (no -sc_threshold 0) —
		// extras only add seek points. They cannot move a segment boundary,
		// because the boundary is always the forced IDR that sits exactly on
		// the muxer's threshold.
		//
		// NOTE: on NVENC and QSV this expression is inert unless the encoder's
		// forced-IDR flag is also set — both emit plain (non-IDR) I-frames for
		// a forced keyframe by default, and a non-IDR I-frame carries no
		// AV_PKT_FLAG_KEY, so the HLS muxer cannot split there. applyEncoderOpts
		// sets that flag; the two must stay together.
		"-g", fmt.Sprintf("%d", plan.GOPFrames),
		"-force_key_frames", plan.KeyframeExpr(),
		// Exact, no safety margin — see SegmentPlan.HLSTimeArg.
		"-hls_time", plan.HLSTimeArg(),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
		playlistPath,
	)
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
