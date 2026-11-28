package api

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCancelledPresignWaitDoesNotWaitForOtherJobs(t *testing.T) {
	presignGate <- struct{}{}
	defer func() { <-presignGate }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := GetUploadURLsLocked(ctx, "synthetic", []string{"poster.jpg"}); done <- err }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("unexpected result: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled presign remained blocked")
	}
}
func TestCancelledPresignDoesNotStartRequestWithFreeGate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := GetUploadURLsLocked(ctx, "synthetic", []string{"poster.jpg"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("started a request despite cancellation: %v", err)
	}
	if len(presignGate) != 0 {
		t.Fatal("gate leaked")
	}
}
