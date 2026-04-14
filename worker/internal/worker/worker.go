package worker

import (
	"bufio"
	"context"
	"errors"
	"fmt"
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
	"videosite-worker/internal/util"
	"videosite-worker/internal/worker/progress"
)

// pollInterval is the cadence of the lease-polling main loop.
// Kept at 5 s so idle workers don't hammer /tasks/available.
const pollInterval = 5 * time.Second

// statusInterval is the cadence of the batched /task/status reporter.
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
	wg        sync.WaitGroup
	ctx       context.Context
	cancel    context.CancelFunc
	stopping  atomic.Bool

	// statusOnce guards lazy startup of the status loop: we only need it
	// once the first job is running. Subsequent leases find it already live.
	statusOnce sync.Once
}

// New creates a new worker.
func New() *Worker {
	ctx, cancel := context.WithCancel(context.Background())
	return &Worker{
		manager:   slot.NewManager(),
		tracker:   progress.NewTracker(),
		blocklist: NewErrorBlocklist(),
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
	fmt.Printf("%s Commands: stop, reload\n", util.Ts())
	fmt.Println()

	// Start console command reader
	go w.readConsoleCommands()

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

	job := slot.NewJob(r.JobID, r.VideoID, r.DownloadURL, r.EncryptionKey, encoder, w.manager, w.tracker,
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

// statusLoop is the 2-second batched /task/status reporter.
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
			fmt.Printf("%s Graceful stop requested...\n", util.Ts())
			w.stopping.Store(true)
			w.initiateGracefulStop()
			return
		case "reload":
			w.handleReload()
		case "":
			// Ignore empty lines
		default:
			fmt.Printf("%s Unknown command: %s (available: stop, reload)\n", util.Ts(), cmd)
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
		fmt.Printf("%s No active jobs. Stopping immediately.\n", util.Ts())
	} else {
		// Cancel non-uploading jobs immediately; uploading/completing jobs
		// are left running — shutdown() will wait up to 30s for them.
		for _, job := range activeJobs {
			phase := job.Phase()
			if phase == "uploading" || phase == "completing" {
				fmt.Printf("%s   Waiting for job %s (phase: %s)\n", util.Ts(), job.JobID, phase)
			} else {
				fmt.Printf("%s   Aborting job %s (phase: %s)\n", util.Ts(), job.JobID, phase)
				job.Cancel()
			}
		}
	}

	w.cancel() // exit the poll loop; shutdown() waits for remaining jobs
}

func (w *Worker) handleReload() {
	fmt.Printf("%s Reloading configuration...\n", util.Ts())

	result, err := config.Reload()
	if err != nil {
		// Unreadable/corrupt config.json: keep running on the previous
		// in-memory values. The user's changes stay on disk until they
		// fix the file.
		fmt.Printf("%s Config reload error (keeping previous values): %s\n", util.Ts(), err)
	} else {
		fmt.Printf("%s Config: %s\n", util.Ts(), result.Summary)
		for _, f := range result.InvalidFields {
			fmt.Printf("%s   ! %s\n", util.Ts(), f)
		}

		// site_hostname and enable_mtls are locked — config.Reload has
		// already reverted them in memory, so we only need to warn the user
		// that the on-disk change will take effect after a restart.
		if result.HostnameChanged {
			fmt.Printf("%s   ! site_hostname change detected — restart worker to apply. Value reverted in memory.\n", util.Ts())
		}
		if result.MTLSChanged {
			fmt.Printf("%s   ! enable_mtls change detected — restart worker to apply. Value reverted in memory.\n", util.Ts())
		}

		// Proxy toggle: rebuild the HTTP client transport. Any in-flight
		// requests on the old transport drain naturally; retries use the new.
		if result.ProxyChanged {
			api.Reconfigure(config.Get().UseSystemProxy)
			fmt.Printf("%s   HTTP client rebuilt (use_system_proxies=%v)\n", util.Ts(), config.Get().UseSystemProxy)
		}

		if result.KeysChanged {
			// No explicit action needed — config.Get() is what Authenticate reads.
			// Any future 401 will re-auth with the new credentials.
			fmt.Printf("%s   Access keys updated — applied on next re-auth.\n", util.Ts())
		}

		if result.ConcurrencyChanged {
			// util.DynamicGate reads config.Get() on each Acquire, so the
			// next part download / upload picks up the new value. No
			// plumbing needed — just surface the fact in the log.
			fmt.Printf("%s   Concurrency limits applied to new operations (in-flight ones finish on old limit).\n", util.Ts())
		}
	}

	capsChanges, err := config.ReloadCapabilities()
	if err != nil {
		fmt.Printf("%s Capabilities reload error (keeping previous values): %s\n", util.Ts(), err)
	} else {
		fmt.Printf("%s Capabilities: %s\n", util.Ts(), capsChanges)
	}

	w.manager.Reload()
	fmt.Printf("%s Slots: %d total\n", util.Ts(), w.manager.TotalSlots())
	fmt.Printf("%s Reload complete. Active jobs continue with original settings.\n", util.Ts())
}

func (w *Worker) handleFFmpegMissing() {
	if w.stopping.Swap(true) {
		return // another goroutine already handling this
	}
	fmt.Println()
	fmt.Printf("%s ==========================================================\n", util.Ts())
	fmt.Printf("%s FATAL: FFmpeg binary not found or not executable.\n", util.Ts())
	fmt.Printf("%s FFmpeg may have been uninstalled or removed from PATH.\n", util.Ts())
	fmt.Println()
	fmt.Printf("%s Jobs in download/probe/transcode are being aborted.\n", util.Ts())
	fmt.Printf("%s Jobs already uploading will be allowed to finish.\n", util.Ts())
	fmt.Println()
	fmt.Printf("%s Please reinstall FFmpeg, verify your PATH, and restart.\n", util.Ts())
	fmt.Printf("%s ==========================================================\n", util.Ts())
	fmt.Println()
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
	fmt.Println()
	fmt.Printf("%s ==========================================================\n", util.Ts())
	fmt.Printf("%s FATAL: mTLS client certificate invalid.\n", util.Ts())
	fmt.Printf("%s %s\n", util.Ts(), err)
	fmt.Println()
	fmt.Printf("%s Renew cert/client.crt and restart the worker.\n", util.Ts())
	fmt.Printf("%s ==========================================================\n", util.Ts())
	fmt.Println()

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
	fmt.Println()
	fmt.Printf("%s ==========================================================\n", util.Ts())
	fmt.Printf("%s AUTHENTICATION FAILED — worker key may have been revoked.\n", util.Ts())
	fmt.Printf("%s Please check your credentials and restart.\n", util.Ts())
	fmt.Printf("%s ==========================================================\n", util.Ts())
	fmt.Println()
	// Auth is revoked — all server API calls will fail (401).
	// Cancel every active job immediately; no point continuing.
	for _, job := range w.manager.ActiveJobs() {
		job.Cancel()
	}
	w.cancel() // exit poll loop
}

func (w *Worker) shutdown() {
	fmt.Printf("%s Shutting down... waiting for active jobs\n", util.Ts())

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
		fmt.Printf("%s Logs cleaned.\n", util.Ts())
	}

	fmt.Printf("%s Worker stopped.\n", util.Ts())
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
