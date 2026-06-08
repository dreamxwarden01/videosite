package transcoder

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
)

// ExtractPoster picks a "representative" frame from the source video and
// writes it as a JPEG at outPath. The frame selection uses ffmpeg's built-in
// `thumbnail` filter (histogram-based scoring against a sliding mean), seeded
// at a random offset within 5%–20% of the source duration so we skip title
// cards / slates but stay well before any visual reveal.
//
// Frame selection works as follows:
//   - Seek to start = duration * U(0.05, 0.20). Keyframe-accurate, ~instant.
//   - Read the next 60 decoded frames (~2 s at 30fps).
//   - `thumbnail=60` scores each by histogram-vs-running-mean and emits the
//     "most representative" one. This naturally skips black frames, fades,
//     and uniform-color frames without us having to enumerate candidates.
//   - Scale to max 640w preserving aspect (object-fit handles the rest in CSS).
//
// Output: ~30–60 KB JPEG at -q:v 2 (high quality, small).
//
// duration must be > 0; callers should fall back gracefully if probe didn't
// produce one. Best-effort: errors here should not fail the job, just log.
func ExtractPoster(ctx context.Context, sourcePath, outPath string, duration float64) error {
	if duration <= 0 {
		return fmt.Errorf("ExtractPoster: invalid duration %g", duration)
	}

	// Random seek in 5%–20% of the duration. Math/rand is fine here — we
	// just want variety across re-runs, not cryptographic unpredictability.
	seekFraction := 0.05 + rand.Float64()*0.15
	seekSeconds := duration * seekFraction

	args := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-ss", fmt.Sprintf("%.3f", seekSeconds),
		"-i", sourcePath,
		"-frames:v", "1",
		// thumbnail=60: analyze the next 60 frames after seek, emit the one
		// with the highest histogram dissimilarity to the running mean.
		// scale=640:-2:flags=lanczos: preserve aspect, ensure even height
		// (-2 rounds to a multiple of 2), use lanczos for crisp downscale.
		// force_original_aspect_ratio=decrease: never upscale; sources
		// smaller than 640w stay at native size.
		"-vf", "thumbnail=60,scale=640:-2:force_original_aspect_ratio=decrease:flags=lanczos",
		"-q:v", "2",
		// -update 1 silences the deprecation warning for single-image output.
		"-update", "1",
		"-y",
		outPath,
	}

	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if isExecMissing(err) {
			return fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return fmt.Errorf("ffmpeg poster extract: %w (output: %s)", err, string(out))
	}

	// Confirm the file was actually written. ffmpeg can exit 0 without
	// producing a frame if the source has no decodable video in the
	// selected window (unlikely with thumbnail=60, but cheap to verify).
	st, statErr := os.Stat(outPath)
	if statErr != nil || st.Size() == 0 {
		return fmt.Errorf("poster output missing or empty: %s", outPath)
	}

	return nil
}
