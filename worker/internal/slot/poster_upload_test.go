package slot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"videosite-worker/internal/api"
	"videosite-worker/internal/auth"
	"videosite-worker/internal/config"
	"videosite-worker/internal/util"
	"videosite-worker/internal/worker/progress"
)

type posterTestUI struct {
	mu             sync.Mutex
	progressWrites int
}

func (*posterTestUI) StartJob(string, time.Time, []string, bool) {}
func (u *posterTestUI) bump()                                    { u.mu.Lock(); u.progressWrites++; u.mu.Unlock() }
func (u *posterTestUI) UpdateStage(string, string, int)          { u.bump() }
func (u *posterTestUI) LogStageBoundary(string, string, int)     { u.bump() }
func (u *posterTestUI) UpdateStageProgress(string, int)          { u.bump() }
func (u *posterTestUI) UpdateStageProgressVA(string, int, int)   { u.bump() }
func (u *posterTestUI) UpdateStageProgressVOnly(string, int)     { u.bump() }
func (*posterTestUI) FinishJob(string, string)                   {}
func (*posterTestUI) Logf(string, ...interface{})                {}
func (*posterTestUI) Write(p []byte) (int, error)                { return len(p), nil }
func (*posterTestUI) Close()                                     {}
func (u *posterTestUI) writes() int                              { u.mu.Lock(); defer u.mu.Unlock(); return u.progressWrites }

