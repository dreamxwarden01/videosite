// Package ui is the worker's user-visible surface: progress bars + log lines.
//
// In TTY mode the bottom of the screen is a sticky region with one bar per
// active job, sorted ascending by lease time; log lines scroll above. When a
// job completes / aborts / hard-errors, its bar disappears.
//
// In non-TTY mode (piped, redirected, non-interactive CI), the bar surface is
// replaced with a 10-second summary line per active job — no ANSI escapes,
// safe to tail.
//
// Callers never pick an implementation directly; NewManager() returns the
// right one by inspecting os.Stdout.
package ui

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Manager is the worker's single point of user-visible output.
//
// A Manager is safe for concurrent use. All job methods are idempotent: calling
// StartJob twice with the same jobID has no effect after the first, and
// FinishJob on an unknown jobID is a no-op.
//
// The global percentage passed to UpdateStage is the 0-100 value reported to
// the server (download 0-9, processing 10-90 weighted, upload 90-100). It is
// logged alongside the stage-transition line so users can see both the
// stage-local bar and the overall job position at a glance.
type Manager interface {
	// StartJob registers a new active job. leasedAt is used only to order bars
	// in the sticky region (oldest lease at the top). profiles are the output
	// profile names for the initial lease log line. normOn signals whether
	// audio normalization is enabled for this job.
	StartJob(jobID string, leasedAt time.Time, profiles []string, normOn bool)

	// UpdateStage marks a stage transition — the bar resets its local fill to
	// 0 and relabels. A log line is emitted with the global % so the audit
	// trail captures stage boundaries even in non-TTY mode.
	UpdateStage(jobID, stage string, globalPct int)

	// LogStageBoundary emits the same boundary log line as UpdateStage
	// (`[short] → stage (global: NN%)`) but does NOT touch the bar — the
	// previous stage's label and pct stay on screen. Used for sub-second
	// stages like "probing" where resetting the bar to 0% would just give
	// the user a flash of empty bar before the next real stage starts.
	LogStageBoundary(jobID, stage string, globalPct int)

	// UpdateStageProgress sets the current stage's local fill (0-100). No log
	// line is emitted. Called at ffmpeg-frame / R2-part granularity.
	UpdateStageProgress(jobID string, localPct int)

	// FinishJob removes the job's bar and emits a final log line. reason is a
	// pre-formatted human-readable string (e.g. "completed", "aborted (phase:
	// download)", "ERROR: job failed at transcode: no encoder available"). The
	// caller is responsible for the wording; the UI just prints it with the
	// standard [ts] [jobID] prefix.
	FinishJob(jobID string, reason string)

	// Logf writes one log line above the sticky region with a [YYYY-MM-DD
	// HH:MM:SS] prefix and a trailing newline. Safe to call from any
	// goroutine; safe to call before StartJob / after FinishJob.
	Logf(format string, args ...interface{})

	// Write implements io.Writer so the Manager can be used as the sink for
	// log/slog handlers. Each Write is treated as one or more already-
	// formatted log lines (terminating newline optional). This is how slog
	// records land in the same stream as Logf.
	Write(p []byte) (int, error)

	// Close drains any pending output and releases terminal control. Safe to
	// call multiple times.
	Close()
}

// formatLeaseLog builds the initial "leased" message body. Kept here so both
// impls render it identically.
func formatLeaseLog(jobID string, profiles []string, normOn bool) string {
	profstr := ""
	if len(profiles) > 0 {
		profstr = " — " + strings.Join(profiles, ",")
	}
	normstr := ""
	if normOn {
		normstr = " (norm on)"
	}
	return fmt.Sprintf("[%s] leased%s%s", jobID, profstr, normstr)
}

// slogHandler formats slog records to match the worker's conventional line
// style — a util.Ts-style prefix, the message, and key=value attrs — and
// routes them through a Manager so they interleave correctly with Logf lines
// and the sticky bar region.
type slogHandler struct {
	mgr   Manager
	level slog.Level
	attrs []slog.Attr
	group string
}

// SlogHandler returns a slog.Handler that writes records through mgr.
// Use via: slog.SetDefault(slog.New(ui.SlogHandler(mgr, slog.LevelInfo)))
func SlogHandler(mgr Manager, level slog.Level) slog.Handler {
	return &slogHandler{mgr: mgr, level: level}
}

func (h *slogHandler) Enabled(_ context.Context, lvl slog.Level) bool {
	return lvl >= h.level
}

func (h *slogHandler) Handle(_ context.Context, r slog.Record) error {
	var sb strings.Builder
	sb.WriteString(r.Level.String())
	sb.WriteByte(' ')
	sb.WriteString(r.Message)
	for _, a := range h.attrs {
		fmt.Fprintf(&sb, " %s=%v", a.Key, a.Value.Any())
	}
	r.Attrs(func(a slog.Attr) bool {
		fmt.Fprintf(&sb, " %s=%v", a.Key, a.Value.Any())
		return true
	})
	h.mgr.Logf("%s", sb.String())
	return nil
}

func (h *slogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	cp := *h
	cp.attrs = append(append([]slog.Attr{}, h.attrs...), attrs...)
	return &cp
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	cp := *h
	cp.group = name
	return &cp
}
