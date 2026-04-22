package ui

import (
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"videosite-worker/internal/util"
)

// plainJob is the tracked state for one active job in non-TTY mode.
// stage / localPct / globalPct are written by UpdateStage and
// UpdateStageProgress; they are read by the 10-second summary goroutine
// which emits one line per active job.
//
// vaActive/vPct/aPct mirror the ttyBar composite mode — set by
// UpdateStageProgressVA and cleared by UpdateStage / UpdateStageProgress.
// vOnly mirrors the V-only expanded bar mode — set by
// UpdateStageProgressVOnly and cleared by the same calls. Exactly one of
// (vaActive, vOnly, neither) is true at any time.
//
// When vaActive is true the summarizer emits the dual-track form
// (`V=NN% A=NN%`); when vOnly is true the summarizer emits
// `V=NN%` (no A column); otherwise the classic single local pct is used.
//
// All fields are accessed under plainManager.mu — the hot paths are
// stage transitions and finishes, both low-frequency. localPct is updated
// per ffmpeg-frame but each update is one int-write under the same lock
// the summary goroutine takes, so contention is negligible.
type plainJob struct {
	jobID     string
	leasedAt  time.Time
	stage     string
	localPct  int
	globalPct int

	vaActive bool
	vOnly    bool
	vPct     int
	aPct     int

	// completing == true once UpdateStage("completing", _) fires. The
	// summarizer skips these rows to avoid the same stale-terminal race
	// the server already guards against in /task/status.
	completing bool
}

// plainManager is the non-TTY sink. Every Logf / Write goes straight to
// the output stream (stdout by convention); there are no ANSI escapes.
//
// The summary goroutine ticks every 10s. For each active non-completing
// job it emits:
//
//	[2026-04-15 14:31:34] [abc12345] transcoding h264-1080p (1/3) 58% (global 45%)
//
// Stage-transition lines (from UpdateStage) and lifecycle lines (lease /
// finish) are emitted at the moment they occur, so the tail-friendly log
// file records both the boundaries and the per-job heartbeat.
type plainManager struct {
	out io.Writer

	mu   sync.Mutex
	jobs map[string]*plainJob

	stopOnce sync.Once
	stop     chan struct{}
	wg       sync.WaitGroup
	closed   atomic.Bool
}

// summaryInterval is the plain-mode heartbeat period. Matches the plan's
// "one summary line per active job every 10s".
const summaryInterval = 10 * time.Second

// newPlain constructs a plainManager writing to out (typically os.Stdout)
// and starts its summarizer goroutine. Call Close() to stop it.
func newPlain(out io.Writer) *plainManager {
	m := &plainManager{
		out:  out,
		jobs: make(map[string]*plainJob),
		stop: make(chan struct{}),
	}
	m.wg.Add(1)
	go m.summarize()
	return m
}

// summarize runs in its own goroutine, waking every summaryInterval and
// emitting one line per active job. Skipped:
//   - jobs still in the "queued" placeholder phase (no UpdateStage yet)
//   - jobs in the "completing" stage (see plainJob.completing)
//
// Exits when stop is closed.
func (m *plainManager) summarize() {
	defer m.wg.Done()
	t := time.NewTicker(summaryInterval)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
			m.emitSummary()
		}
	}
}

// emitSummary writes one heartbeat line per tracked non-completing job.
// Held briefly so stage transitions aren't blocked by a slow writer.
func (m *plainManager) emitSummary() {
	m.mu.Lock()
	// Snapshot under the lock, format + write outside it.
	lines := make([]string, 0, len(m.jobs))
	for _, j := range m.jobs {
		if j.completing || j.stage == "" {
			continue
		}
		if j.vaActive {
			lines = append(lines,
				fmt.Sprintf("%s [%s] %s V=%d%% A=%d%% (global %d%%)",
					util.Ts(), j.jobID, j.stage, j.vPct, j.aPct, j.globalPct),
			)
			continue
		}
		if j.vOnly {
			lines = append(lines,
				fmt.Sprintf("%s [%s] %s V=%d%% (global %d%%)",
					util.Ts(), j.jobID, j.stage, j.vPct, j.globalPct),
			)
			continue
		}
		lines = append(lines,
			fmt.Sprintf("%s [%s] %s %d%% (global %d%%)",
				util.Ts(), j.jobID, j.stage, j.localPct, j.globalPct),
		)
	}
	m.mu.Unlock()

	for _, l := range lines {
		_, _ = io.WriteString(m.out, l+"\n")
	}
}

// StartJob registers a new active job and writes its lease line.
func (m *plainManager) StartJob(jobID string, leasedAt time.Time, profiles []string, normOn bool) {
	if m.closed.Load() {
		return
	}
	m.mu.Lock()
	if _, exists := m.jobs[jobID]; exists {
		m.mu.Unlock()
		return
	}
	m.jobs[jobID] = &plainJob{jobID: jobID, leasedAt: leasedAt}
	m.mu.Unlock()

	m.Logf("%s", formatLeaseLog(jobID, profiles, normOn))
}

