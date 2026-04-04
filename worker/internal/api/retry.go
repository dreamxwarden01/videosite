package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// retryDelays defines the backoff schedule: 0s, 1s, 2s, 3s, 4s, then 5s per attempt.
// Total cumulative wait across all 15 delays: 0+1+2+3+4+(5×10) = 60s.
// After all attempts fail the caller should treat the job as aborted.
var retryDelays = []time.Duration{
	0,
	1 * time.Second,
	2 * time.Second,
	3 * time.Second,
	4 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
	5 * time.Second,
}

// RetryWithBackoff retries fn up to 15 attempts with escalating delays
// (0s, 1s, 2s, 3s, 4s, then 5s — ~60s total wait).
// Returns an error if all attempts are exhausted, which the caller should
// treat as a job abort signal.
//
// Returns immediately on:
//   - fn() success (nil)
//   - ErrJobNotFound (job deleted — abort signal)
//   - ErrAuthFailed (invalid credentials — fatal)
//   - context cancellation
func RetryWithBackoff(ctx context.Context, operation string, fn func() error) error {
	var lastErr error
	for i, delay := range retryDelays {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if delay > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		err := fn()
		if err == nil {
			return nil
		}
		if errors.Is(err, ErrJobNotFound) {
			return err
		}
		if errors.Is(err, ErrAuthFailed) {
			return err
		}
		lastErr = err
		slog.Warn("API call failed, retrying",
			"operation", operation,
			"attempt", i+1,
			"of", len(retryDelays),
			"err", err)
	}
	return fmt.Errorf("%s failed after %d attempts: %w", operation, len(retryDelays), lastErr)
}
