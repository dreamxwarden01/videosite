package worker

import (
	"bufio"
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"videosite-worker/internal/api"
	"videosite-worker/internal/config"
	"videosite-worker/internal/slot"
	"videosite-worker/internal/transcoder"
	"videosite-worker/internal/ui"
	"videosite-worker/internal/util"
	"videosite-worker/internal/worker/progress"
)

// pollInterval is the cadence of the lease-polling main loop.
// Kept at 5 s so idle workers don't hammer /tasks/available.
const pollInterval = 5 * time.Second

// statusInterval is the cadence of the batched /tasks/status reporter.
const statusInterval = 2 * time.Second

// statusSilenceAbort is how long the status loop tolerates consecutive failures
// before giving up on the in-flight jobs. Kills all ffmpeg processes, resets
// the slot count, and returns control to the polling loop. 60 s as a real
// wall-clock window (not a tick count) — ticks drift under CPU pressure.
const statusSilenceAbort = 60 * time.Second

// Worker is the main transcoding worker.
type Worker struct {
	manager   *slot.Manager
	tracker   *progress.Tracker
	blocklist *ErrorBlocklist
	ui        ui.Manager // user-visible output (sticky bars + scrolling log)
	wg        sync.WaitGroup
	ctx       context.Context
	cancel    context.CancelFunc
	stopping  atomic.Bool

	// statusOnce guards lazy startup of the status loop: we only need it
	// once the first job is running. Subsequent leases find it already live.
	statusOnce sync.Once
}

// New creates a new worker. uiMgr is the shared output surface — must be
// non-nil; main.go constructs it once and passes the same instance here.
// Close of uiMgr is the caller's responsibility (main.go defers it) so the
// manager outlives any straggler log lines from the Worker.shutdown path.
func New(uiMgr ui.Manager) *Worker {
	ctx, cancel := context.WithCancel(context.Background())
	return &Worker{
		manager:   slot.NewManager(),
		tracker:   progress.NewTracker(),
		blocklist: NewErrorBlocklist(),
		ui:        uiMgr,
		ctx:       ctx,
		cancel:    cancel,
	}
}

// Run starts the worker's main loop with polling and console command handling.
func (w *Worker) Run() {
	logArgs := []any{
		"slots", w.manager.TotalSlots(),
		"hostname", config.Get().SiteHostname,
	}
	for k, v := range platformRegistrationMeta() {
		logArgs = append(logArgs, k, v)
	}
	slog.Info("Worker started", logArgs...)
	w.ui.Logf("Commands: stop, reload")

	// Start console command reader
	go w.readConsoleCommands()

	// First-poll warm-up: 1s rather than the full pollInterval. The
	// previous behaviour was a 5s wait between "Worker started" and the
	// first /tasks/available request, which felt unresponsive on a freshly
	// launched worker (the user just saw the startup banner sit there).
	// 1s leaves the banner readable for a beat — long enough that the
	// startup output isn't immediately scrolled by lease activity, short
	// enough that idle workers pick up queued work promptly. ctx-aware so
	// a fast Ctrl-C during the warm-up exits cleanly.
	select {
	case <-w.ctx.Done():
		w.shutdown()
		return
	case <-time.After(1 * time.Second):
		w.poll()
	}

	// Main poll loop (lease cadence)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-w.ctx.Done():
			w.shutdown()
			return
		case <-ticker.C:
			w.poll()
		}
	}
}

// poll runs one iteration of the lease-polling main loop. If there are free
// slots and the server has queued work, it reserves (atomic queued→pending)
// and then leases (atomic pending→processing) up to the available count.
func (w *Worker) poll() {
	if w.stopping.Load() {
		return // Don't pick up new work during shutdown
	}

	free := w.manager.FreeSlots()
	if free <= 0 {
		return
	}

	// Quick FFmpeg availability check before polling for work
	if err := transcoder.DetectFFmpeg(); err != nil {
		w.handleFFmpegMissing()
		return
	}

	// 1. Reserve up to `free` tasks (server flips queued→pending atomically).
	videoIDs, err := api.AvailableTasks(w.ctx, free)
	if err != nil {
		if errors.Is(err, api.ErrCertFatal) {
			w.handleCertFatal(err)
			return
		}
		if errors.Is(err, api.ErrAuthFailed) {
			w.handleAuthFailure()
			return
		}
		slog.Debug("AvailableTasks error", "err", err)
		return
	}
	if len(videoIDs) == 0 {
		return
	}

	// Blocklist filter: skip videos the worker has previously failed to process.
	// Reserving them was harmless — server hold expires in 10 s.
	filtered := videoIDs[:0]
	for _, vid := range videoIDs {
		if w.blocklist.IsBlocked(vid) {
			slog.Debug("Skipping blocked video", "video", vid)
			continue
		}
		filtered = append(filtered, vid)
	}
	if len(filtered) == 0 {
		return
	}

	// 2. Lease the reserved tasks (pending→processing, server assigns jobId).
	results, err := api.LeaseTasks(w.ctx, filtered)
	if err != nil {
		if errors.Is(err, api.ErrCertFatal) {
			w.handleCertFatal(err)
			return
		}
		if errors.Is(err, api.ErrAuthFailed) {
			w.handleAuthFailure()
			return
		}
		slog.Warn("LeaseTasks failed", "err", err)
		return
	}

	// 3. Start one goroutine per successfully leased task.
	for _, r := range results {
		if r.Status != "leased" {
			slog.Debug("Lease did not succeed", "video", r.VideoID, "status", r.Status)
			continue
		}
		w.launchJob(r)
	}
}

