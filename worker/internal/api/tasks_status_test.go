package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"videosite-worker/internal/auth"
	"videosite-worker/internal/config"
)

func setupAPIHTTP(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	t.Chdir(t.TempDir())
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	data, _ := json.Marshal(config.Config{SiteHostname: strings.TrimPrefix(server.URL, "http://"), ConcurrentUploads: 2, ConcurrentDownloads: 1})
	if err := os.WriteFile("config.json", data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(); err != nil {
		t.Fatal(err)
	}
	previousClient := httpClientPtr.Load()
	Init(nil, nil, false)
	t.Cleanup(func() { httpClientPtr.Store(previousClient) })
	previousSession := activeSession.Load()
	s := auth.NewSession()
	if err := s.Refresh(context.Background(), func(context.Context) (string, error) { return "synthetic-only", nil }); err != nil {
		t.Fatal(err)
	}
	SetSession(s)
	t.Cleanup(func() { activeSession.Store(previousSession) })
}
func statusInputs(n int) []JobStatus {
	jobs := make([]JobStatus, n)
	for i := range jobs {
		jobs[i] = JobStatus{JobID: fmt.Sprintf("Job%09d", i), Status: "running", Stage: "transcoding", Progress: 23}
	}
	return jobs
}
func readStatusBatch(t *testing.T, r *http.Request) []JobStatus {
	t.Helper()
	var body struct {
		Jobs []JobStatus `json:"jobs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Error(err)
	}
	if len(body.Jobs) == 0 || len(body.Jobs) > 256 {
		t.Errorf("invalid batch length %d", len(body.Jobs))
	}
	return body.Jobs
}
func writeStatusBatch(w http.ResponseWriter, jobs []JobStatus) {
	acks := make([]JobAck, len(jobs))
	for i, j := range jobs {
		acks[i] = JobAck{JobID: j.JobID, Ack: i%2 == 0}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(statusResponse{Results: acks})
}
func TestStatusReportChunksPreserveJobAndAckOrder(t *testing.T) {
	for _, count := range []int{1, 256, 257, 600} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			var mu sync.Mutex
			var sizes []int
			var seen []JobStatus
			var expected []JobAck
			setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				if r.URL.Path != "/api/worker/tasks/status" {
					t.Error("unexpected path")
				}
				jobs := readStatusBatch(t, r)
				sizes = append(sizes, len(jobs))
				seen = append(seen, jobs...)
				for i, j := range jobs {
					expected = append(expected, JobAck{JobID: j.JobID, Ack: i%2 == 0})
				}
				writeStatusBatch(w, jobs)
			})
			jobs := statusInputs(count)
			acks, err := ReportStatus(context.Background(), jobs)
			if err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(seen, jobs) || !reflect.DeepEqual(acks, expected) {
				t.Fatal("chunking reordered or lost a job/ack")
			}
			if len(sizes) != (count+255)/256 {
				t.Fatalf("unexpected requests %v", sizes)
			}
			if count <= 256 && len(sizes) != 1 {
				t.Fatal("normal batch behavior changed")
			}
		})
	}
}
func TestStatusChunkFailureDoesNotSendLaterChunksOrReturnPartialAcks(t *testing.T) {
	var requests atomic.Int32
	setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		jobs := readStatusBatch(t, r)
		if requests.Add(1) == 2 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]string{"error": "synthetic"})
			return
		}
		writeStatusBatch(w, jobs)
	})
	acks, err := ReportStatus(context.Background(), statusInputs(600))
	if err == nil || acks != nil || requests.Load() != 2 {
		t.Fatalf("unexpected partial failure: %v %v %d", acks, err, requests.Load())
	}
}
func TestStatusChunkAuthenticationFailureStopsTheReport(t *testing.T) {
	var reports, refreshes atomic.Int32
	setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/worker/auth" {
			refreshes.Add(1)
			w.WriteHeader(401)
			return
		}
		jobs := readStatusBatch(t, r)
		if reports.Add(1) == 2 {
			w.WriteHeader(401)
			return
		}
		writeStatusBatch(w, jobs)
	})
	acks, err := ReportStatus(context.Background(), statusInputs(600))
	if !errors.Is(err, ErrAuthFailed) || acks != nil || reports.Load() != 2 || refreshes.Load() != 1 {
		t.Fatalf("auth failure was not preserved: %v %d %d", err, reports.Load(), refreshes.Load())
	}
}
func TestStatusChunkAuthRefreshRetriesOnlyCurrentChunk(t *testing.T) {
	var mu sync.Mutex
	var firstIDs []string
	refreshes := 0
	setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path == "/api/worker/auth" {
			refreshes++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"bearerToken": "synthetic-refreshed", "expiresInSeconds": 3600})
			return
		}
		jobs := readStatusBatch(t, r)
		firstIDs = append(firstIDs, jobs[0].JobID)
		if len(firstIDs) == 2 {
			w.WriteHeader(401)
			return
		}
		writeStatusBatch(w, jobs)
	})
	acks, err := ReportStatus(context.Background(), statusInputs(600))
	if err != nil || len(acks) != 600 {
		t.Fatalf("report failed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	expected := []string{"Job000000000", "Job000000256", "Job000000256", "Job000000512"}
	if !reflect.DeepEqual(firstIDs, expected) || refreshes != 1 {
		t.Fatalf("wrong auth replay: %v refreshes=%d", firstIDs, refreshes)
	}
}
func TestStatusChunkCancellationStopsInFlightAndLaterChunks(t *testing.T) {
	second := make(chan struct{})
	var requests atomic.Int32
	setupAPIHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		jobs := readStatusBatch(t, r)
		if requests.Add(1) == 2 {
			close(second)
			<-r.Context().Done()
			return
		}
		writeStatusBatch(w, jobs)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	var acks []JobAck
	var err error
	go func() { defer close(done); acks, err = ReportStatus(ctx, statusInputs(600)) }()
	select {
	case <-second:
	case <-time.After(3 * time.Second):
		t.Fatal("second chunk did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled status request did not settle")
	}
	if !errors.Is(err, context.Canceled) || acks != nil || requests.Load() != 2 {
		t.Fatalf("cancellation changed: %v requests=%d", err, requests.Load())
	}
}
