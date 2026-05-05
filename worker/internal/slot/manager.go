package slot

import (
	"sync"
	"videosite-worker/internal/api"
	"videosite-worker/internal/config"
)

// Manager manages encoding slots.
//
// The struct uses a superset of fields needed by both platforms.
// macOS uses vtEnabled; Windows uses encoders. Platform-specific methods
// (NewManager, Reload, AcquireSlot, NextEncoder) are in build-tagged files.
//
// Graceful encoder shrink (deactivated / shrinkRemaining):
//
// When a user disables an encoder (or shrinks its per-encoder cap) while
// jobs are still running on it, we can't pre-empt those jobs — they're
// actively producing output. Instead:
//
//   - deactivated[hwID]=true marks the encoder as "no new acquires, every
//     release shrinks totalSlots instead of freeing a slot". When its last
//     active job releases and encoderUsage[hwID] drops to 0, the flag is
//     cleared (the encoder is fully gone).
//   - shrinkRemaining[hwID]=N means "the next N releases on this encoder
//     shrink totalSlots instead of freeing a slot". Used when only part of
//     an encoder's capacity is being retired (cap 5 → 2 with 3 active =
//     shrink 1 release, then resume normal free-slot behaviour).
//
// If the user re-enables a deactivated encoder before its jobs finish,
// Reload() clears both maps for that hwID — the in-flight jobs count
// normally again.
type Manager struct {
	mu              sync.Mutex
	vtEnabled       bool                      // macOS: VideoToolbox available and enabled
	encoders        []config.Encoder          // Windows: list of enabled hardware encoders
	encoderUsage    map[string]int            // Windows: HardwareID → active job count (nil on macOS)
	occupied        map[string]config.Encoder // jobID → assigned encoder
	activeJobs      map[string]*Job           // jobID → Job (for graceful shutdown + status reporting)
	totalSlots      int
	pendingTerminal []api.JobStatus // terminal statuses waiting to be reported

	deactivated     map[string]bool // hwID → pending full removal (every release shrinks)
	shrinkRemaining map[string]int  // hwID → N releases that should shrink instead of free
}

// TotalSlots returns the total number of concurrent job slots.
func (m *Manager) TotalSlots() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.totalSlots
}

// HasFreeSlot returns true if there is a free encoding slot.
func (m *Manager) HasFreeSlot() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.occupied) < m.totalSlots
}

// FreeSlots returns the number of currently-free encoding slots.
// Used by the worker main loop to size the batched /tasks/available request.
func (m *Manager) FreeSlots() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := m.totalSlots - len(m.occupied)
	if n < 0 {
		return 0
	}
	return n
}

// RegisterJob associates a Job pointer with its slot for graceful shutdown.
func (m *Manager) RegisterJob(jobID string, job *Job) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activeJobs[jobID] = job
}

// ReleaseSlot frees the slot used by a job.
//
// Three paths:
//  1. Deactivated encoder: shrink totalSlots by 1 (don't free). If this was
//     the last active job on that encoder, clear deactivated so a later
//     re-enable can start fresh.
//  2. Pending shrink: consume one shrinkRemaining[hwID], shrink totalSlots
//     by 1, don't free. Once drained, subsequent releases on this encoder
//     take the normal free path.
//  3. Normal: decrement encoderUsage, free the slot.
//
// occupied and activeJobs are cleared in all three paths.
func (m *Manager) ReleaseSlot(jobID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	enc, ok := m.occupied[jobID]
	if !ok {
		// Unknown job — still drop the activeJobs entry if present.
		delete(m.activeJobs, jobID)
		return
	}
	delete(m.occupied, jobID)
	delete(m.activeJobs, jobID)

	hid := enc.HardwareID

	// Path 1: encoder is fully deactivated — every release shrinks totalSlots.
	if m.deactivated != nil && m.deactivated[hid] {
		if m.totalSlots > 0 {
			m.totalSlots--
		}
		if m.encoderUsage != nil && m.encoderUsage[hid] > 0 {
			m.encoderUsage[hid]--
		}
		// Last job on this encoder drained — clear the deactivated flag so a
		// subsequent re-enable doesn't keep shrinking future releases.
		if m.encoderUsage == nil || m.encoderUsage[hid] == 0 {
			delete(m.deactivated, hid)
		}
		return
	}

	// Path 2: this release is one of N queued shrinks (cap was reduced below
	// current usage). Shrink totalSlots, tick the counter, do not free.
	if m.shrinkRemaining != nil && m.shrinkRemaining[hid] > 0 {
		if m.totalSlots > 0 {
			m.totalSlots--
		}
		m.shrinkRemaining[hid]--
		if m.shrinkRemaining[hid] == 0 {
			delete(m.shrinkRemaining, hid)
		}
		if m.encoderUsage != nil && m.encoderUsage[hid] > 0 {
			m.encoderUsage[hid]--
		}
		return
	}

	// Path 3: normal release — just decrement per-encoder usage.
	if m.encoderUsage != nil && m.encoderUsage[hid] > 0 {
		m.encoderUsage[hid]--
	}
}

