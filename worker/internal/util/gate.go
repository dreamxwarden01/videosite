package util

import (
	"context"
	"sync"
)

// DynamicGate bounds concurrency with a cap that is re-read on every acquire.
//
// Why not a plain buffered channel? A `chan struct{}` capped at N is sized once
// and can't shrink live — config reloads would be invisible until the next
// process restart. DynamicGate instead reads its cap through a user-supplied
// function, so `config.Get().ConcurrentDownloads` is consulted each time a
// goroutine asks for a slot.
//
// Semantics on cap change:
//
//   - Cap increase: parked acquirers wake on the next Release (cond broadcast)
//     and observe the new cap, so throughput ramps up naturally. No external
//     nudge is required.
//   - Cap decrease: in-flight holders are NOT preempted — they finish whatever
//     operation they were doing. Further Acquire calls block until
//     active < cap(). Net effect: capacity shrinks as holders release.
//
// Context cancellation unblocks a parked acquire with ctx.Err().
type DynamicGate struct {
	mu     sync.Mutex
	cond   *sync.Cond
	active int
	capFn  func() int
}

// NewDynamicGate constructs a gate whose capacity is sourced from capFn.
// capFn should return a positive integer; values <= 0 will cause Acquire
// to block indefinitely (or until ctx is cancelled). The config package's
// validateAndNormalize() guarantees positive values before this reaches us.
func NewDynamicGate(capFn func() int) *DynamicGate {
	g := &DynamicGate{capFn: capFn}
	g.cond = sync.NewCond(&g.mu)
	return g
}

// Acquire blocks until a slot is available (active < cap()) or ctx is done.
// On success, the caller must pair it with a matching Release.
func (g *DynamicGate) Acquire(ctx context.Context) error {
	// When ctx is cancelled we need to wake any wait loop the caller is in.
	// Start a watchdog that broadcasts on cancellation; the defer close lets
	// it exit cleanly on a normal (non-cancelled) Acquire.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			g.mu.Lock()
			g.cond.Broadcast()
			g.mu.Unlock()
		case <-done:
		}
	}()

	g.mu.Lock()
	defer g.mu.Unlock()
	for g.active >= g.capFn() {
		if err := ctx.Err(); err != nil {
			return err
		}
		g.cond.Wait()
	}
	g.active++
	return nil
}

// Release hands back the slot previously taken by a successful Acquire.
// Safe to call from a different goroutine than the one that acquired.
func (g *DynamicGate) Release() {
	g.mu.Lock()
	if g.active > 0 {
		g.active--
	}
	g.cond.Broadcast()
	g.mu.Unlock()
}

// Active returns the current number of held slots. Primarily for diagnostics.
func (g *DynamicGate) Active() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.active
}
