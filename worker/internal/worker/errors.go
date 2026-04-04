package worker

import "sync"

// ErrorBlocklist tracks video IDs that have errored, preventing re-polling.
// Cleared on restart.
type ErrorBlocklist struct {
	mu      sync.RWMutex
	blocked map[int]bool
}

// NewErrorBlocklist creates a new blocklist.
func NewErrorBlocklist() *ErrorBlocklist {
	return &ErrorBlocklist{
		blocked: make(map[int]bool),
	}
}

// Add adds a video ID to the blocklist.
func (b *ErrorBlocklist) Add(videoID int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.blocked[videoID] = true
}

// IsBlocked returns true if a video ID is in the blocklist.
func (b *ErrorBlocklist) IsBlocked(videoID int) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.blocked[videoID]
}
