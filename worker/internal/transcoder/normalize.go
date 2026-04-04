package transcoder

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"sync"
)

// LoudnessStats holds the measured loudness values from a loudnorm pass-1 analysis.
type LoudnessStats struct {
	InputI      float64 // Integrated loudness (LUFS)
	InputLRA    float64 // Loudness range (LU)
	InputTP     float64 // True peak (dBFS)
	InputThresh float64 // Threshold (LUFS)
}

// loudnormJSON is the structure of the JSON block printed by ffmpeg's loudnorm filter.
type loudnormJSON struct {
	InputI      string `json:"input_i"`
	InputLRA    string `json:"input_lra"`
	InputTP     string `json:"input_tp"`
	InputThresh string `json:"input_thresh"`
}

// loudnormJSONRe matches the loudnorm JSON block in ffmpeg stderr output.
var loudnormJSONRe = regexp.MustCompile(`(?s)\{[^{}]*"input_i"[^{}]*\}`)

// AnalyzeLoudness runs a first-pass loudnorm analysis on the audio of sourcePath.
// It decodes the full audio stream, computes EBU R128 loudness statistics, and
// returns them for use in BuildLoudnormFilter.
//
// progressFn is called with an integer percentage (0-100) as FFmpeg processes
// the audio. Pass nil to skip progress reporting. The percentage is derived from
// out_time_ms / (duration * 1e6) and is for console display only — it does not
// affect the global job progress reported to the server.
//
// Returns (nil, nil) if the loudnorm JSON block is not found in ffmpeg output,
// which indicates no audio stream or an unsupported format — callers should
// skip normalization gracefully in this case.
func AnalyzeLoudness(ctx context.Context, sourcePath string, duration float64, progressFn func(pct int)) (*LoudnessStats, error) {
	// Pass 1: decode audio through loudnorm with print_format=json.
	// -vn skips video decode overhead. -f null - discards output.
	// loudnorm prints its JSON block to stderr before ffmpeg exits.
	//
	// When duration is known and progressFn is set, we add -progress pipe:1
	// -nostats so FFmpeg writes out_time_ms to stdout. We read stdout in a
	// goroutine and call progressFn; stderr is still captured for the JSON.
	args := []string{
		"-i", sourcePath,
		"-vn",
		"-af", "loudnorm=print_format=json",
		"-f", "null",
		"-",
	}

	if duration > 0 && progressFn != nil {
		stderr, err := runFFmpegCaptureStderrWithProgress(ctx, duration, progressFn, args...)
		if ctx.Err() != nil {
			return nil, fmt.Errorf("loudness analysis cancelled: %w", ctx.Err())
		}
		return parseLoudnessStats(stderr, err)
	}

	stderr, err := runFFmpegCaptureStderr(ctx, args...)
	if ctx.Err() != nil {
		return nil, fmt.Errorf("loudness analysis cancelled: %w", ctx.Err())
	}
	return parseLoudnessStats(stderr, err)
}

// runFFmpegCaptureStderrWithProgress runs ffmpeg with -progress pipe:1 -nostats,
// reads out_time_ms from stdout to drive progressFn, and captures stderr as a
// string (for loudnorm JSON). Both pipes are drained concurrently.
func runFFmpegCaptureStderrWithProgress(ctx context.Context, duration float64, progressFn func(int), args ...string) (string, error) {
	allArgs := append([]string{"-progress", "pipe:1", "-nostats"}, args...)
	cmd := exec.CommandContext(ctx, ffmpegPath, allArgs...)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("stdout pipe: %w", err)
	}
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		if isExecMissing(err) {
			return "", fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return "", fmt.Errorf("start ffmpeg: %w", err)
	}

	// Read stdout (progress stream) in a goroutine.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		lastPct := -1
		for {
			n, readErr := stdoutPipe.Read(buf)
			if n > 0 && duration > 0 {
				text := string(buf[:n])
				if ms := parseOutTimeMs(text); ms > 0 {
					pct := int(float64(ms) / (duration * 1_000_000) * 100)
					if pct > 100 {
						pct = 100
					}
					if pct != lastPct {
						progressFn(pct)
						lastPct = pct
					}
				}
			}
			if readErr != nil {
				break
			}
		}
	}()

	wg.Wait()
	runErr := cmd.Wait()

	if ctx.Err() != nil {
		return stderrBuf.String(), fmt.Errorf("ffmpeg cancelled: %w", ctx.Err())
	}
	if runErr != nil {
		if isExecMissing(runErr) {
			return stderrBuf.String(), fmt.Errorf("%w: %v", ErrFFmpegMissing, runErr)
		}
		return stderrBuf.String(), runErr
	}
	return stderrBuf.String(), nil
}

