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

// Worker is the main transcoding worker.
type Worker struct {
	manager   *slot.Manager
	tracker   *progress.Tracker
	blocklist *ErrorBlocklist
	wg        sync.WaitGroup
	ctx       context.Context
	cancel    context.CancelFunc
	stopping  atomic.Bool

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

	// Main poll loop
	ticker := time.NewTicker(5 * time.Second)
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

func (w *Worker) poll() {
	if w.stopping.Load() {
		return // Don't pick up new work during shutdown
	}

	if !w.manager.HasFreeSlot() {
		return
	}

	// Quick FFmpeg availability check before polling for work
	if err := transcoder.DetectFFmpeg(); err != nil {
		w.handleFFmpegMissing()
		return
	}

	// Check for available task
	result, err := api.CheckAvailable(w.ctx)
	if err != nil {
		if errors.Is(err, api.ErrAuthFailed) {
			w.handleAuthFailure()
			return
		}
		slog.Debug("Poll error", "err", err)
		return
	}

	if !result.HasAvailableTask {
		return
	}

	// Check blocklist
	if w.blocklist.IsBlocked(result.VideoID) {
		slog.Debug("Skipping blocked video", "video", result.VideoID)
		return
	}

	// Lease the task
	lease, err := api.Lease(w.ctx, result.VideoID)
	if err != nil {
		if errors.Is(err, api.ErrAuthFailed) {
			w.handleAuthFailure()
			return
		}
		slog.Warn("Lease failed", "video", result.VideoID, "err", err)
		return
	}

	if !lease.IsLeaseSuccess {
		slog.Debug("Lease not successful (task may have been taken)", "video", result.VideoID)
		return
	}

	// Acquire a slot — this marks the job as active and selects the preferred encoder.
	// The full Encoder (type + device index) is passed into the job so FFmpeg
	// can target the correct GPU for both decode and encode.
	encoder, err := w.manager.AcquireSlot(lease.JobID, nil)
	if err != nil {
		slog.Warn("No slot available", "err", err)
		return
	}

	slog.Info("Launching job", "job", lease.JobID, "video", result.VideoID,
		"encoder", encoder.EncoderType, "device", encoder.DeviceIndex)

	job := slot.NewJob(lease.JobID, result.VideoID, lease.DownloadURL, lease.EncryptionKey, encoder, w.manager, w.tracker)
	w.manager.RegisterJob(lease.JobID, job)

	w.wg.Add(1)
	go func() {
		defer w.wg.Done()

		if err := job.Run(); err != nil {
			// Check if FFmpeg binary went missing — fatal, shut down the worker
			if errors.Is(err, slot.ErrFFmpegFatal) {
				w.handleFFmpegMissing()
				return
			}

			w.blocklist.Add(result.VideoID)
			slog.Error("Job failed, video blocked", "job", lease.JobID, "video", result.VideoID, "err", err)
		}
	}()
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

	configChanges, err := config.Reload()
	if err != nil {
		fmt.Printf("%s Config reload error: %s\n", util.Ts(), err)
	} else {
		fmt.Printf("%s Config: %s\n", util.Ts(), configChanges)
	}

	capsChanges, err := config.ReloadCapabilities()
	if err != nil {
		fmt.Printf("%s Capabilities reload error: %s\n", util.Ts(), err)
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