// launchJob acquires a slot and starts the job goroutine for a leased task.
// The first successful launch lazily starts the status-reporting loop.
func (w *Worker) launchJob(r api.LeaseResult) {
	// Acquire a slot — this marks the job as active and selects the preferred encoder.
	encoder, err := w.manager.AcquireSlot(r.JobID, nil)
	if err != nil {
		slog.Warn("No slot available despite lease", "job", r.JobID, "err", err)
		// Queue an aborted status so the server can requeue promptly rather
		// than waiting for its own processing-timeout.
		w.manager.RecordTerminal(api.JobStatus{
			JobID:        r.JobID,
			Status:       "aborted",
			ErrorMessage: "no slot available",
		})
		return
	}

	slog.Info("Launching job", "job", r.JobID, "video", r.VideoID,
		"encoder", encoder.EncoderType, "device", encoder.DeviceIndex)

	job := slot.NewJob(r.JobID, r.VideoID, r.DownloadURL, r.AudioBitrateKbps, encoder, w.manager, w.tracker, w.ui,
		r.OutputProfiles, r.AudioNormalization, r.AudioNormalizationTarget, r.AudioNormalizationPeak, r.AudioNormalizationMaxGain)
	w.manager.RegisterJob(r.JobID, job)

	// Lazily start the status loop on the first job we accept.
	w.statusOnce.Do(func() {
		go w.statusLoop()
	})

	videoID := r.VideoID
	jobID := r.JobID
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()

		if err := job.Run(); err != nil {
			// FFmpeg binary went missing — fatal, shut down the worker.
			if errors.Is(err, slot.ErrFFmpegFatal) {
				w.handleFFmpegMissing()
				return
			}
			// mTLS cert became invalid mid-job (via an API call the job
			// made — e.g. reporting a segment, fetching upload URLs).
			// Nothing the worker can do until it's restarted.
			if errors.Is(err, api.ErrCertFatal) {
				w.handleCertFatal(err)
				return
			}
			w.blocklist.Add(videoID)
			slog.Error("Job failed, video blocked", "job", jobID, "video", videoID, "err", err)
		}
	}()
}

// statusLoop is the 2-second batched /tasks/status reporter.
//
// It runs for the lifetime of the worker once started (lazy via statusOnce).
// On each tick:
//   - Collect per-job "running" entries + queued terminal statuses via SnapshotStatuses.
//   - POST them in a single batch.
//   - Drop any jobs the server ack:false'd (unknown to server anymore).
//   - Track wall-clock time since last 2xx response. After 60 s of silence,
//     abort every active job locally so ffmpeg processes stop eating CPU
//     while the server believes they've been requeued by its own timeout.
func (w *Worker) statusLoop() {
	ticker := time.NewTicker(statusInterval)
	defer ticker.Stop()

	lastSuccess := time.Now()
	aborted := false // true once we've triggered AbortAll this silence window

	for {
		select {
		case <-w.ctx.Done():
			return
		case <-ticker.C:
		}

		jobs := w.manager.SnapshotStatuses()
		if len(jobs) == 0 {
			// No in-flight work to report. Keep the silence timer fresh so
			// a long idle stretch doesn't look like a server outage.
			lastSuccess = time.Now()
			aborted = false
			continue
		}

		// Per-request timeout: shorter than the status interval so a hanging
		// server doesn't stall the next tick.
		reqCtx, cancel := context.WithTimeout(w.ctx, 10*time.Second)
		acks, err := api.ReportStatus(reqCtx, jobs)
		cancel()

		if err != nil {
			if errors.Is(err, api.ErrCertFatal) {
				w.handleCertFatal(err)
				return
			}
			if errors.Is(err, api.ErrAuthFailed) {
				w.handleAuthFailure()
				return
			}
			// Any other error counts as silence. Retry next tick.
			if !aborted && time.Since(lastSuccess) >= statusSilenceAbort {
				slog.Warn("Status reporting silent for 60s — aborting active jobs",
					"silent", time.Since(lastSuccess).Truncate(time.Second))
				w.manager.AbortAll("status silence")
				aborted = true
			}
			continue
		}

		lastSuccess = time.Now()
		aborted = false

		// Drop any jobs the server no longer recognises — HandleAcks cancels
		// them so their goroutines exit and slots free up.
		w.manager.HandleAcks(acks)
	}
}

