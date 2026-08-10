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
// every HW path (NVENC/QSV/VT) and software. plan is built on the resulting
// effective rate, so its frame counts describe the frames the encoder actually
// emits rather than the source's.
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

// aacAlignedSegmentDuration returns the AAC-frame-aligned segment duration
// closest to the requested target, for the given output sample rate.
//
// AAC-LC frames are 1024 PCM samples wide, so the only durations the
// encoder can actually produce on a clean boundary are integer multiples
// of 1024/sampleRate seconds. For a 48000 Hz output that's ~21.333 ms per
// frame; at a 6.0 s target, the candidates are 281 frames (5.99467 s) or
// 282 frames (6.016 s). FFmpeg's HLS muxer, given a non-aligned
// -hls_time, picks whichever frame count is closer at each cut and
// alternates to keep cumulative drift near zero — producing the
// 281/282/281/282 oscillation that bit us. Feeding it an exactly-aligned
// target removes that ambiguity: every cut lands on the same frame
// count, every segment is identical, and the worker's uniform check
// reflects reality.
//
// Picks via round(), so the chosen alignment is whichever side of the
// target is closer. For a 6.0 s target at 48 kHz that is 281 frames
// (5.99467 s); at 44.1 kHz it is 172 frames (3.99383 s) for a 4.0 s target.
//
// Note on the Cloudflare comparison this once cited: their 44.1 kHz audio
// ships 173 frames (4.01705 s) against a 4.0 s target, and 173 is NOT the
// closer choice — 172 is (Δ 0.0062 s versus Δ 0.0171 s). They round up, we
// round to nearest. Either is drift-free because both land on a whole number
// of AAC frames, which is the property that actually matters; round() simply
// keeps the audio segment nearer the video segment.
//
// Defensive: if computation underflows to ≤ 0 (absurd inputs), fall
// through to the unmodified target so we don't hand FFmpeg garbage.
func aacAlignedSegmentDuration(targetSec float64, sampleRateHz int) float64 {
	if targetSec <= 0 || sampleRateHz <= 0 {
		return targetSec
	}
	const aacFrameSamples = 1024
	frames := math.Round(targetSec * float64(sampleRateHz) / float64(aacFrameSamples))
	if frames < 1 {
		frames = 1
	}
	return frames * float64(aacFrameSamples) / float64(sampleRateHz)
}

// defaultAudioSampleRate is used when the probe could not report the source's
// rate. It is only a fallback — the encoder otherwise keeps whatever the
// source has (see TranscodeAudio).
const defaultAudioSampleRate = 48000

// aacSampleRates are the rates AAC-LC can represent, per the MPEG-4 sampling
// frequency index.
var aacSampleRates = []int{8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000}

// aacSampleRate maps a source rate onto the closest rate AAC-LC can encode.
// An exact match (the overwhelming majority — sources are 44.1 or 48 kHz)
// passes through untouched, which is the whole point: no resample, no
// fragment-duration jitter.
func aacSampleRate(srcHz int) int {
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
// sourceSampleRateHz is the rate of the source's first audio track. The
// encoder keeps it rather than forcing a fixed rate, for the same reason the
// video side works in frames: a rate conversion is an avoidable source of
// per-segment error, and the AAC frame grid is only exact in the rate actually
// being encoded. Cloudflare Stream makes the same choice — their 44.1 kHz
// audio stays 44.1 kHz and publishes `duration="177152" timescale="44100"`,
// exactly 173 AAC frames.
//
// This does NOT make every output uniform, and it is worth being precise about
// why. Segment lengths also inherit whatever irregularity the source's own
// audio timeline carries: a lecture whose source packets alternate 1024 /
// 1036 / 1017 samples yields segments spread over a fraction of a millisecond
// no matter what rate we encode at, while sources with a clean constant-1024
// timeline collapse to a single length once the resample is gone. The spread
// in the bad case is ~0.4 ms against a 100 ms uniformity budget, so it costs
// nothing — but do not read a single-valued playlist as guaranteed.
//
// Rates AAC-LC cannot represent are snapped to the nearest one it can; 0
// (unknown) falls back to defaultAudioSampleRate.
func TranscodeAudio(
	ctx context.Context,
	sourcePath, outputDir string,
	audioBitrateKbps int,
	segmentDurationSec float64,
	sourceSampleRateHz int,
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

	sampleRate := aacSampleRate(sourceSampleRateHz)
	args = append(args,
		"-c:a", "aac",
		"-b:a", fmt.Sprintf("%dk", audioBitrateKbps),
		"-ac", "2",
		"-ar", fmt.Sprintf("%d", sampleRate),
	)
	// Cap output to the video's exact duration. Paired with apad above: if
	// source audio is shorter than `duration`, apad extends it with silence
	// up to the cap; if source audio is longer, -t trims the tail. Either
	// way the produced audio playlist has segment count = ceil(duration /
	// segDur), which matches the video playlist and prevents the HLS
	// tail-stall (player waiting on a missing trailing audio segment).
	args = append(args, "-t", fmt.Sprintf("%.3f", duration))
	// Snap -hls_time to an exact integer number of AAC-LC frames at the
	// output rate. Without this, FFmpeg's HLS muxer treats the requested
	// 6.0 s as a soft target and alternates between 281 and 282 frames
	// per segment (5.9947 s / 6.016 s) to average out near 6.0 s —
	// producing a playlist that LOOKS uniform within the worker's 100 ms
	// tolerance but actually has a ~1.9 s cumulative drift over a 90-min
	// job. That drift pushes `ceil(period / @duration)` one segment past
	// what the worker actually wrote, and Shaka 404s on the phantom tail.
	//
	// With an AAC-aligned target the cut point IS the target — every
	// segment is exactly the same frame count, the modal-equals-average
	// invariant holds, and DASH's SegmentTemplate@duration tells the
	// truth. The rate here must be the rate actually being encoded, which
	// is why it comes from sampleRate rather than a constant.
	alignedSegSec := aacAlignedSegmentDuration(segmentDurationSec, sampleRate)
	args = append(args,
		"-hls_time", fmt.Sprintf("%.6f", alignedSegSec),
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
