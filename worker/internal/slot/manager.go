package slot

import (
	"sync"
	"videosite-worker/internal/config"
)

// Manager manages encoding slots.
//
// The struct uses a superset of fields needed by both platforms.
// macOS uses vtEnabled; Windows uses encoders. Platform-specific methods
// (NewManager, Reload, AcquireSlot, NextEncoder) are in build-tagged files.
type Manager struct {
	mu           sync.Mutex
	vtEnabled    bool                     // macOS: VideoToolbox available and enabled
	encoders     []config.Encoder         // Windows: list of enabled hardware encoders
	encoderUsage map[string]int           // Windows: HardwareID → active job count (nil on macOS)
	occupied     map[string]config.Encoder // jobID → assigned encoder
	activeJobs   map[string]*Job           // jobID → Job (for graceful shutdown)
	totalSlots   int
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

// RegisterJob associates a Job pointer with its slot for graceful shutdown.
func (m *Manager) RegisterJob(jobID string, job *Job) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activeJobs[jobID] = job
}

// ReleaseSlot frees the slot used by a job.
func (m *Manager) ReleaseSlot(jobID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if enc, ok := m.occupied[jobID]; ok && m.encoderUsage != nil {
		if m.encoderUsage[enc.HardwareID] > 0 {
			m.encoderUsage[enc.HardwareID]--
		}
	}
	delete(m.occupied, jobID)
	delete(m.activeJobs, jobID)
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
