// Package auth holds the in-memory bearer-token session shared by the API client.
// The Session collapses concurrent refresh attempts — if two goroutines see 401
// at the same time, only one /api/worker/auth call goes out and both resume
// with the same fresh token.
package auth

import (
	"context"
	"sync"
)

// Session is the shared bearer-token cache.
// The zero value is not usable — call NewSession.
type Session struct {
	mu         sync.Mutex
	cond       *sync.Cond
	token      string
	refreshing bool
	refreshErr error
}

// NewSession returns a Session with no token yet.
// Call Refresh to populate it before issuing any authenticated API calls.
func NewSession() *Session {
	s := &Session{}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// Token returns the current bearer token. Empty before the first Refresh.
func (s *Session) Token() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.token
}

// Refresh calls refreshFn to obtain a new bearer. Concurrent callers collapse:
// only one refreshFn invocation goes out across the process, and every caller
// returns its result. Re-entrant calls while refreshFn is running are safe.
func (s *Session) Refresh(ctx context.Context, refreshFn func(context.Context) (string, error)) error {
	s.mu.Lock()
	if s.refreshing {
		// Another goroutine is mid-refresh — wait for it and return its result.
		for s.refreshing {
			s.cond.Wait()
		}
		err := s.refreshErr
		s.mu.Unlock()
		return err
	}
	s.refreshing = true
	s.refreshErr = nil
	s.mu.Unlock()

	// Do the actual network call outside the lock so other goroutines can queue up.
	token, err := refreshFn(ctx)

	s.mu.Lock()
	s.refreshing = false
	s.refreshErr = err
	if err == nil {
		s.token = token
	}
	s.cond.Broadcast()
	s.mu.Unlock()
	return err
}