// parseLoudnessStats extracts LoudnessStats from ffmpeg stderr output.
// Shared by both AnalyzeLoudness paths (with and without progress).
func parseLoudnessStats(stderr string, ffmpegErr error) (*LoudnessStats, error) {
	// Extract the JSON block. loudnorm always prints it even on non-zero exit
	// (e.g. format warnings), so try parsing before treating err as fatal.
	match := loudnormJSONRe.FindString(stderr)
	if match == "" {
		if ffmpegErr != nil {
			return nil, fmt.Errorf("loudness analysis failed: %w", ffmpegErr)
		}
		// No JSON and no error: file has no audio stream.
		return nil, nil
	}

	var raw loudnormJSON
	if jsonErr := json.Unmarshal([]byte(match), &raw); jsonErr != nil {
		return nil, fmt.Errorf("parse loudnorm JSON: %w", jsonErr)
	}

	stats := &LoudnessStats{}
	var parseErr error
	if stats.InputI, parseErr = strconv.ParseFloat(raw.InputI, 64); parseErr != nil {
		return nil, fmt.Errorf("parse input_i %q: %w", raw.InputI, parseErr)
	}
	if stats.InputLRA, parseErr = strconv.ParseFloat(raw.InputLRA, 64); parseErr != nil {
		return nil, fmt.Errorf("parse input_lra %q: %w", raw.InputLRA, parseErr)
	}
	if stats.InputTP, parseErr = strconv.ParseFloat(raw.InputTP, 64); parseErr != nil {
		return nil, fmt.Errorf("parse input_tp %q: %w", raw.InputTP, parseErr)
	}
	if stats.InputThresh, parseErr = strconv.ParseFloat(raw.InputThresh, 64); parseErr != nil {
		return nil, fmt.Errorf("parse input_thresh %q: %w", raw.InputThresh, parseErr)
	}

	return stats, nil
}

// BuildLoudnormFilter constructs the FFmpeg audio filter string for pass-2 loudnorm
// normalization using the measured statistics from AnalyzeLoudness.
//
// Parameters:
//   - targetI:  integrated loudness target in LUFS (e.g. -16)
//   - peakTP:   true peak ceiling in dBFS (e.g. -1.5)
//   - maxGain:  maximum allowed upward gain in dB (e.g. 10)
//
// When the required gain (targetI − measuredI) exceeds maxGain, the effective
// target is capped so that no more than maxGain dB of boost is applied.
// Downward gain (already-loud sources) is never capped.
//
// linear=true instructs loudnorm to apply a single linear gain correction
// rather than dynamic compression when the measured values allow it — the
// result is artifact-free for classroom speech content.
func BuildLoudnormFilter(stats *LoudnessStats, targetI, peakTP, maxGain float64) string {
	effectiveTarget := targetI
	gainRequired := targetI - stats.InputI

	if gainRequired > maxGain {
		// Cap upward boost: output will be quieter than target, but we won't
		// amplify more than maxGain to avoid boosting the noise floor excessively.
		effectiveTarget = stats.InputI + maxGain
	}

	return fmt.Sprintf(
		"loudnorm=I=%.2f:TP=%.2f:LRA=7:measured_I=%.2f:measured_LRA=%.2f:measured_TP=%.2f:measured_thresh=%.2f:linear=true",
		effectiveTarget, peakTP,
		stats.InputI, stats.InputLRA, stats.InputTP, stats.InputThresh,
	)
}