func (w *Worker) readConsoleCommands() {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		cmd := strings.TrimSpace(scanner.Text())
		switch strings.ToLower(cmd) {
		case "stop":
			w.ui.Logf("Graceful stop requested...")
			w.stopping.Store(true)
			w.initiateGracefulStop()
			return
		case "reload":
			w.handleReload()
		case "":
			// Ignore empty lines
		default:
			w.ui.Logf("Unknown command: %s (available: stop, reload)", cmd)
		}
	}
}

// GracefulStop is the public entry point for graceful shutdown (used by SIGINT handler).
func (w *Worker) GracefulStop() {
	if w.stopping.Swap(true) {
		return // Already stopping
	}
	w.initiateGracefulStop()
}

// initiateGracefulStop cancels non-uploading jobs, then exits the poll loop.
// shutdown() (called from the main loop on ctx cancellation) handles the
// single wg.Wait() for any uploading/completing jobs that were left running.
func (w *Worker) initiateGracefulStop() {
	activeJobs := w.manager.ActiveJobs()

	if len(activeJobs) == 0 {
		w.ui.Logf("No active jobs. Stopping immediately.")
	} else {
		// Cancel non-uploading jobs immediately; uploading/completing jobs
		// are left running — shutdown() will wait up to 30s for them.
		for _, job := range activeJobs {
			phase := job.Phase()
			if phase == "uploading" || phase == "completing" {
				w.ui.Logf("  Waiting for job %s (phase: %s)", job.JobID, phase)
			} else {
				w.ui.Logf("  Aborting job %s (phase: %s)", job.JobID, phase)
				job.Cancel()
			}
		}
	}

	w.cancel() // exit the poll loop; shutdown() waits for remaining jobs
}

func (w *Worker) handleReload() {
	w.ui.Logf("Reloading configuration...")

	result, err := config.Reload()
	if err != nil {
		// Unreadable/corrupt config.json: keep running on the previous
		// in-memory values. The user's changes stay on disk until they
		// fix the file.
		w.ui.Logf("Config reload error (keeping previous values): %s", err)
	} else {
		w.ui.Logf("Config: %s", result.Summary)
		for _, f := range result.InvalidFields {
			w.ui.Logf("  ! %s", f)
		}

		// site_hostname and enable_mtls are locked — config.Reload has
		// already reverted them in memory, so we only need to warn the user
		// that the on-disk change will take effect after a restart.
		if result.HostnameChanged {
			w.ui.Logf("  ! site_hostname change detected — restart worker to apply. Value reverted in memory.")
		}
		if result.MTLSChanged {
			w.ui.Logf("  ! enable_mtls change detected — restart worker to apply. Value reverted in memory.")
		}

		// Proxy toggle: rebuild the HTTP client transport. Any in-flight
		// requests on the old transport drain naturally; retries use the new.
		if result.ProxyChanged {
			api.Reconfigure(config.Get().UseSystemProxy)
			w.ui.Logf("  HTTP client rebuilt (use_system_proxies=%v)", config.Get().UseSystemProxy)
		}

		if result.KeysChanged {
			// No explicit action needed — config.Get() is what Authenticate reads.
			// Any future 401 will re-auth with the new credentials.
			w.ui.Logf("  Access keys updated — applied on next re-auth.")
		}

		if result.ConcurrencyChanged {
			// util.DynamicGate reads config.Get() on each Acquire, so the
			// next part download / upload picks up the new value. No
			// plumbing needed — just surface the fact in the log.
			w.ui.Logf("  Concurrency limits applied to new operations (in-flight ones finish on old limit).")
		}
	}

	capsChanges, err := config.ReloadCapabilities()
	if err != nil {
		w.ui.Logf("Capabilities reload error (keeping previous values): %s", err)
	} else {
		w.ui.Logf("Capabilities: %s", capsChanges)
	}

	w.manager.Reload()
	w.ui.Logf("Slots: %d total", w.manager.TotalSlots())
	w.ui.Logf("Reload complete. Active jobs continue with original settings.")
}