// ActiveJobs returns a snapshot copy of all active jobs.
func (m *Manager) ActiveJobs() map[string]*Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make(map[string]*Job, len(m.activeJobs))
	for k, v := range m.activeJobs {
		result[k] = v
	}
	return result
}

// ActiveCount returns the number of currently active jobs.
func (m *Manager) ActiveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.occupied)
}

// RecordTerminal queues a terminal status (failed/aborted) to be reported by
// the next SnapshotStatuses call. Safe to call after the Job goroutine has
// exited — the entry lives in the manager, not on the Job.
func (m *Manager) RecordTerminal(status api.JobStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pendingTerminal = append(m.pendingTerminal, status)
}

// SnapshotStatuses returns the status report for the next /tasks/status tick:
//   - one "running" entry per active job (reading its atomic stage/progress)
//   - plus every queued terminal entry (drained atomically)
//
// The caller sends these to the server; on any 2xx the statuses have been
// delivered and should not be resent next tick.
func (m *Manager) SnapshotStatuses() []api.JobStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	statuses := make([]api.JobStatus, 0, len(m.activeJobs)+len(m.pendingTerminal))
	for jobID, j := range m.activeJobs {
		// Skip jobs whose /tasks/complete call is in flight. Their last stored
		// stage is still "uploading 99%" (Progress.Remove runs only after
		// CompleteTask returns), and a concurrent status batch would race with
		// the server's terminal write — on the server this is already blocked
		// by updateTaskStatus's NOT IN ('completed','error') guard, but
		// skipping locally avoids sending a known-stale entry at all.
		if j.Phase() == "completing" {
			continue
		}
		stage, progress := j.currentReport()
		if stage == "" {
			continue // Job not yet reporting (init phase)
		}
		statuses = append(statuses, api.JobStatus{
			JobID:    jobID,
			Status:   "running",
			Stage:    stage,
			Progress: float64(progress),
		})
	}
	if len(m.pendingTerminal) > 0 {
		statuses = append(statuses, m.pendingTerminal...)
		m.pendingTerminal = m.pendingTerminal[:0]
	}
	return statuses
}

// HandleAcks processes per-job acks from the server. ack:false means the
// server no longer recognises the job — we cancel it and free its slot.
func (m *Manager) HandleAcks(acks []api.JobAck) {
	for _, a := range acks {
		if a.Ack {
			continue
		}
		m.mu.Lock()
		j, ok := m.activeJobs[a.JobID]
		m.mu.Unlock()
		if ok && j != nil {
			j.Cancel()
		}
	}
}

// AbortAll cancels every active job. Called by the status loop when the server
// is unreachable for 60 s — the worker gives up on reporting to prevent ffmpeg
// processes from drifting out of sync with the queue.
// pendingTerminal is cleared because those statuses can't be reported anyway.
func (m *Manager) AbortAll(reason string) {
	m.mu.Lock()
	jobs := make([]*Job, 0, len(m.activeJobs))
	for _, j := range m.activeJobs {
		jobs = append(jobs, j)
	}
	m.pendingTerminal = m.pendingTerminal[:0]
	m.mu.Unlock()

	for _, j := range jobs {
		j.Cancel()
	}
}