func testPosterJob(t *testing.T, handler func(http.ResponseWriter, *http.Request, string), customReady ...bool) *Job {
	t.Helper()
	t.Chdir(t.TempDir())
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/worker/tasks/poster-ready" && (len(customReady) == 0 || !customReady[0]) {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		handler(w, r, server.URL)
	}))
	t.Cleanup(server.Close)
	cfg := config.Config{SiteHostname: strings.TrimPrefix(server.URL, "http://"), ConcurrentUploads: 2, ConcurrentDownloads: 1}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile("config.json", data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Load(); err != nil {
		t.Fatal(err)
	}
	api.Init(nil, nil, false)
	session := auth.NewSession()
	if err := session.Refresh(context.Background(), func(context.Context) (string, error) { return "synthetic-only", nil }); err != nil {
		t.Fatal(err)
	}
	api.SetSession(session)
	t.Cleanup(func() { api.SetSession(nil) })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	j := &Job{JobID: "poster-fixture", ctx: ctx, cancel: cancel, tempDir: util.TempDir("poster-fixture"), outputDir: util.OutputDir("poster-fixture"), UI: &posterTestUI{}, Progress: progress.NewTracker(), hasPoster: true}
	j.phase.Store("transcoding")
	j.SetStage("processing", 23)
	j.Progress.Update(j.JobID, "processing", 23)
	if err := os.MkdirAll(j.outputDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(j.outputDir, "poster.jpg"), []byte("synthetic-jpeg"), 0600); err != nil {
		t.Fatal(err)
	}
	return j
}
func respondPosterURLs(t *testing.T, w http.ResponseWriter, r *http.Request, origin string, generation int) {
	t.Helper()
	var body struct {
		JobID     string   `json:"jobId"`
		Filenames []string `json:"filenames"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("decode: %v", err)
		http.Error(w, "bad", 400)
		return
	}
	urls := map[string]string{}
	for _, name := range body.Filenames {
		urls[name] = fmt.Sprintf("%s/put/%s?generation=%d", origin, name, generation)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"urls": urls})
}
func waitSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for fixture")
	}
}

func TestPosterUploadRunsWhileProcessingWithoutProgressOrDuplicatePUT(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var puts, media, complete atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		switch {
		case r.URL.Path == "/api/worker/tasks/upload-urls":
			respondPosterURLs(t, w, r, origin, 1)
		case r.URL.Path == "/put/poster.jpg":
			puts.Add(1)
			if r.Header.Get("Content-Type") != "image/jpeg" {
				t.Error("wrong poster content type")
			}
			io.Copy(io.Discard, r.Body)
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
			}
			w.WriteHeader(200)
		case r.URL.Path == "/put/media.m4s":
			media.Add(1)
			w.WriteHeader(200)
		case r.URL.Path == "/api/worker/tasks/complete":
			complete.Add(1)
			w.WriteHeader(204)
		default:
			http.NotFound(w, r)
		}
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	if err := os.WriteFile(filepath.Join(j.outputDir, "media.m4s"), []byte("synthetic-media"), 0600); err != nil {
		t.Fatal(err)
	}
	processingDone, returned := make(chan struct{}), make(chan struct{})
	var pipelineErr error
	go func() {
		defer close(returned)
		phase, err := runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { waitSignal(t, started); close(processingDone); return nil })
		if err != nil {
			pipelineErr = fmt.Errorf("%s: %w", phase, err)
			return
		}
		if err = j.upload(); err != nil {
			pipelineErr = err
			return
		}
		pipelineErr = api.CompleteTask(j.ctx, j.JobID, api.CompletePayload{HasPoster: j.hasPoster})
	}()
	waitSignal(t, processingDone)
	if stage, pct := j.currentReport(); stage != "processing" || pct != 23 {
		t.Fatalf("poster changed progress: %s %d", stage, pct)
	}
	if j.UI.(*posterTestUI).writes() != 0 || media.Load() != 0 || complete.Load() != 0 {
		t.Fatal("poster affected progress or allowed completion before upload")
	}
	select {
	case <-returned:
		t.Fatal("pipeline returned before blocked poster")
	default:
	}
	close(release)
	waitSignal(t, returned)
	if pipelineErr != nil {
		t.Fatal(pipelineErr)
	}
	if puts.Load() != 1 || media.Load() != 1 || complete.Load() != 1 {
		t.Fatalf("unexpected calls poster=%d media=%d complete=%d", puts.Load(), media.Load(), complete.Load())
	}
}

func TestPosterUsesOrdinaryUploadRetryAndRefreshPolicy(t *testing.T) {
	for _, tc := range []struct {
		name             string
		statuses         []int
		presigns, writes int
		wantErr          bool
	}{
		{"refresh403", []int{403, 200}, 2, 2, false},
		{"transient429and502", []int{429, 502, 200}, 1, 3, false},
		{"persistent400", []int{400}, 1, 1, true},
		{"exhausted503", []int{503, 503, 503, 503, 503, 503}, 1, 6, true},
		{"second403abandons", []int{403, 403}, 2, 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var presigns, writes atomic.Int32
			j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
				if r.URL.Path == "/api/worker/tasks/upload-urls" {
					respondPosterURLs(t, w, r, origin, int(presigns.Add(1)))
					return
				}
				n := int(writes.Add(1))
				if n > len(tc.statuses) {
					t.Error("exceeded retry budget")
					w.WriteHeader(500)
					return
				}
				w.WriteHeader(tc.statuses[n-1])
			})
			phase, err := runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { return nil })
			if phase != "upload" || (err != nil) != tc.wantErr {
				t.Fatalf("unexpected result %s %v", phase, err)
			}
			if int(presigns.Load()) != tc.presigns || int(writes.Load()) != tc.writes {
				t.Fatalf("unexpected attempts presigns=%d writes=%d", presigns.Load(), writes.Load())
			}
			if j.UI.(*posterTestUI).writes() != 0 {
				t.Fatal("poster wrote stage progress")
			}
		})
	}
}

func TestPosterJSONUploadURLFailuresUseSharedBackoff(t *testing.T) {
	for _, status := range []int{500, 200} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var presigns, puts atomic.Int32
			j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
				if r.URL.Path == "/api/worker/tasks/upload-urls" {
					if presigns.Add(1) == 1 {
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(status)
						json.NewEncoder(w).Encode(map[string]any{"error": "synthetic transient", "urls": map[string]string{}})
						return
					}
					respondPosterURLs(t, w, r, origin, 2)
					return
				}
				puts.Add(1)
				w.WriteHeader(200)
			})
			if err := j.uploadPoster(j.ctx); err != nil {
				t.Fatal(err)
			}
			if presigns.Load() != 2 || puts.Load() != 1 {
				t.Fatal("JSON API failure skipped URL retry or consumed a PUT attempt")
			}
		})
	}
}

func TestPosterJSONUploadURL404IsGoneWithoutPUTOrFailedReport(t *testing.T) {
	var presigns, puts atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		if r.URL.Path == "/api/worker/tasks/upload-urls" {
			presigns.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(map[string]string{"error": "Job not found"})
			return
		}
		puts.Add(1)
		w.WriteHeader(200)
	})
	j.Manager = &Manager{}
	phase, err := runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { return nil })
	if !errors.Is(err, api.ErrJobNotFound) || phase != "upload" {
		t.Fatalf("JSON404 became generic failure: %s %v", phase, err)
	}
	if j.handleError(phase, err) != nil || len(j.Manager.SnapshotStatuses()) != 0 {
		t.Fatal("gone job incorrectly queued a failed terminal report")
	}
	if presigns.Load() != 1 || puts.Load() != 0 {
		t.Fatalf("gone job attempted retries or PUTs: urls=%d puts=%d", presigns.Load(), puts.Load())
	}
}

func TestFailedExtractionPartialPosterIsNeverSwept(t *testing.T) {
	var poster, media atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		if r.URL.Path == "/api/worker/tasks/upload-urls" {
			respondPosterURLs(t, w, r, origin, 1)
			return
		}
		if r.URL.Path == "/put/poster.jpg" {
			poster.Add(1)
		} else {
			media.Add(1)
		}
		w.WriteHeader(200)
	})
	j.hasPoster = false
	if err := os.WriteFile(filepath.Join(j.outputDir, "media.m4s"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := j.upload(); err != nil {
		t.Fatal(err)
	}
	if poster.Load() != 0 || media.Load() != 1 {
		t.Fatal("partial poster leaked into final upload")
	}
}

func TestProcessingFailureCancelsAndJoinsBeforeCleanupOrReporting(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "poster.jpg")
	os.WriteFile(file, []byte("data"), 0600)
	started, cancelled, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	processingErr := errors.New("synthetic processing failure")
	var gotErr error
	var gotPhase string
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		defer close(returned)
		gotPhase, gotErr = runWithEarlyUpload(ctx, func(uploadCtx context.Context) error {
			close(started)
			<-uploadCtx.Done()
			close(cancelled)
			<-release
			if _, err := os.Stat(file); err != nil {
				t.Error("cleanup raced upload")
			}
			return uploadCtx.Err()
		}, func() error { <-started; return processingErr })
		os.RemoveAll(dir)
	}()
	waitSignal(t, cancelled)
	select {
	case <-returned:
		t.Fatal("reported failure/cleaned up before upload join")
	default:
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("poster removed before join")
	}
	if ctx.Err() != nil {
		t.Fatal("poster cancellation contaminated processing error classification")
	}
	close(release)
	waitSignal(t, returned)
	if gotPhase != "processing" || !errors.Is(gotErr, processingErr) {
		t.Fatalf("lost processing failure: %s %v", gotPhase, gotErr)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("cleanup did not run after join")
	}
}

func TestJobCancellationJoinsBlockedHTTPPoster(t *testing.T) {
	started := make(chan struct{})
	var puts atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		if r.URL.Path == "/api/worker/tasks/upload-urls" {
			respondPosterURLs(t, w, r, origin, 1)
			return
		}
		puts.Add(1)
		io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
	})
	returned := make(chan struct{})
	var result error
	go func() {
		defer close(returned)
		_, result = runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { <-started; <-j.ctx.Done(); return j.ctx.Err() })
	}()
	waitSignal(t, started)
	j.Cancel()
	waitSignal(t, returned)
	if !errors.Is(result, context.Canceled) || puts.Load() != 1 {
		t.Fatalf("unexpected cancellation %v calls=%d", result, puts.Load())
	}
}

func TestProcessingPanicStillJoinsPoster(t *testing.T) {
	started, finished := make(chan struct{}), make(chan struct{})
	recovered := false
	func() {
		defer func() {
			if recover() != nil {
				recovered = true
			}
			select {
			case <-finished:
			default:
				t.Error("panic escaped before upload joined")
			}
		}()
		runWithEarlyUpload(context.Background(), func(ctx context.Context) error { close(started); <-ctx.Done(); close(finished); return ctx.Err() }, func() error { <-started; panic("synthetic") })
	}()
	if !recovered {
		t.Fatal("processing panic was swallowed")
	}
}

func TestPosterUploadFailureRetainsOrdinaryFailedClassification(t *testing.T) {
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		if r.URL.Path == "/api/worker/tasks/upload-urls" {
			respondPosterURLs(t, w, r, origin, 1)
			return
		}
		w.WriteHeader(400)
	})
	j.Manager = &Manager{}
	phase, err := runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { return nil })
	if err == nil || phase != "upload" {
		t.Fatalf("expected upload failure: %s %v", phase, err)
	}
	if j.ctx.Err() != nil {
		t.Fatal("poster completion cancelled the job context")
	}
	if j.handleError(phase, err) == nil {
		t.Fatal("persistent poster upload incorrectly succeeded")
	}
	reports := j.Manager.SnapshotStatuses()
	if len(reports) != 1 || reports[0].Status != "failed" {
		t.Fatalf("wrong normal upload failure policy: %+v", reports)
	}
}

func TestEarlyAndMediaPresignRequestsRemainSerial(t *testing.T) {
	first, release, second := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var requests, active, overlap atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		n := requests.Add(1)
		if active.Add(1) > 1 {
			overlap.Add(1)
		}
		defer active.Add(-1)
		if n == 1 {
			close(first)
			<-release
		} else {
			close(second)
		}
		respondPosterURLs(t, w, r, origin, int(n))
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	done := make(chan error, 2)
	go func() { _, err := api.GetUploadURLsLocked(j.ctx, j.JobID, []string{"poster.jpg"}); done <- err }()
	waitSignal(t, first)
	go func() { _, err := api.GetUploadURLsLocked(j.ctx, j.JobID, []string{"media.m4s"}); done <- err }()
	select {
	case <-second:
		t.Fatal("presign requests overlapped")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	for i := 0; i < 2; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("presign did not settle")
		}
	}
	if requests.Load() != 2 || overlap.Load() != 0 {
		t.Fatal("single in-flight presign policy changed")
	}
}

func TestPosterReadinessRetryDoesNotRepeatConfirmedPUT(t *testing.T) {
	for _, lostReply := range []bool{false, true} {
		t.Run(fmt.Sprintf("lostReply=%t", lostReply), func(t *testing.T) {
			var presigns, puts, acks atomic.Int32
			var stored atomic.Bool
			j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
				switch r.URL.Path {
				case "/api/worker/tasks/upload-urls":
					presigns.Add(1)
					respondPosterURLs(t, w, r, origin, 1)
				case "/put/poster.jpg":
					puts.Add(1)
					stored.Store(true)
					w.WriteHeader(200)
				case "/api/worker/tasks/poster-ready":
					if !stored.Load() {
						t.Error("readiness reported before PUT success")
					}
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body) != 1 || body["jobId"] != "poster-fixture" {
						t.Error("readiness body must bind exact job")
					}
					if r.Method != http.MethodPost {
						t.Error("readiness used wrong method")
					}
					if acks.Add(1) == 1 {
						if lostReply {
							conn, _, err := w.(http.Hijacker).Hijack()
							if err != nil {
								t.Error(err)
								return
							}
							conn.Close()
							return
						}
						w.WriteHeader(503)
						return
					}
					w.WriteHeader(204)
				default:
					http.NotFound(w, r)
				}
			}, true)
			if err := j.uploadPoster(j.ctx); err != nil {
				t.Fatal(err)
			}
			if presigns.Load() != 1 || puts.Load() != 1 || acks.Load() != 2 {
				t.Fatalf("ack retry repeated upload: urls=%d puts=%d acks=%d", presigns.Load(), puts.Load(), acks.Load())
			}
			if j.UI.(*posterTestUI).writes() != 0 {
				t.Fatal("readiness retry overwrote transcode progress")
			}
		})
	}
}

func TestPosterReadinessGoneStopsWithoutAnotherPUTOrCompletion(t *testing.T) {
	var puts, acks atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		switch r.URL.Path {
		case "/api/worker/tasks/upload-urls":
			respondPosterURLs(t, w, r, origin, 1)
		case "/put/poster.jpg":
			puts.Add(1)
			w.WriteHeader(200)
		case "/api/worker/tasks/poster-ready":
			acks.Add(1)
			w.WriteHeader(404)
		default:
			t.Error("unexpected request after gone job")
			http.NotFound(w, r)
		}
	}, true)
	j.Manager = &Manager{}
	phase, err := runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { return nil })
	if !errors.Is(err, api.ErrJobNotFound) || phase != "upload" {
		t.Fatalf("gone job lost: %s %v", phase, err)
	}
	if j.handleError(phase, err) != nil || len(j.Manager.SnapshotStatuses()) != 0 {
		t.Fatal("gone job was reported as a new failure")
	}
	if puts.Load() != 1 || acks.Load() != 1 {
		t.Fatal("gone job retried")
	}
}

func TestPosterReadinessCancellationDoesNotRestartPUT(t *testing.T) {
	firstAck := make(chan struct{})
	var puts, acks atomic.Int32
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		switch r.URL.Path {
		case "/api/worker/tasks/upload-urls":
			respondPosterURLs(t, w, r, origin, 1)
		case "/put/poster.jpg":
			puts.Add(1)
			w.WriteHeader(200)
		case "/api/worker/tasks/poster-ready":
			if acks.Add(1) == 1 {
				close(firstAck)
			}
			w.WriteHeader(503)
		default:
			http.NotFound(w, r)
		}
	}, true)
	done := make(chan struct{})
	var result error
	go func() { defer close(done); result = j.uploadPoster(j.ctx) }()
	waitSignal(t, firstAck)
	j.Cancel()
	waitSignal(t, done)
	if !errors.Is(result, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", result)
	}
	if puts.Load() != 1 || acks.Load() != 1 {
		t.Fatal("cancelled readiness retried upload or ack")
	}
}

func TestProcessingContinuesWhilePosterReadinessWaits(t *testing.T) {
	ackStarted, release, processed, returned := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	j := testPosterJob(t, func(w http.ResponseWriter, r *http.Request, origin string) {
		switch r.URL.Path {
		case "/api/worker/tasks/upload-urls":
			respondPosterURLs(t, w, r, origin, 1)
		case "/put/poster.jpg":
			w.WriteHeader(200)
		case "/api/worker/tasks/poster-ready":
			close(ackStarted)
			select {
			case <-release:
			case <-r.Context().Done():
			}
			w.WriteHeader(204)
		default:
			http.NotFound(w, r)
		}
	}, true)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	var result error
	go func() {
		defer close(returned)
		_, result = runWithEarlyUpload(j.ctx, j.uploadPoster, func() error { <-ackStarted; close(processed); return nil })
	}()
	waitSignal(t, processed)
	select {
	case <-returned:
		t.Fatal("readiness was not awaited before completion")
	default:
	}
	if stage, pct := j.currentReport(); stage != "processing" || pct != 23 {
		t.Fatal("readiness overwrote processing stage")
	}
	close(release)
	waitSignal(t, returned)
	if result != nil {
		t.Fatal(result)
	}
}