func (w *Worker) handleFFmpegMissing() {
	if w.stopping.Swap(true) {
		return // another goroutine already handling this
	}
	w.ui.Logf("==========================================================")
	w.ui.Logf("FATAL: FFmpeg binary not found or not executable.")
	w.ui.Logf("FFmpeg may have been uninstalled or removed from PATH.")
	w.ui.Logf("Jobs in download/probe/transcode are being aborted.")
	w.ui.Logf("Jobs already uploading will be allowed to finish.")
	w.ui.Logf("Please reinstall FFmpeg, verify your PATH, and restart.")
	w.ui.Logf("==========================================================")
	// Jobs that need FFmpeg can't proceed — cancel them.
	// Jobs already in upload/complete don't need FFmpeg — let them finish.
	// shutdown() will wait up to 30s for any remaining uploading jobs.
	for _, job := range w.manager.ActiveJobs() {
		phase := job.Phase()
		if phase != "uploading" && phase != "completing" {
			job.Cancel()
		}
	}
	w.cancel() // exit poll loop
}

// handleCertFatal is invoked when api.ErrCertFatal bubbles up from any API
// call — i.e. the in-memory leaf cert's NotBefore/NotAfter window has been
// violated, or the server returned 403 and a re-check confirmed the cert is
// outside its validity window. Nothing the worker can do locally fixes this
// (the cert is immutable for the process lifetime), so we shut down cleanly
// and let the operator renew the cert before restarting.
//
// Uploading/completing jobs are allowed to finish — they need R2, not our
// worker-API cert — while download/probe/transcode jobs are cancelled so
// they don't keep hitting the same fatal error.
func (w *Worker) handleCertFatal(err error) {
	if w.stopping.Swap(true) {
		return // another goroutine already handling this
	}
	w.ui.Logf("==========================================================")
	w.ui.Logf("FATAL: mTLS client certificate invalid.")
	w.ui.Logf("%s", err)
	w.ui.Logf("Renew cert/client.crt and restart the worker.")
	w.ui.Logf("==========================================================")

	for _, job := range w.manager.ActiveJobs() {
		phase := job.Phase()
		if phase != "uploading" && phase != "completing" {
			job.Cancel()
		}
	}
	w.cancel() // exit poll loop
}

// handleAuthFailure is reached only when re-auth itself returned 401 —
// the shared Session already tried to renew and got a second 401, which
// means the key has been revoked or rotated. Shut the worker down.
func (w *Worker) handleAuthFailure() {
	if w.stopping.Swap(true) {
		return // another goroutine already handling this
	}
	w.ui.Logf("==========================================================")
	w.ui.Logf("AUTHENTICATION FAILED — worker key may have been revoked.")
	w.ui.Logf("Please check your credentials and restart.")
	w.ui.Logf("==========================================================")
	// Auth is revoked — all server API calls will fail (401).
	// Cancel every active job immediately; no point continuing.
	for _, job := range w.manager.ActiveJobs() {
		job.Cancel()
	}
	w.cancel() // exit poll loop
}

func (w *Worker) shutdown() {
	w.ui.Logf("Shutting down... waiting for active jobs")

	// Wait for active jobs with 30-second timeout
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		slog.Info("All jobs completed")
	case <-time.After(30 * time.Second):
		slog.Warn("Shutdown timeout — some jobs may not have completed")
	}

	// Final status flush: w.ctx is already cancelled by the time we get here,
	// so the status loop exited without reporting the aborted/failed entries
	// that accumulated during the shutdown window. Push them now with a fresh
	// context so the server can requeue / mark-failed immediately instead of
	// waiting for its own processing-timeout.
	w.flushShutdownStatuses()

	// Cleanup temp directories
	util.CleanupAllTemp()

	// Clean the logs directory. Logs are only needed while errors are being
	// investigated; on a clean shutdown they are removed so the next run
	// starts fresh. Any logs worth keeping should be copied out beforehand.
	if err := os.RemoveAll(slot.LogsDir); err != nil {
		slog.Warn("Failed to clean logs directory", "err", err)
	} else {
		w.ui.Logf("Logs cleaned.")
	}

	w.ui.Logf("Worker stopped.")
}

// flushShutdownStatuses pushes any queued terminal statuses (aborted/failed)
// that accumulated during shutdown. The regular status loop exits on
// w.ctx.Done before it can report them, so we send one final batch here
// with a detached 10 s context. Without this, the server waits out its own
// processing-timeout before requeueing jobs the worker already gave up on.
func (w *Worker) flushShutdownStatuses() {
	statuses := w.manager.SnapshotStatuses()
	if len(statuses) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := api.ReportStatus(ctx, statuses); err != nil {
		slog.Warn("Final status flush failed", "err", err, "count", len(statuses))
		return
	}
	slog.Info("Final status flush sent", "count", len(statuses))
}
