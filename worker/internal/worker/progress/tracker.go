package progress

import (
	"videosite-worker/internal/util"
	"fmt"
	"sync"
)

// JobProgress holds current progress info for a job.
type JobProgress struct {
	Status   string
	Progress int
}

// Tracker tracks progress of active jobs.
type Tracker struct {
	mu   sync.RWMutex
	jobs map[string]*JobProgress
}

// NewTracker creates a new progress tracker.
func NewTracker() *Tracker {
	return &Tracker{
		jobs: make(map[string]*JobProgress),
	}
}

// Update sets the status and progress for a job.
func (t *Tracker) Update(jobID, status string, progress int) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.jobs[jobID] = &JobProgress{
		Status:   status,
		Progress: progress,
	}
}

// Remove removes a job from tracking.
func (t *Tracker) Remove(jobID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.jobs, jobID)
}

// GetAll returns a snapshot of all active job progress.
func (t *Tracker) GetAll() map[string]JobProgress {
	t.mu.RLock()
	defer t.mu.RUnlock()

	result := make(map[string]JobProgress, len(t.jobs))
	for k, v := range t.jobs {
		result[k] = *v
	}
	return result
}

// PrintConsole prints all active job progress to console.
func (t *Tracker) PrintConsole() {
	jobs := t.GetAll()
	if len(jobs) == 0 {
		return
	}

	for jobID, jp := range jobs {
		fmt.Printf("%s   [%s] %s %d%%\n", util.Ts(), jobID, jp.Status, jp.Progress)
	}
}

// Count returns the number of tracked jobs.
func (t *Tracker) Count() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.jobs)
}
