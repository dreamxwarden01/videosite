package transcoder

import (
	"videosite-worker/internal/util"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// ErrFFmpegMissing is a sentinel error indicating FFmpeg/FFprobe binary
// is not found or not executable. This is a fatal worker error —
// jobs should NOT report this to the server (let heartbeat timeout release tasks).
var ErrFFmpegMissing = fmt.Errorf("ffmpeg binary not found or not executable")

var (
	ffmpegPath  = "ffmpeg"
	ffprobePath = "ffprobe"
)

// DetectFFmpeg checks if ffmpeg and ffprobe are available in PATH.
func DetectFFmpeg() error {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return fmt.Errorf("ffmpeg not found in PATH: %w", err)
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		return fmt.Errorf("ffprobe not found in PATH: %w", err)
	}
	return nil
}

// isExecMissing checks if an error indicates the binary could not be found/executed.
func isExecMissing(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, exec.ErrNotFound) {
		return true
	}
	var pathErr *exec.Error
	if errors.As(err, &pathErr) {
		return true
	}
	return false
}

// openLog opens (or creates) a log file for an FFmpeg invocation and writes
// a header containing the timestamp and the full command. Returns the open
// file (caller must close) and a combined writer (file + stderrBuf).
//
// logPath may be empty — in that case the returned file is nil and the
// returned writer is just stderrBuf. This makes all call-sites uniform.
func openLog(logPath string, stderrBuf *bytes.Buffer, args []string) (*os.File, io.Writer) {
	var writers []io.Writer
	writers = append(writers, stderrBuf)

	if logPath == "" {
		return nil, io.MultiWriter(writers...)
	}

	f, err := os.Create(logPath)
	if err != nil {
		// Non-fatal: continue without file logging.
		fmt.Printf("%s   [WARN] could not create FFmpeg log %s: %v\n", util.Ts(), logPath, err)
		return nil, io.MultiWriter(writers...)
	}

	// Write a header so it's easy to reproduce the invocation.
	fmt.Fprintf(f, "=== FFmpeg invocation ===\n")
	fmt.Fprintf(f, "time:    %s\n", time.Now().Format("2006-01-02 15:04:05"))
	fmt.Fprintf(f, "command: ffmpeg %s\n", strings.Join(args, " "))
	fmt.Fprintf(f, "=========================\n\n")

	writers = append(writers, f)
	return f, io.MultiWriter(writers...)
}

// RunFFmpeg executes ffmpeg with the given arguments and context.
// logPath is the path of a file to write the complete FFmpeg stderr output to.
// Pass an empty string to skip file logging.
func RunFFmpeg(ctx context.Context, logPath string, args ...string) error {
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	cmd.Stdout = nil

	var stderrBuf bytes.Buffer
	logFile, stderrW := openLog(logPath, &stderrBuf, args)
	if logFile != nil {
		defer logFile.Close()
	}
	cmd.Stderr = stderrW

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("ffmpeg cancelled: %w", ctx.Err())
		}
		if isExecMissing(err) {
			return fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		hint := ""
		if logPath != "" {
			hint = fmt.Sprintf(" (full log: %s)", logPath)
		}
		return fmt.Errorf("ffmpeg failed: %w%s\n%s", err, hint, lastLines(stderrBuf.String(), 8))
	}
	return nil
}

// RunFFmpegWithProgress executes ffmpeg and parses progress output.
// logPath is the path of a file to write the complete FFmpeg stderr output to.
// Pass an empty string to skip file logging.
// Returns a channel that receives progress percentage updates.
func RunFFmpegWithProgress(ctx context.Context, totalDuration float64, logPath string, args ...string) (<-chan int, <-chan error) {
	progressCh := make(chan int, 100)
	errCh := make(chan error, 1)

	go func() {
		defer close(progressCh)
		defer close(errCh)

		// -progress pipe:1 writes progress lines to stdout.
		// stderr is free for the full FFmpeg diagnostic log.
		allArgs := append([]string{"-progress", "pipe:1", "-nostats"}, args...)
		cmd := exec.CommandContext(ctx, ffmpegPath, allArgs...)

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			errCh <- fmt.Errorf("stdout pipe: %w", err)
			return
		}

		var stderrBuf bytes.Buffer
		logFile, stderrW := openLog(logPath, &stderrBuf, allArgs)
		if logFile != nil {
			defer logFile.Close()
		}
		cmd.Stderr = stderrW

		if err := cmd.Start(); err != nil {
			if isExecMissing(err) {
				errCh <- fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
			} else {
				errCh <- fmt.Errorf("start ffmpeg: %w", err)
			}
			return
		}

		// Parse progress output from stdout.
		buf := make([]byte, 4096)
		for {
			n, readErr := stdout.Read(buf)
			if n > 0 && totalDuration > 0 {
				text := string(buf[:n])
				if ms := parseOutTimeMs(text); ms > 0 {
					pct := int(float64(ms) / (totalDuration * 1000000) * 100)
					if pct > 100 {
						pct = 100
					}
					select {
					case progressCh <- pct:
					default:
					}
				}
			}
			if readErr != nil {
				break
			}
		}

		if err := cmd.Wait(); err != nil {
			if ctx.Err() != nil {
				errCh <- fmt.Errorf("ffmpeg cancelled: %w", ctx.Err())
			} else {
				hint := ""
				if logPath != "" {
					hint = fmt.Sprintf(" (full log: %s)", logPath)
				}
				errCh <- fmt.Errorf("ffmpeg failed: %w%s\n%s", err, hint, lastLines(stderrBuf.String(), 8))
			}
			return
		}
		errCh <- nil
	}()

	return progressCh, errCh
}

// runFFmpegCaptureStderr runs ffmpeg with the given args and returns the combined
// stderr output as a string. stdout is discarded. Used for analysis passes (e.g.
// loudnorm pass 1) where the result is in stderr, not a file.
//
// Note: ffmpeg may exit non-zero even when the analysis succeeded (e.g. when
// writing to -f null gives a format warning). Callers should inspect the returned
// string for the expected output before treating a non-nil error as fatal.
func runFFmpegCaptureStderr(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	cmd.Stdout = nil

	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	if ctx.Err() != nil {
		return stderrBuf.String(), fmt.Errorf("ffmpeg cancelled: %w", ctx.Err())
	}
	if err != nil {
		if isExecMissing(err) {
			return stderrBuf.String(), fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		// Return stderr even on non-zero exit — loudnorm always prints its JSON
		// before ffmpeg exits, regardless of exit code.
		return stderrBuf.String(), err
	}
	return stderrBuf.String(), nil
}

// parseOutTimeMs extracts out_time_ms from ffmpeg progress output.
func parseOutTimeMs(text string) int64 {
	var ms int64
	for _, line := range splitLines(text) {
		if len(line) > 12 && line[:12] == "out_time_ms=" {
			fmt.Sscanf(line[12:], "%d", &ms)
			return ms
		}
	}
	return 0
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			lines = append(lines, line)
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

// lastLines returns the last n non-empty lines from s, trimmed and joined.
// Used to include the relevant tail of FFmpeg stderr in error messages.
func lastLines(s string, n int) string {
	all := strings.Split(strings.TrimSpace(s), "\n")
	var nonempty []string
	for _, l := range all {
		l = strings.TrimSpace(l)
		if l != "" {
			nonempty = append(nonempty, l)
		}
	}
	if len(nonempty) <= n {
		return strings.Join(nonempty, "\n")
	}
	return strings.Join(nonempty[len(nonempty)-n:], "\n")
}
