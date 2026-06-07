package transcoder

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
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
// When srcFrameRate > profile.FpsLimit we append `-r fps_limit` to force
// frame-rate downsampling; the flag is a global output option that works on
// every HW path (NVENC/QSV/VT) and software.
//
// progressCh and errCh behave exactly like RunFFmpegWithProgress — callers
// drain progressCh until close and then read a single error from errCh.
func TranscodeVideo(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, encoder config.Encoder, duration float64, swDecode bool, logFile string, outW, outH int, srcFrameRate float64) (<-chan int, <-chan error) {
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

	// Effective output fps drives the keyint (-g) computation in
	// buildBaseVideoArgs. Sources slower than the cap pass through at source
	// rate; faster ones get capped via -r below.
	effectiveFps := srcFrameRate
	if profile.FpsLimit > 0 && srcFrameRate > float64(profile.FpsLimit)+0.01 {
		effectiveFps = float64(profile.FpsLimit)
	}

	args := buildBaseVideoArgs(hwArgs, sourcePath, outputDir, profile, ffmpegEncoder, vfFilter, effectiveFps)

	// Encoder-specific options.
	args = applyEncoderOpts(args, encoder, ffmpegEncoder, profile)

	// FPS downsample: only applies when the source exceeds the profile's cap.
	// Placed before the output file so ffmpeg treats it as output-level.
	if profile.FpsLimit > 0 && srcFrameRate > float64(profile.FpsLimit)+0.01 {
		args = insertBeforeLast(args, "-r", fmt.Sprintf("%d", profile.FpsLimit))
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// RemuxVideo copies the source's video track into fMP4 HLS without
// re-encoding. Audio is dropped (-an); audio is always produced separately.
// Remux is only chosen by the caller when FilterProfiles/ApplyBitrateCaps
// determined that resolution, codec, bitrate, and fps_limit all match —
// otherwise TranscodeVideo is used.
func RemuxVideo(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, duration float64, logFile string) (<-chan int, <-chan error) {
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
		// Pass -hls_time slightly under the true chosen_seg so the muxer always
		// cuts on the natural IDR rather than skipping past it. Without the
		// margin, %.3f rounds chosen_seg UP (e.g. true 7.807807s → "7.808") and
		// cumulative drift eventually places the threshold milliseconds past
		// the source's natural IDR — the muxer then waits for the NEXT IDR and
		// emits a segment one source-GOP longer than intended. 100ms is well
		// under the smallest realistic GOP (~250ms).
		"-hls_time", fmt.Sprintf("%.3f", hlsTimeArg(profile.SegmentDuration)),
		"-hls_playlist_type", "vod",
		"-hls_segment_type", "fmp4",
		"-hls_fmp4_init_filename", initName,
		"-hls_segment_filename", segmentPattern,
		"-hls_flags", "independent_segments",
		playlistPath,
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// hlsTimeArg returns the safe -hls_time value for the given chosen segment
// duration. We subtract a 1ms epsilon for two reasons:
//
//  1. Round-up protection: the muxer's "first IDR ≥ start + hls_time" lookup
//     skips the natural source IDR if hls_time's %.3f representation lands
//     fractionally *above* the true segment-end PTS (e.g., true 7.8078s
//     formatted as "7.808" loses the IDR at 7.8078s and waits for 9.760s).
//     1ms is enough to stay below source-grid PTS rounding.
//
//  2. Don't induce cumulative drift: ffmpeg's HLS muxer uses *cumulative*
//     thresholds (N × hls_time), so a large margin accumulates over N
//     segments. With 1ms × N segments, drift stays well under one source
//     GOP (~2s) even for multi-hour videos — large margins (e.g., 100ms)
//     produce a short segment every ~20 segments once cumulative drift
//     pushes the threshold before a natural IDR.
//
// chosenSegSec is expected to already be snapped to source-GOP multiples
// via slot/job.go computeGOPDecision when useSourceGOP is set.
func hlsTimeArg(chosenSegSec float64) float64 {
	const safetyMarginSec = 0.001
	t := chosenSegSec - safetyMarginSec
	if t < 0.5 {
		// Defensive: for absurdly small chosen_seg the margin would dominate.
		// Fall back to 99.9% of the value rather than going negative.
		t = chosenSegSec * 0.999
	}
	return t
}

// TranscodeAudio produces a single AAC-LC fMP4 HLS audio rendition at
// outputDir. Layout:
//
//	{outputDir}/init.mp4
//	{outputDir}/segment_0000.m4s
//	{outputDir}/playlist.m3u8
//
// loudnormFilter is the filter string from a pass-1 loudnorm analysis (see
// slot.Job.analyzeLoudness). Pass "" to encode without normalization — the
// caller decides whether analysis ran, so this function owns only the encode
// pass; start/end/measurement log lines live one level up.
//
// progressCb reports encode 0–100 regardless of whether norm is active; the
// caller is responsible for composing it with the analyze pass's own 0–100
// (typical mapping: analyze 0–100 → 0–50, encode 0–100 → 50–100 when norm
// on; encode 0–100 → 0–100 when off).
//
// All ffmpeg paths are forward-slash normalized so the HLS muxer's
// dirname-by-strrchr logic writes init.mp4 into outputDir on Windows (see
// RemuxVideo for the full backstory).
func TranscodeAudio(
	ctx context.Context,
	sourcePath, outputDir string,
	audioBitrateKbps int,
	segmentDurationSec float64,
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
	//
	// padForEnd=true makes the chain append `apad` so the audio stream is
	// padded with silence to match whatever duration the output is capped
	// to below via `-t`. This is the CMAF half of the source-audio-shorter-
	// than-video fix (DASH got its own fix earlier via per-rendition
	// SegmentTimeline; HLS needs the segment count to actually match video,
	// otherwise the player stalls at the end waiting for the missing last
	// audio segment). `-t <duration>` MUST be set below or apad will pump
	// silence forever — keep these two settings paired.
	filterComplex, mapTarget, useFilterComplex := buildAudioFilterChain(audioStreamCount, loudnormFilter, true)
	if useFilterComplex {
		args = append(args, "-filter_complex", filterComplex, "-map", mapTarget)
	} else {
		args = append(args, "-map", mapTarget)
		// Single-track path — compose `-af` value from the pieces this
		// branch owns: loudnorm (if any) then apad. The filter_complex
		// branch already inlines both into the graph; this branch has no
		// filter_complex so we place them on the -af value directly.
		afParts := []string{}
		if loudnormFilter != "" {
			afParts = append(afParts, loudnormFilter)
		}
		afParts = append(afParts, "apad")
		args = append(args, "-af", strings.Join(afParts, ","))
	}

	args = append(args,
		"-c:a", "aac",
		"-b:a", fmt.Sprintf("%dk", audioBitrateKbps),
		"-ac", "2",
		"-ar", "48000",
	)
	// Cap output to the video's exact duration. Paired with apad above: if
	// source audio is shorter than `duration`, apad extends it with silence
	// up to the cap; if source audio is longer, -t trims the tail. Either
	// way the produced audio playlist has segment count = ceil(duration /
	// segDur), which matches the video playlist and prevents the HLS
	// tail-stall (player waiting on a missing trailing audio segment).
	args = append(args, "-t", fmt.Sprintf("%.3f", duration))
	args = append(args,
		"-hls_time", fmt.Sprintf("%.3f", segmentDurationSec),
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

// buildBaseVideoArgs assembles the shared ffmpeg args for a video-only
// transcode. Output is fMP4 segments (segment_%04d.m4s + init.mp4 via
// -hls_fmp4_init_filename) with no audio (-an) and no encryption. Audio is
// always produced separately via TranscodeAudio.
//
// All paths passed to ffmpeg use forward slashes — ffmpeg's HLS muxer locates
// the init file via strrchr(playlist_url, '/'), so Windows-native backslash
// paths send the init segment to the worker's CWD. See RemuxVideo.
//
// effectiveFps is the output frame rate (capped by profile.FpsLimit). It feeds
// the keyint calculation so GOP stays at profile.GOPSeconds regardless of
// source fps.
func buildBaseVideoArgs(hwArgs []string, sourcePath, outputDir string, profile config.OutputProfile, ffmpegEncoder, vfFilter string, effectiveFps float64) []string {
	playlistPath := filepath.ToSlash(filepath.Join(outputDir, "playlist.m3u8"))
	segmentPattern := filepath.ToSlash(filepath.Join(outputDir, "segment_%04d.m4s"))
	initName := "init.mp4"

	// ceil so the first frame at-or-after GOPSeconds becomes the next IDR;
	// matches the time-based -force_key_frames expression below. At 23.976
	// fps + 2.0s target → 48 frames (2.002s real), within the per-job
	// tolerance carried in slot/job.go computeGOPDecision.
	keyint := int(math.Ceil(profile.GOPSeconds * effectiveFps))
	if keyint < 1 {
		keyint = 1
	}

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
		"-an",
		// -g is the ceiling (encoder won't go longer than this); -force_key_frames
		// pins the actual cadence in seconds so every rendition in the same job
		// cuts at identical time grid positions regardless of effective fps.
		// Scene-cut IDRs are explicitly NOT suppressed (no -sc_threshold 0) —
		// extras only add seek points without disturbing segmentation.
		//
		// The 1ms epsilon on -force_key_frames mirrors hlsTimeArg's
		// safety-margin logic. ffprobe quantizes source PTS to ms, so even
		// a snapped chosenGOPSec can round a few μs above the true rational
		// frame PTS; subtracting 1ms guarantees frame N (the natural source
		// IDR) lands at-or-above the threshold and the encoder fires there
		// rather than skipping to frame N+1 (which produces +1-frame GOPs
		// and cross-rendition misalignment).
		"-g", fmt.Sprintf("%d", keyint),
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%g)", profile.GOPSeconds-0.001),
		// See hlsTimeArg / RemuxVideo for the safety-margin rationale.
		"-hls_time", fmt.Sprintf("%.3f", hlsTimeArg(profile.SegmentDuration)),
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
//     emit nothing special. Caller uses `-map 0:a:0` and, if loudnorm or
//     apad is desired, passes the filter via `-af`. This keeps the happy
//     path byte-identical to pre-change — no filter_complex, no amix
//     overhead, no new failure modes.
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
// padForEnd controls whether `apad` is appended at the end of the chain
// (right before the `[mix]` label in the filter_complex path, or as an
// extra `-af` component in the simple path owned by the caller). apad
// appends infinite silence AFTER the source audio ends, so it is ONLY
// safe when the caller caps the output duration via `-t <duration>` at the
// output level. Never pass true in an analysis pass with no length cap;
// ffmpeg would then run forever pumping silence through loudnorm.
//
// For the loudnorm pass-1/pass-2 graph-identity invariant: apad inserts
// constant silence after the real samples, and pass-2 loudnorm applies a
// linear gain; silence × linear_gain is silence, so the measurement
// taken on the pass-1 graph (which sees the same real samples) still
// applies to the real portion of the pass-2 signal unchanged. The
// parameter is still threaded through explicitly so callers can only
// turn on padding when they own the length cap.
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
func buildAudioFilterChain(streamCount int, loudnormFilter string, padForEnd bool) (filterComplexArg, mapTarget string, useFilterComplex bool) {
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
	if padForEnd {
		chain += ",apad"
	}
	chain += "[mix]"
	return chain, "[mix]", true
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
