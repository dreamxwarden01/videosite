package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
	"videosite-worker/internal/auth"
	"videosite-worker/internal/config"
)

type posterTransport func(*http.Request) (*http.Response, error)

func (f posterTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func posterResponse(code int) *http.Response {
	return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}
}
func setupPosterAPI(t *testing.T, transport posterTransport) {
	t.Helper()
	t.Chdir(t.TempDir())
	data, _ := json.Marshal(config.Config{SiteHostname: "localhost:9", ConcurrentUploads: 1, ConcurrentDownloads: 1})
	if err := os.WriteFile("config.json", data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(); err != nil {
		t.Fatal(err)
	}
	previous := httpClientPtr.Load()
	httpClientPtr.Store(&http.Client{Transport: transport})
	t.Cleanup(func() { httpClientPtr.Store(previous) })
	previousSession := activeSession.Load()
	SetSession(auth.NewSession())
	t.Cleanup(func() { activeSession.Store(previousSession) })
}
func TestPosterReadinessUsesSharedAPIRetryBudget(t *testing.T) {
	previous := retryDelays
	retryDelays = make([]time.Duration, len(previous))
	t.Cleanup(func() { retryDelays = previous })
	calls := 0
	setupPosterAPI(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Path != "/api/worker/tasks/poster-ready" {
			t.Fatal("unexpected request")
		}
		return posterResponse(503), nil
	})
	err := ReportPosterReady(context.Background(), "synthetic-job")
	if err == nil || calls != len(previous) {
		t.Fatalf("wrong shared budget: %d calls, %v", calls, err)
	}
}
func TestPosterReadinessDoesNotRetryAnUnrecoverableAuthFailure(t *testing.T) {
	calls := 0
	setupPosterAPI(t, func(r *http.Request) (*http.Response, error) { calls++; return posterResponse(401), nil })
	if err := ReportPosterReady(context.Background(), "synthetic-job"); !errors.Is(err, ErrAuthFailed) {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("wanted one report and one auth refresh, got %d", calls)
	}
}
func TestPosterReadinessRejectsUnconfirmedSuccessStatus(t *testing.T) {
	previous := retryDelays
	retryDelays = []time.Duration{0, 0}
	t.Cleanup(func() { retryDelays = previous })
	calls := 0
	setupPosterAPI(t, func(r *http.Request) (*http.Response, error) { calls++; return posterResponse(200), nil })
	if err := ReportPosterReady(context.Background(), "synthetic-job"); err == nil {
		t.Fatal("200 was accepted as a readiness acknowledgement")
	}
	if calls != 2 {
		t.Fatalf("unexpected calls %d", calls)
	}
}