// UpdateStage records the transition and emits the boundary log line with
// global %. Mirrors the TTY path exactly so a user reading stdout sees the
// same stage-boundary messages regardless of terminal mode.
//
// Also clears composite VA mode — same semantics as the TTY path.
func (m *plainManager) UpdateStage(jobID, stage string, globalPct int) {
	if m.closed.Load() {
		return
	}
	m.mu.Lock()
	j, ok := m.jobs[jobID]
	if ok {
		j.stage = stage
		j.globalPct = globalPct
		j.localPct = 0
		j.vaActive = false
		j.vOnly = false
		j.vPct = 0
		j.aPct = 0
		if stage == "completing" {
			j.completing = true
		}
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	m.Logf("[%s] → %s (global: %d%%)", jobID, stage, globalPct)
}

// LogStageBoundary emits the audit line without touching the tracked
// stage/pct. In plain mode there is no bar to "leave alone", so the
// behaviour differs from UpdateStage only in that the summarizer keeps
// reporting the previous stage's pct. Used when the boundary is for a
// sub-second stage we don't want to surface to the periodic summary.
func (m *plainManager) LogStageBoundary(jobID, stage string, globalPct int) {
	if m.closed.Load() {
		return
	}
	m.Logf("[%s] → %s (global: %d%%)", jobID, stage, globalPct)
}

// UpdateStageProgress stores the latest local % without logging. The
// summarizer will publish it on the next tick. Also clears composite VA
// mode so the next summary goes back to the single-pct form.
func (m *plainManager) UpdateStageProgress(jobID string, localPct int) {
	if m.closed.Load() {
		return
	}
	if localPct < 0 {
		localPct = 0
	}
	if localPct > 100 {
		localPct = 100
	}
	m.mu.Lock()
	if j, ok := m.jobs[jobID]; ok {
		j.localPct = localPct
		j.vaActive = false
		j.vOnly = false
	}
	m.mu.Unlock()
}

// UpdateStageProgressVA stores the V and A track pcts and enables composite
// reporting for the next summary tick. See plainJob docs.
func (m *plainManager) UpdateStageProgressVA(jobID string, videoPct, audioPct int) {
	if m.closed.Load() {
		return
	}
	if videoPct < 0 {
		videoPct = 0
	} else if videoPct > 100 {
		videoPct = 100
	}
	if audioPct < 0 {
		audioPct = 0
	} else if audioPct > 100 {
		audioPct = 100
	}
	m.mu.Lock()
	if j, ok := m.jobs[jobID]; ok {
		j.vPct = videoPct
		j.aPct = audioPct
		j.vaActive = true
		j.vOnly = false
	}
	m.mu.Unlock()
}

// UpdateStageProgressVOnly stores the V track pct and enables the V-only
// summary form for the next tick. See plainJob docs for the three-mode
// matrix; summaries will emit `V=NN%` without the A column until a
// subsequent UpdateStage / UpdateStageProgress / UpdateStageProgressVA call
// clears vOnly.
func (m *plainManager) UpdateStageProgressVOnly(jobID string, videoPct int) {
	if m.closed.Load() {
		return
	}
	if videoPct < 0 {
		videoPct = 0
	} else if videoPct > 100 {
		videoPct = 100
	}
	m.mu.Lock()
	if j, ok := m.jobs[jobID]; ok {
		j.vPct = videoPct
		j.vOnly = true
		j.vaActive = false
	}
	m.mu.Unlock()
}

// FinishJob removes the job from the tracker and logs the reason. No bar
// to drop — this is the non-TTY path.
func (m *plainManager) FinishJob(jobID string, reason string) {
	m.mu.Lock()
	_, ok := m.jobs[jobID]
	if ok {
		delete(m.jobs, jobID)
	}
	m.mu.Unlock()

	m.Logf("[%s] %s", jobID, reason)
}

// Logf writes one timestamp-prefixed line directly to the output stream.
func (m *plainManager) Logf(format string, args ...interface{}) {
	line := util.Ts() + " " + fmt.Sprintf(format, args...) + "\n"
	_, _ = io.WriteString(m.out, line)
}

// Write implements io.Writer for slog.Handler routing. Plain mode simply
// passes chunks through; callers are expected to have formatted them as
// complete log lines.
func (m *plainManager) Write(p []byte) (int, error) {
	return m.out.Write(p)
}

// Close stops the summarizer. Idempotent. Pending stage-transition logs
// are already flushed synchronously (they write straight to the stream);
// only the background goroutine needs to drain.
func (m *plainManager) Close() {
	m.stopOnce.Do(func() {
		m.closed.Store(true)
		close(m.stop)
	})
	m.wg.Wait()
}

// Compile-time assertion: plainManager satisfies Manager.
var _ Manager = (*plainManager)(nil)
