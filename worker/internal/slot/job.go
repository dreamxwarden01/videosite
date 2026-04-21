package slot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"videosite-worker/internal/api"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
	"videosite-worker/internal/transcoder"
	"videosite-worker/internal/ui"
	"videosite-worker/internal/util"
	"videosite-worker/internal/worker/progress"
)

// ErrFFmpegFatal is returned when FFmpeg binary goes missing mid-operation.
// The worker should shut down without reporting errors to the server.
var ErrFFmpegFatal = fmt.Errorf("ffmpeg fatal: binary missing")

// LogsDir is the directory where per-invocation FFmpeg log files are written.
// Created at startup by main; cleaned on graceful stop.
const LogsDir = "logs"

// ffmpegLogPath returns the path for a per-invocation FFmpeg log file.
// Format: logs/YYYYMMDD-HHMMSS_JOBID_PROFILE_TIER.log
// The logs/ directory is created lazily in case it was removed at runtime.
func ffmpegLogPath(jobID, profile, tier string) string {
	os.MkdirAll(LogsDir, 0755)
	ts := time.Now().Format("20060102-150405")
	return filepath.Join(LogsDir, fmt.Sprintf("%s_%s_%s_%s.log", ts, jobID, profile, tier))
}

// byteCounter is an io.Writer that atomically counts total bytes written.
// Used with io.TeeReader to track download progress without blocking.
type byteCounter struct{ n int64 }

func (c *byteCounter) Write(p []byte) (int, error) {
	atomic.AddInt64(&c.n, int64(len(p)))
	return len(p), nil
}

// uploadTask pairs a relative filename (R2 key suffix / URL map key) with its
// absolute local file path.
type uploadTask struct {
	relPath string // relative path from outputDir
	absPath string // absolute local filesystem path
	size    int64  // file size in bytes — captured during the output walk so
	// upload progress can advance per-byte (smooth) instead of per-file
	// (chunky 1/N% jumps when N is small)
}

// partWriter is an io.Writer that atomically increments a shared progress counter
// while also tracking this attempt's own byte count in a local field.
// All concurrent download goroutines feed into one shared progress value.
// The local field lets downloadPart subtract this attempt's contribution if it
// needs to retry, so the shared counter never exceeds 100%.
type partWriter struct {
	downloaded *int64 // shared atomic across all concurrent parts
	local      int64  // bytes written in the current attempt (single goroutine, no atomics needed)
}

func (w *partWriter) Write(p []byte) (int, error) {
	n := int64(len(p))
	atomic.AddInt64(w.downloaded, n)
	w.local += n
	return int(n), nil
}

// errSourceForbidden is returned by download functions when R2 responds with 403.
// A 403 indicates a configuration problem (expired Cloudflare API key, wrong bucket
// permissions, etc.) that a retry cannot fix — so it routes to ReportError/blocklist.
var errSourceForbidden = errors.New("R2 source file access forbidden (403)")

// errTransientDownload wraps download failures that are transient (network drop,
// R2 5xx, mid-stream connection reset). Jobs with this error are aborted and
// requeued by the server rather than marked as failed/blocklisted.
var errTransientDownload = errors.New("transient download failure")

// downloadPartSize is the fixed chunk size for multipart downloads (32 MB).
const downloadPartSize = 32 * 1024 * 1024

// Job represents a single transcoding job.
type Job struct {
	JobID         string
	VideoID       int
	VideoType     string // "ts" (legacy MPEG-TS + AES-128) or "cmaf" (fMP4 HLS + DASH, unencrypted)
	DownloadURL   string
	EncryptionKey string // hex-encoded AES-128 key (empty = no encryption; always empty for CMAF)
	Manager       *Manager
	Progress      *progress.Tracker

	// LeasedAt is the wall-clock time the worker leased this job from the
	// server. Used by the UI manager to sort the sticky progress bars
	// oldest-first; no server-facing role.
	LeasedAt time.Time

	// UI is the user-visible output surface (sticky progress bars + log
	// lines above). All job-owned stdout goes through it. Never nil — the
	// worker constructs one Manager at startup and passes it to every Job.
	UI ui.Manager

	// Server-provided transcoding config (per-course or global defaults).
	// AudioBitrateKbps is site-wide (moved off the per-profile struct in the
	// CMAF migration); consumed by both TS (passed to RemuxToHLS /
	// TranscodeToHLS) and CMAF (the single AAC rendition for all video
	// profiles) pipelines.
	OutputProfiles            []config.OutputProfile
	AudioBitrateKbps          int
	AudioNormalization        bool
	AudioNormalizationTarget  float64
	AudioNormalizationPeak    float64
	AudioNormalizationMaxGain float64

	ctx            context.Context
	cancel         context.CancelFunc
	failedTypes    map[string]bool
	initialEncoder config.Encoder  // encoder assigned when the slot was acquired (includes device index)
	hwDecodeFailed map[string]bool // per encoder-type: true if full-GPU (hw decode) path failed this job
	tempDir        string
	outputDir      string
	duration       float64
	phase          atomic.Value // current phase: "downloading", "probing", "transcoding", "uploading", "completing"

	// Current status for the batched /task/status reporter. Read by
	// Manager.SnapshotStatuses every 2 s; written by the job goroutine on
	// progress. Duration is NOT mirrored here — it lives on j.duration and
	// is sent exactly once with /task/complete.
	reportMu       sync.Mutex
	reportStage    string
	reportProgress int
}

// NewJob creates a new job.
// The job context is always rooted at context.Background() — it is NOT derived
// from the worker context. This means the worker can cancel its own poll loop
// (w.cancel) without affecting active jobs; jobs are cancelled individually
// via job.Cancel() when the worker needs to abort them.
//
// LeasedAt is captured here (time.Now) rather than passed in by the caller so
// every Job carries a consistent timestamp regardless of how the caller was
// written; it only influences UI bar ordering.
func NewJob(jobID string, videoID int, videoType, downloadURL, encryptionKey string, audioBitrateKbps int, initialEncoder config.Encoder, mgr *Manager, tracker *progress.Tracker, uiMgr ui.Manager,
	outputProfiles []config.OutputProfile, audioNorm bool, audioNormTarget, audioNormPeak, audioNormMaxGain float64) *Job {
	jobCtx, cancel := context.WithCancel(context.Background())
	// Default to the legacy TS pipeline when the server omits videoType (back-compat
	// during the staged rollout — pre-migration servers don't set the field).
	if videoType == "" {
		videoType = "ts"
	}
	j := &Job{
		JobID:         jobID,
		VideoID:       videoID,
		VideoType:     videoType,
		DownloadURL:   downloadURL,
		EncryptionKey: encryptionKey,
		Manager:       mgr,
		Progress:      tracker,
		LeasedAt:      time.Now(),
		UI:            uiMgr,

		OutputProfiles:            outputProfiles,
		AudioBitrateKbps:          audioBitrateKbps,
		AudioNormalization:        audioNorm,
		AudioNormalizationTarget:  audioNormTarget,
		AudioNormalizationPeak:    audioNormPeak,
		AudioNormalizationMaxGain: audioNormMaxGain,

		ctx:            jobCtx,
		cancel:         cancel,
		failedTypes:    make(map[string]bool),
		hwDecodeFailed: make(map[string]bool),
		initialEncoder: initialEncoder,
	}
	j.phase.Store("init")
	return j
}

// Phase returns the current job phase.
func (j *Job) Phase() string {
	v := j.phase.Load()
	if v == nil {
		return "init"
	}
	return v.(string)
}

// Cancel cancels this job's context (used for graceful shutdown abort).
func (j *Job) Cancel() {
	j.cancel()
}

// SetStage updates the job's currently-reported stage + progress.
// Stage is one of "downloading" / "processing" / "transcoding" / "uploading"
// — the server maps it to (queue_status, video_status) in reportJobStatuses.
// Read by Manager.SnapshotStatuses via currentReport().
func (j *Job) SetStage(stage string, progress int) {
	j.reportMu.Lock()
	j.reportStage = stage
	j.reportProgress = progress
	j.reportMu.Unlock()
}

// SetProgress updates just the progress value, leaving stage alone.
func (j *Job) SetProgress(progress int) {
	j.reportMu.Lock()
	j.reportProgress = progress
	j.reportMu.Unlock()
}

// currentReport returns the job's current reporting state for the status loop.
func (j *Job) currentReport() (stage string, progress int) {
	j.reportMu.Lock()
	defer j.reportMu.Unlock()
	return j.reportStage, j.reportProgress
}

// MarkFailed queues a "failed" terminal status for the next status tick.
func (j *Job) MarkFailed(reason string) {
	j.Manager.RecordTerminal(api.JobStatus{
		JobID:        j.JobID,
		Status:       "failed",
		ErrorMessage: reason,
	})
}

// MarkAborted queues an "aborted" terminal status for the next status tick.
// Used for worker-self-aborts (transient errors, graceful shutdown) — the
// server requeues rather than counting as a fault.
func (j *Job) MarkAborted(reason string) {
	j.Manager.RecordTerminal(api.JobStatus{
		JobID:        j.JobID,
		Status:       "aborted",
		ErrorMessage: reason,
	})
}

// Run executes the full job lifecycle: download → probe → transcode → upload → complete.
//
// The first thing Run does is register with the UI manager so the sticky
// bar appears and the "leased" line is logged. Every terminal path
// (handleError branches + the normal completion below) calls
// j.UI.FinishJob to drop the bar; the UI contract treats FinishJob as
// idempotent so there's no risk of double-calls.
func (j *Job) Run() error {
	profileNames := make([]string, 0, len(j.OutputProfiles))
	for _, p := range j.OutputProfiles {
		profileNames = append(profileNames, p.Name)
	}
	j.UI.StartJob(j.JobID, j.LeasedAt, profileNames, j.AudioNormalization)

	defer j.cancel()
	defer j.Manager.ReleaseSlot(j.JobID)
	defer j.cleanup()

	j.UI.Logf("[%s] job started (video %d, encoder %s device %d)",
		j.JobID, j.VideoID, j.initialEncoder.EncoderType, j.initialEncoder.DeviceIndex)

	// 1. DOWNLOAD
	j.phase.Store("downloading")
	j.UI.UpdateStage(j.JobID, "downloading", 0)
	if err := j.download(); err != nil {
		return j.handleError("download", err)
	}

	// 2. PROBE
	//
	// Probe is a 1–2s ffprobe call. We deliberately do NOT call
	// UpdateStage here — that would reset the bar to "probing 0%" and
	// leave it stuck there for the entire probe, then snap to
	// "analyzing audio 0%" the moment probe finishes. The user-visible
	// effect was a confusing flash-of-empty-bar between two real stages.
	//
	// Instead the bar stays at "downloading 100%" (pinned by
	// downloadMultipart / downloadSingle just before they returned) and
	// the audit log gets the boundary line via Logf directly. The next
	// real stage (analyzing audio or remuxing/transcoding) is the next
	// thing that calls UpdateStage and resets the bar.
	j.phase.Store("probing")
	j.Progress.Update(j.JobID, "probing", 10)
	j.SetStage("probing", 10)
	j.UI.LogStageBoundary(j.JobID, "probing", 10)
	probe, err := j.probe()
	if err != nil {
		return j.handleError("probe", err)
	}

	// 3-6. PROCESSING — branches on VideoType.
	//
	// TS path (legacy):
	//   analyze audio → transcode per-profile (serial) → write master.m3u8
	//   One ffmpeg per profile muxes video + audio together; encryption
	//   applied via -hls_key_info_file.
	//
	// CMAF path (new):
	//   video goroutine (serial per-profile fMP4 HLS, no audio, no encryption) ||
	//   audio goroutine (single AAC fMP4 rendition with optional two-pass norm)
	//   → rewrite playlists for HMAC → probe init.mp4 for codecs →
	//     write master.m3u8 (CMAF form) + manifest.mpd (DASH).
	if j.VideoType == "cmaf" {
		j.phase.Store("transcoding")
		if err := j.runCMAF(probe); err != nil {
			return j.handleError("processing", err)
		}
	} else {
		loudnormFilter, err := j.analyzeLoudness(probe)
		if err != nil {
			return j.handleError("audio analysis", err)
		}
		j.phase.Store("transcoding")
		profiles, err := j.transcode(probe, loudnormFilter)
		if err != nil {
			return j.handleError("transcode", err)
		}
		if err := j.generateMasterPlaylist(profiles); err != nil {
			return j.handleError("master playlist", err)
		}
	}

	// 7. UPLOAD
	j.phase.Store("uploading")
	j.UI.UpdateStage(j.JobID, "uploading", 90)
	if err := j.upload(); err != nil {
		return j.handleError("upload", err)
	}

	// 8. COMPLETE — retry is embedded inside api.CompleteTask
	// (5 attempts, 0/1/2/3/4 s backoff, 204 success, 404 = gone, 401 re-auth).
	j.phase.Store("completing")
	j.UI.UpdateStage(j.JobID, "completing", 100)
	err = api.CompleteTask(j.ctx, j.JobID, api.CompletePayload{DurationSeconds: j.duration})
	if err != nil && !errors.Is(err, api.ErrJobNotFound) && !errors.Is(err, api.ErrCompleteRetriesExhausted) {
		j.UI.Logf("[%s] ERROR: failed to report completion: %v", j.JobID, err)
	}
	// ErrJobNotFound: job was deleted while we were uploading. Upload is done,
	// R2 files exist — server's delayed R2 cleanup handles it.
	// ErrCompleteRetriesExhausted: R2 objects are uploaded but the server can't
	// be reached; the server's `processing` timeout will eventually requeue.

	j.Progress.Remove(j.JobID)
	j.UI.FinishJob(j.JobID, "completed")
	return nil
}

func (j *Job) download() error {
	j.tempDir = util.TempDir(j.JobID)
	j.outputDir = filepath.Join(j.tempDir, "output")
	os.MkdirAll(j.tempDir, 0755)

	j.Progress.Update(j.JobID, "downloading", 0)
	j.SetStage("downloading", 0)

	// HEAD first to get total size for multipart planning
	totalSize, err := j.downloadHead()
	if err != nil {
		if errors.Is(err, errSourceForbidden) {
			return err // config problem — report as real error
		}
		return fmt.Errorf("%w: size probe: %v", errTransientDownload, err)
	}

	var dlErr error
	if totalSize <= 0 {
		// No Content-Length: fall back to single-connection download
		j.UI.Logf("[%s] no Content-Length from R2, using single-connection download", j.JobID)
		dlErr = j.downloadSingle()
	} else {
		dlErr = j.downloadMultipart(totalSize)
	}

	if dlErr != nil {
		if errors.Is(dlErr, errSourceForbidden) {
			return dlErr // config problem — report as real error
		}
		return fmt.Errorf("%w: %v", errTransientDownload, dlErr)
	}
	return nil
}

// downloadWithRetry executes an HTTP request with R2-specific retry logic.
// 5 attempts, delays [0,1,2,3,4s]. 403/404 → immediate abort. 5xx/network → retry.
// Returns the response (200 or 206); caller must close resp.Body.
func (j *Job) downloadWithRetry(ctx context.Context, buildReq func() (*http.Request, error)) (*http.Response, error) {
	delays := []time.Duration{0, 1 * time.Second, 2 * time.Second, 3 * time.Second, 4 * time.Second}
	var lastErr error
	for i, delay := range delays {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("aborted: %w", ctx.Err())
		}
		if delay > 0 {
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("aborted: %w", ctx.Err())
			case <-time.After(delay):
			}
		}
		req, err := buildReq()
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		resp, err := api.HTTPClient().Do(req)
		if err != nil {
			lastErr = err
			if i < len(delays)-1 {
				j.UI.Logf("[%s] WARN: R2 request error, retrying (%d/%d): %v", j.JobID, i+1, len(delays), err)
			}
			continue
		}
		switch {
		case resp.StatusCode == 200 || resp.StatusCode == 206:
			return resp, nil
		case resp.StatusCode == 404:
			resp.Body.Close()
			return nil, fmt.Errorf("source file not found (404) — task may have been deleted")
		case resp.StatusCode == 403:
			resp.Body.Close()
			return nil, fmt.Errorf("%w: check Cloudflare R2 key/bucket permissions", errSourceForbidden)
		case resp.StatusCode >= 500:
			resp.Body.Close()
			lastErr = fmt.Errorf("R2 5xx (status %d)", resp.StatusCode)
			if i < len(delays)-1 {
				j.UI.Logf("[%s] WARN: R2 5xx (status %d), retrying (%d/%d)", j.JobID, resp.StatusCode, i+1, len(delays))
			}
		default:
			resp.Body.Close()
			return nil, fmt.Errorf("unexpected R2 status %d", resp.StatusCode)
		}
	}
	return nil, fmt.Errorf("R2 request failed after %d attempts: %w", len(delays), lastErr)
}

// downloadHead probes the total file size by fetching a single byte (Range: bytes=0-0).
// This uses GET (the method the presigned URL was signed for) instead of HEAD,
// which R2 rejects with 403 when the URL was signed for GET.
// Total size is extracted from the Content-Range response header.
// Returns -1 if the header is absent (caller falls back to single-connection download).
func (j *Job) downloadHead() (int64, error) {
	resp, err := j.downloadWithRetry(j.ctx, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(j.ctx, http.MethodGet, j.DownloadURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Range", "bytes=0-0")
		return req, nil
	})
	if err != nil {
		return 0, fmt.Errorf("size probe failed: %w", err)
	}
	io.Copy(io.Discard, resp.Body) // drain the 1-byte body
	resp.Body.Close()

	// Content-Range: bytes 0-0/TOTAL_SIZE
	cr := resp.Header.Get("Content-Range")
	if cr == "" {
		return -1, nil
	}
	slash := strings.LastIndex(cr, "/")
	if slash < 0 {
		return -1, nil
	}
	var total int64
	if _, err := fmt.Sscanf(cr[slash+1:], "%d", &total); err != nil {
		return -1, nil
	}
	return total, nil
}

// downloadMultipart downloads the source file in 32 MB parts concurrently,
// then concatenates them into source.mp4.
//
// Concurrency is bounded by util.DynamicGate, which re-reads the live
// config.Get().ConcurrentDownloads on every Acquire. A mid-download reload
// that raises the limit ramps up parked goroutines; a lowered limit blocks
// new acquires until active count drops — already-running parts finish.
func (j *Job) downloadMultipart(totalSize int64) error {
	numParts := int((totalSize + downloadPartSize - 1) / downloadPartSize)

	startCap := config.Get().ConcurrentDownloads

	j.UI.Logf("[%s] downloading %s in %d parts (concurrency %d, live)",
		j.JobID, formatDownloadBytes(totalSize), numParts, startCap)

	// Shared atomic byte counter: updated in real-time by all part goroutines.
	var downloaded int64

	// Progress reporting goroutine: fires every 250ms for the duration of
	// the download. UI bar shows local 0-100%; API reports global 0-9%
	// (download phase slice). The per-1% console print that used to live
	// here was removed — the bar supersedes it.
	//
	// The previous 2s tick was visibly chunky on small jobs (a 130 MB
	// download finishes in 1–2 ticks total) and even on large ones — with
	// 5-way concurrent 32 MB parts, ~150 MB lands per tick, so the bar
	// jumped in ~20% steps. The atomic load and one UI write per tick are
	// trivial, so dropping to 250ms (matches the bar render rate) buys
	// smoothness for free.
	stopProgress := make(chan struct{})
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-j.ctx.Done():
				return
			case <-stopProgress:
				return
			case <-ticker.C:
				n := atomic.LoadInt64(&downloaded)
				localPct := int(float64(n) / float64(totalSize) * 100)
				if localPct > 100 {
					localPct = 100
				}
				j.UI.UpdateStageProgress(j.JobID, localPct)
				globalPct := localPct / 10 // 0-10% globally
				if globalPct > 10 {
					globalPct = 10
				}
				j.Progress.Update(j.JobID, "downloading", globalPct)
				j.SetStage("downloading", globalPct)
			}
		}
	}()
	defer close(stopProgress)

	// Derived context: cancelled on first part failure so other parts stop.
	dlCtx, dlCancel := context.WithCancel(j.ctx)
	defer dlCancel()

	// Per-part error storage — one writer per index, no mutex needed.
	partErrors := make([]error, numParts)
	gate := util.NewDynamicGate(func() int { return config.Get().ConcurrentDownloads })

	var wg sync.WaitGroup
	for i := 0; i < numParts; i++ {
		wg.Add(1)
		go func(partNum int) {
			defer wg.Done()

			// Block until a gate slot frees. Returns early if dlCtx was
			// cancelled (another part failed) — no slot was taken so no release.
			if err := gate.Acquire(dlCtx); err != nil {
				return
			}
			defer gate.Release()

			if dlCtx.Err() != nil {
				return
			}

			start := int64(partNum) * downloadPartSize
			end := start + downloadPartSize - 1
			if end >= totalSize {
				end = totalSize - 1
			}

			partPath := filepath.Join(j.tempDir, fmt.Sprintf("part_%06d", partNum))
			err := j.downloadPart(dlCtx, partPath, start, end, &downloaded, partNum)
			if err != nil {
				partErrors[partNum] = err
				dlCancel() // cancel remaining parts on failure
			}
		}(i)
	}

	wg.Wait()

	// Collect first non-nil part error.
	var firstErr error
	for _, err := range partErrors {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}

	// Cleanup all part files on failure (including parts that succeeded before abort).
	if firstErr != nil || j.ctx.Err() != nil {
		for i := 0; i < numParts; i++ {
			os.Remove(filepath.Join(j.tempDir, fmt.Sprintf("part_%06d", i)))
		}
		if j.ctx.Err() != nil {
			return fmt.Errorf("aborted: %w", j.ctx.Err())
		}
		return firstErr
	}

	// All parts downloaded — concatenate into source.mp4.
	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	if err := j.concatenateParts(numParts, sourcePath); err != nil {
		for i := 0; i < numParts; i++ {
			os.Remove(filepath.Join(j.tempDir, fmt.Sprintf("part_%06d", i)))
		}
		return fmt.Errorf("concatenate parts: %w", err)
	}

	// Delete part files now that the assembled file exists.
	for i := 0; i < numParts; i++ {
		os.Remove(filepath.Join(j.tempDir, fmt.Sprintf("part_%06d", i)))
	}

	// Pin the bar to 100% before the next stage begins. Without this the
	// bar would visibly read whatever value the last 250ms poll captured
	// (typically 96–99% — the final part finishes between ticks), then
	// snap to "downloading 100%" only if the user happened to be looking
	// during the 1–2s probe window. The user-perceived effect was "the
	// bar never quite reaches 100% during downloading".
	j.UI.UpdateStageProgress(j.JobID, 100)
	j.UI.Logf("[%s] download complete", j.JobID)
	return nil
}

// downloadPart downloads bytes [start, end] from DownloadURL into partPath.
// Updates the shared downloaded counter in real-time as bytes stream in.
// Retries the full request+stream sequence on network errors or mid-stream drops —
// subtracting this attempt's byte contribution before each retry so the shared
// progress counter never exceeds the true total.
// 403 errors are returned immediately as errSourceForbidden (no retry).
func (j *Job) downloadPart(ctx context.Context, partPath string, start, end int64, downloaded *int64, partNum int) error {
	delays := []time.Duration{0, 1 * time.Second, 2 * time.Second, 3 * time.Second, 4 * time.Second}
	var lastErr error
	var partContrib int64 // bytes this part has contributed to `downloaded` so far this job

	for i, delay := range delays {
		if ctx.Err() != nil {
			return fmt.Errorf("aborted: %w", ctx.Err())
		}

		// Roll back previous attempt's contribution before retrying so we don't
		// double-count bytes in the shared progress display.
		if partContrib > 0 {
			atomic.AddInt64(downloaded, -partContrib)
			partContrib = 0
		}

		if delay > 0 {
			select {
			case <-ctx.Done():
				return fmt.Errorf("aborted: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, j.DownloadURL, nil)
		if err != nil {
			return fmt.Errorf("build part request: %w", err)
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))

		resp, err := api.HTTPClient().Do(req)
		if err != nil {
			lastErr = err
			if i < len(delays)-1 {
				j.UI.Logf("[%s] WARN: part %d request error, retrying (%d/%d): %v", j.JobID, partNum, i+1, len(delays), err)
			}
			continue
		}

		switch {
		case resp.StatusCode == 200 || resp.StatusCode == 206:
			// ok — proceed to stream below
		case resp.StatusCode == 403:
			resp.Body.Close()
			return fmt.Errorf("%w: part %d", errSourceForbidden, partNum)
		case resp.StatusCode >= 500:
			resp.Body.Close()
			lastErr = fmt.Errorf("R2 5xx (status %d)", resp.StatusCode)
			if i < len(delays)-1 {
				j.UI.Logf("[%s] WARN: part %d R2 5xx (status %d), retrying (%d/%d)", j.JobID, partNum, resp.StatusCode, i+1, len(delays))
			}
			continue
		default:
			resp.Body.Close()
			return fmt.Errorf("part %d: unexpected R2 status %d", partNum, resp.StatusCode)
		}

		// Stream the body. Track this attempt's byte count separately so we
		// can subtract it if we need to retry.
		f, err := os.Create(partPath)
		if err != nil {
			resp.Body.Close()
			return fmt.Errorf("create part %d file: %w", partNum, err)
		}
		pw := &partWriter{downloaded: downloaded}
		_, copyErr := io.Copy(f, io.TeeReader(resp.Body, pw))
		resp.Body.Close()
		f.Close()
		partContrib = pw.local // remember for rollback if we retry

		if copyErr == nil {
			return nil // success
		}
		if ctx.Err() != nil {
			return fmt.Errorf("aborted: %w", ctx.Err())
		}

		lastErr = fmt.Errorf("stream read: %w", copyErr)
		if i < len(delays)-1 {
			j.UI.Logf("[%s] WARN: part %d stream error, retrying (%d/%d): %v", j.JobID, partNum, i+1, len(delays), copyErr)
		}
		os.Remove(partPath) // remove the partial file before retrying
	}
	return fmt.Errorf("part %d failed after %d attempts: %w", partNum, len(delays), lastErr)
}

// concatenateParts opens part files in order and writes them to destPath.
func (j *Job) concatenateParts(numParts int, destPath string) error {
	dest, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("create destination: %w", err)
	}
	defer dest.Close()

	for i := 0; i < numParts; i++ {
		partPath := filepath.Join(j.tempDir, fmt.Sprintf("part_%06d", i))
		part, err := os.Open(partPath)
		if err != nil {
			return fmt.Errorf("open part %d: %w", i, err)
		}
		_, copyErr := io.Copy(dest, part)
		part.Close()
		if copyErr != nil {
			return fmt.Errorf("copy part %d: %w", i, copyErr)
		}
	}
	return nil
}

// downloadSingle is the fallback for when HEAD returns no Content-Length.
// Downloads the full file in a single connection with no progress percentage.
func (j *Job) downloadSingle() error {
	resp, err := j.downloadWithRetry(j.ctx, func() (*http.Request, error) {
		return http.NewRequestWithContext(j.ctx, http.MethodGet, j.DownloadURL, nil)
	})
	if err != nil {
		return fmt.Errorf("download source: %w", err)
	}
	defer resp.Body.Close()

	counter := &byteCounter{}
	// No internal heartbeat — the worker's 2-second status loop reads
	// j.reportStage/reportProgress directly. Single-connection downloads
	// don't expose byte progress, so we just publish "downloading" / 0%.
	j.SetStage("downloading", 0)

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	f, err := os.Create(sourcePath)
	if err != nil {
		return fmt.Errorf("create source file: %w", err)
	}
	_, copyErr := io.Copy(f, io.TeeReader(resp.Body, counter))
	f.Close()
	if copyErr != nil {
		return fmt.Errorf("save source file: %w", copyErr)
	}

	// See doDownloadMultipart's matching call — pin the bar to 100% so
	// the brief probe window doesn't display a stuck "downloading 97%".
	j.UI.UpdateStageProgress(j.JobID, 100)
	j.UI.Logf("[%s] download complete", j.JobID)
	return nil
}

// formatDownloadBytes formats a byte count as a human-readable string (e.g. "1.2 GB").
func formatDownloadBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func (j *Job) probe() (*transcoder.ProbeResult, error) {
	j.Progress.Update(j.JobID, "probing", 9)
	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	probe, err := transcoder.Probe(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("probe source: %w", err)
	}

	j.duration = probe.DurationSeconds
	j.UI.Logf("[%s] probe complete: %dx%d, %.1fs, %s", j.JobID, probe.Width, probe.Height, probe.DurationSeconds, probe.Codec)

	// Stage is picked up by the next /task/status tick (worker status loop
	// reads SnapshotStatuses every 2 s). Duration is NOT pushed into the
	// status path — it rides on /task/complete for a single DB write.
	j.SetStage("processing", 9)

	return probe, nil
}

// prepareEncryption writes the AES-128 key file and FFmpeg key_info file
// to the temp directory. Returns the path to the key_info file, or "" if
// no encryption key is set.
func (j *Job) prepareEncryption() (string, error) {
	if j.EncryptionKey == "" {
		return "", nil
	}

	keyBytes, err := hex.DecodeString(j.EncryptionKey)
	if err != nil {
		return "", fmt.Errorf("decode encryption key: %w", err)
	}

	// Write raw 16-byte key file
	keyFilePath := filepath.Join(j.tempDir, "encryption.key")
	if err := os.WriteFile(keyFilePath, keyBytes, 0600); err != nil {
		return "", fmt.Errorf("write encryption key file: %w", err)
	}

	// Build key URI: same scheme://host logic as the API client
	keyURI := api.BuildURL(fmt.Sprintf("/api/keys/%d", j.VideoID))

	// Generate a random 16-byte IV for this video.
	// FFmpeg key_info line 3: 32-char hex string, no 0x prefix.
	ivBytes := make([]byte, 16)
	if _, err := rand.Read(ivBytes); err != nil {
		return "", fmt.Errorf("generate IV: %w", err)
	}
	ivHex := hex.EncodeToString(ivBytes)

	// Write key_info file (3 lines: key URI, key file path, IV hex)
	keyInfoPath := filepath.Join(j.tempDir, "key_info.txt")
	keyInfoContent := keyURI + "\n" + keyFilePath + "\n" + ivHex
	if err := os.WriteFile(keyInfoPath, []byte(keyInfoContent), 0600); err != nil {
		return "", fmt.Errorf("write key info file: %w", err)
	}

	j.UI.Logf("[%s] encryption prepared", j.JobID)
	return keyInfoPath, nil
}

// analyzeLoudness runs a loudnorm pass-1 analysis if audio normalization is
// enabled in config. Returns the loudnorm filter string for pass 2, or "" if
// normalization is disabled or the source has no audio stream.
//
// Progress wiring: when norm is on, analyze is step 0 of the weighted 10–90
// processing plan. The bar shows 0–100 local pct; the server-facing global
// pct advances through the analyze span instead of staying pinned at 10
// until the first profile starts.
func (j *Job) analyzeLoudness(probe *transcoder.ProbeResult) (string, error) {
	if !j.AudioNormalization {
		return "", nil
	}
	if probe.AudioCodec == "" {
		j.UI.Logf("[%s] audio normalization: no audio stream, skipping", j.JobID)
		return "", nil
	}

	// Step 0 of the processing plan when normOn = true.
	plan := processingPlan(len(j.OutputProfiles), true)
	aStart, aEnd := stepRange(plan, 0)

	j.Progress.Update(j.JobID, "analyzing audio", int(aStart))
	j.SetStage("processing", int(aStart))
	j.UI.UpdateStage(j.JobID, "analyzing audio", int(aStart))
	j.UI.Logf("[%s] analyzing audio loudness (EBU R128)...", j.JobID)

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	stats, err := transcoder.AnalyzeLoudness(j.ctx, sourcePath, j.duration, func(pct int) {
		j.UI.UpdateStageProgress(j.JobID, pct)
		globalPct := scaleLocal(aStart, aEnd, pct)
		j.Progress.Update(j.JobID, "analyzing audio", globalPct)
		j.SetStage("processing", globalPct)
	})
	if err != nil {
		if j.ctx.Err() != nil {
			return "", fmt.Errorf("aborted: %w", j.ctx.Err())
		}
		// Non-fatal: if analysis fails, proceed without normalization.
		j.UI.Logf("[%s] WARN: audio loudness analysis failed, skipping normalization: %v", j.JobID, err)
		return "", nil
	}
	if stats == nil {
		j.UI.Logf("[%s] audio normalization: no audio detected by loudnorm, skipping", j.JobID)
		return "", nil
	}

	gainRequired := j.AudioNormalizationTarget - stats.InputI
	j.UI.Logf("[%s] audio: measured %.1f LUFS, target %.1f LUFS, gain required %.1f dB (max %.1f dB)",
		j.JobID, stats.InputI, j.AudioNormalizationTarget, gainRequired, j.AudioNormalizationMaxGain)

	filter := transcoder.BuildLoudnormFilter(stats,
		j.AudioNormalizationTarget,
		j.AudioNormalizationPeak,
		j.AudioNormalizationMaxGain,
	)
	return filter, nil
}

// analyzeLoudnessCMAF runs loudnorm pass-1 for the CMAF pipeline. It emits
// the same start/result/skip log lines as analyzeLoudness (TS path) so the
// console trace is consistent between pipelines; progress reporting is
// delegated via progressCb because CMAF feeds it into the V+A bar rather than
// the TS weighted processingPlan.
//
// Returns the loudnorm filter string for pass 2, or "" if normalization is
// disabled, the source has no audio, analysis failed, or loudnorm saw no audio.
func (j *Job) analyzeLoudnessCMAF(probe *transcoder.ProbeResult, progressCb func(pct int)) (string, error) {
	if !j.AudioNormalization {
		return "", nil
	}
	if probe.AudioCodec == "" {
		j.UI.Logf("[%s] audio normalization: no audio stream, skipping", j.JobID)
		return "", nil
	}

	j.UI.Logf("[%s] analyzing audio loudness (EBU R128)...", j.JobID)

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	stats, err := transcoder.AnalyzeLoudness(j.ctx, sourcePath, probe.DurationSeconds, progressCb)
	if err != nil {
		if j.ctx.Err() != nil {
			return "", fmt.Errorf("aborted: %w", j.ctx.Err())
		}
		// Non-fatal: fall back to plain encode.
		j.UI.Logf("[%s] WARN: audio loudness analysis failed, skipping normalization: %v", j.JobID, err)
		return "", nil
	}
	if stats == nil {
		j.UI.Logf("[%s] audio normalization: no audio detected by loudnorm, skipping", j.JobID)
		return "", nil
	}

	gainRequired := j.AudioNormalizationTarget - stats.InputI
	j.UI.Logf("[%s] audio: measured %.1f LUFS, target %.1f LUFS, gain required %.1f dB (max %.1f dB)",
		j.JobID, stats.InputI, j.AudioNormalizationTarget, gainRequired, j.AudioNormalizationMaxGain)

	filter := transcoder.BuildLoudnormFilter(stats,
		j.AudioNormalizationTarget,
		j.AudioNormalizationPeak,
		j.AudioNormalizationMaxGain,
	)
	return filter, nil
}

func (j *Job) transcode(probe *transcoder.ProbeResult, loudnormFilter string) ([]transcoder.FilteredProfile, error) {
	profiles := transcoder.FilterProfiles(probe, j.OutputProfiles)
	profiles = transcoder.ApplyBitrateCaps(j.JobID, profiles, probe.Height, probe.VideoBitrateKbps)

	if len(profiles) == 0 {
		return nil, fmt.Errorf("no suitable output profiles for source %dx%d", probe.Width, probe.Height)
	}

	// Prepare HLS AES-128 encryption (writes key file + key_info file)
	keyInfoFile, err := j.prepareEncryption()
	if err != nil {
		return nil, fmt.Errorf("prepare encryption: %w", err)
	}

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	totalProfiles := len(profiles)

	// Build the weighted progress plan once so every profile's global-pct
	// span is computed consistently with the analyze pass (if any).
	normOn := loudnormFilter != ""
	plan := processingPlan(totalProfiles, normOn)

	for i, profile := range profiles {
		if err := j.ctx.Err(); err != nil {
			return nil, fmt.Errorf("aborted: %w", err)
		}

		// Step index in the plan: 0 is analyze when normOn, so profiles
		// start at 1; otherwise they start at 0.
		stepIdx := i
		if normOn {
			stepIdx++
		}
		pStart, pEnd := stepRange(plan, stepIdx)
		// Stage label kept short ("remuxing 1080p") — the profile name,
		// step index, and codec details already appear in the surrounding
		// Logf lines (the lease line lists the full profile set; the
		// per-encoder messages name the codec). Putting all of that into
		// the bar label too just chewed bar width and duplicated info
		// that's two lines up in the scroll log.
		stageLabel := fmt.Sprintf("%dp", profile.Height)

		profileDir := filepath.Join(j.outputDir, profile.Name)

		// Try remux first if eligible.
		// With normalization active, remux copies video but re-encodes audio.
		if profile.CanRemux {
			remuxTier := "remux"
			if loudnormFilter != "" {
				remuxTier = "remux+norm"
			}
			j.UI.UpdateStage(j.JobID, "remuxing "+stageLabel, int(pStart))
			remuxLog := ffmpegLogPath(j.JobID, profile.Name, remuxTier)
			err := j.remuxProfile(sourcePath, profileDir, profile, keyInfoFile, remuxLog, pStart, pEnd, loudnormFilter)
			if err == nil {
				j.UI.Logf("[%s] remux successful: %s", j.JobID, profile.Name)
				j.reportProfileProgress(pEnd)
				continue
			}
			if j.ctx.Err() != nil {
				return nil, fmt.Errorf("aborted: %w", j.ctx.Err())
			}
			if errors.Is(err, transcoder.ErrFFmpegMissing) {
				return nil, err // Fatal — propagate without falling back to transcode
			}
			j.UI.Logf("[%s] WARN: remux failed for %s, falling back to transcode: %v", j.JobID, profile.Name, err)
			os.RemoveAll(profileDir) // Clean up failed remux
		}

		// Transcode with encoder fallback. The stage label and bar reset
		// happen once here (not per-encoder-retry inside transcodeProfile) so
		// hw→sw decode fallbacks don't spam the log.
		j.UI.UpdateStage(j.JobID, "transcoding "+stageLabel, int(pStart))
		if err := j.transcodeProfile(sourcePath, profileDir, profile, probe.DurationSeconds, pStart, pEnd, keyInfoFile, probe.Width, probe.Height, loudnormFilter); err != nil {
			return nil, err
		}

		j.reportProfileProgress(pEnd)
	}

	return profiles, nil
}

// remuxProfile runs a remux for one profile and reports progress. pStart/pEnd
// define this profile's slice of the weighted 10–90% global-pct band (see
// processingPlan / stepRange in weights.go). The UI bar is driven with local
// 0–100 pct; the per-1% console print was removed in favor of the bar.
// loudnormFilter is passed through to RemuxToHLS: when non-empty, video is
// stream-copied and audio is re-encoded with normalization applied.
// Returns nil on success, a non-nil error on failure or FFmpeg missing.
// The caller must check j.ctx.Err() after a non-nil return to distinguish
// an abort from a genuine remux failure (which should fall back to transcode).
func (j *Job) remuxProfile(sourcePath, profileDir string, profile transcoder.FilteredProfile, keyInfoFile, logFile string, pStart, pEnd float64, loudnormFilter string) error {
	progressCh, errCh := transcoder.RemuxToHLS(
		j.ctx, sourcePath, profileDir, profile.OutputProfile, j.AudioBitrateKbps, keyInfoFile, logFile, j.duration, loudnormFilter,
	)

	for pct := range progressCh {
		j.UI.UpdateStageProgress(j.JobID, pct)
		j.Progress.Update(j.JobID, fmt.Sprintf("remuxing %s", profile.Name), pct)

		// Update local report state; worker status loop picks it up every 2 s.
		globalPct := scaleLocal(pStart, pEnd, pct)
		j.SetStage("processing", globalPct)
	}
	// Drain any remaining items so the FFmpeg goroutine can close the channel.
	for range progressCh {
	}

	return <-errCh
}

// transcodeProfile encodes one profile with encoder-tier fallback.
// pStart/pEnd are this profile's slice of the weighted 10–90% global-pct
// band; local progress (0–100) is scaled into that slice for the server
// report and drives the UI bar directly. The stage label and bar reset are
// handled by the caller, so encoder-tier retries inside this function don't
// spam the bar with repeated transitions.
func (j *Job) transcodeProfile(sourcePath, profileDir string, profile transcoder.FilteredProfile, duration float64, pStart, pEnd float64, keyInfoFile string, srcW, srcH int, loudnormFilter string) error {
	// Start with the encoder assigned when this job acquired its slot.
	// If that type has already failed (from a previous profile), ask the
	// manager for the next available fallback — no new slot is acquired.
	encoder := j.initialEncoder
	if j.failedTypes[encoder.EncoderType] {
		var err error
		encoder, err = j.Manager.NextEncoder(j.failedTypes)
		if err != nil {
			return fmt.Errorf("no encoder available for profile %s: %w", profile.Name, err)
		}
	}

	for {
		if err := j.ctx.Err(); err != nil {
			return fmt.Errorf("aborted: %w", err)
		}

		// Two-tier decode selection per encoder type:
		//   Tier 1 (full GPU):  hw decode + hw encode  — tried first if available
		//   Tier 2 (half-half): sw decode + hw encode  — tried after tier-1 failure
		// Once both tiers of an encoder type are exhausted, move to the next type.
		// hwDecodeFailed tracks whether tier-1 has already been tried for each type.
		swDecode := !hwDecodeAvailable(encoder.EncoderType) || j.hwDecodeFailed[encoder.EncoderType]

		var tierLabel string
		switch {
		case encoder.EncoderType == hardware.EncoderSW:
			tierLabel = "software"
			j.UI.Logf("[%s] transcoding %s with software (libx264)", j.JobID, profile.Name)
		case swDecode:
			tierLabel = "vt-swdec"
			j.UI.Logf("[%s] transcoding %s with %s (sw decode + hw encode)", j.JobID, profile.Name, encoder.EncoderType)
		default:
			tierLabel = "vt-hwdec"
			j.UI.Logf("[%s] transcoding %s with %s (hw decode + hw encode)", j.JobID, profile.Name, encoder.EncoderType)
		}

		// Re-reset the bar on tier retry so the user sees the new attempt
		// start from 0 instead of continuing from wherever the failed attempt
		// left off.
		j.UI.UpdateStageProgress(j.JobID, 0)

		logFile := ffmpegLogPath(j.JobID, profile.Name, tierLabel)
		progressCh, errCh := transcoder.TranscodeToHLS(j.ctx, sourcePath, profileDir, profile.OutputProfile, j.AudioBitrateKbps, encoder, duration, keyInfoFile, swDecode, logFile, srcW, srcH, loudnormFilter)

		// Drain progress updates into the bar + server-report state.
		// The per-1% Printf that used to live here was removed in favor of
		// the bar.
		for pct := range progressCh {
			j.UI.UpdateStageProgress(j.JobID, pct)
			j.Progress.Update(j.JobID, fmt.Sprintf("transcoding %s", profile.Name), pct)

			globalPct := scaleLocal(pStart, pEnd, pct)
			j.SetStage("processing", globalPct)
		}
		// Drain any remaining items so the FFmpeg goroutine can close the channel.
		for range progressCh {
		}

		err := <-errCh
		if err == nil {
			return nil // Success
		}

		// Check if aborted
		if j.ctx.Err() != nil {
			return fmt.Errorf("aborted during transcode: %w", j.ctx.Err())
		}

		// FFmpeg binary missing — fatal, propagate directly for worker shutdown
		if errors.Is(err, transcoder.ErrFFmpegMissing) {
			return err
		}

		// Tier-1 (full GPU) failed — retry same encoder with sw decode (tier-2).
		// Per-job tracking: other concurrent jobs on the same machine still try
		// full-GPU first for their own videos.
		if !swDecode {
			j.UI.Logf("[%s] WARN: %s full-GPU failed for %s, retrying with sw decode: %v", j.JobID, encoder.EncoderType, profile.Name, err)
			j.hwDecodeFailed[encoder.EncoderType] = true
			os.RemoveAll(profileDir)
			continue // same encoder type, sw decode next iteration
		}

		// Tier-2 also failed (or hw decode never available) — this encoder type is done.
		j.UI.Logf("[%s] WARN: %s exhausted for %s, trying next encoder: %v", j.JobID, encoder.EncoderType, profile.Name, err)
		j.failedTypes[encoder.EncoderType] = true
		os.RemoveAll(profileDir)

		encoder, err = j.Manager.NextEncoder(j.failedTypes)
		if err != nil {
			return fmt.Errorf("all encoders failed for profile %s: %w", profile.Name, err)
		}
	}
}

// hwDecodeAvailable is defined in job_darwin.go / job_windows.go.
// Returns whether the full-GPU (hardware decode) path should be attempted
// for the given encoder type.

func (j *Job) generateMasterPlaylist(profiles []transcoder.FilteredProfile) error {
	// Write master playlist (always includes HMAC query params)
	if err := transcoder.WriteMasterPlaylist(j.outputDir, profiles, j.AudioBitrateKbps); err != nil {
		return fmt.Errorf("write master playlist: %w", err)
	}

	// Rewrite per-profile playlists with HMAC token variables
	for _, p := range profiles {
		playlistPath := filepath.Join(j.outputDir, p.Name, "playlist.m3u8")
		if err := transcoder.RewritePlaylistHMAC(playlistPath); err != nil {
			return fmt.Errorf("rewrite HMAC playlist for %s: %w", p.Name, err)
		}
	}

	return nil
}

// upload collects all HLS output files and uploads them concurrently to R2.
//
// Upload logic:
//  1. Fetch presigned PUT URLs for all files (batched, with RetryWithBackoff).
//  2. Upload all files concurrently (up to cfg.ConcurrentUploads).
//     - Each file retried up to 5× on R2 5xx (handled inside api.UploadFile).
//     - On 403 (ErrUploadForbidden), cancel and refresh tokens.
//  3. If 403 occurred, regenerate URLs for failed files and retry once.
func (j *Job) upload() error {
	j.Progress.Update(j.JobID, "uploading", 90)

	// Collect all output files (only needs to be done once). info.Size() is
	// captured here so doUploadWithMonitoring can drive the bar by
	// bytes-uploaded rather than files-uploaded — segments vary widely in
	// size (an HLS init segment is tens of KB, a 10s segment can be tens of
	// MB), so per-file progress on a 50–200-segment job stutters between
	// bursts of small files and pauses on large ones.
	var tasks []uploadTask
	walkErr := filepath.Walk(j.outputDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		relPath, _ := filepath.Rel(j.outputDir, path)
		relPath = strings.ReplaceAll(relPath, "\\", "/") // normalize separators
		tasks = append(tasks, uploadTask{relPath: relPath, absPath: path, size: info.Size()})
		return nil
	})
	if walkErr != nil {
		return fmt.Errorf("collect output files: %w", walkErr)
	}
	if len(tasks) == 0 {
		return fmt.Errorf("no output files to upload")
	}

	// 1. Publish upload start locally — status loop reports it on its own cadence.
	j.SetStage("uploading", 90)

	// 2. Request presigned URLs (with retry)
	allURLs, err := j.fetchUploadURLsWithRetry(j.ctx, tasks)
	if err != nil {
		return err // ErrJobNotFound, context cancel, or exhausted retries
	}

	// 3. Upload with 60s API failure monitoring
	return j.doUploadWithMonitoring(j.ctx, tasks, allURLs)
}

// fetchUploadURLsWithRetry wraps fetchUploadURLsBatch with RetryWithBackoff.
func (j *Job) fetchUploadURLsWithRetry(ctx context.Context, tasks []uploadTask) (map[string]string, error) {
	var urls map[string]string
	err := api.RetryWithBackoff(ctx, "request upload URLs", func() error {
		var fetchErr error
		urls, fetchErr = j.fetchUploadURLsBatch(ctx, tasks)
		return fetchErr
	})
	if err != nil {
		return nil, err
	}
	return urls, nil
}

// doUploadWithMonitoring performs the actual upload.
//
// The 60-second "server unreachable" safety net lives at the worker level now
// (status loop calls slotMgr.AbortAll when /task/status has been silent that
// long), so this function only has to worry about cancellation and 403 token
// refresh.
//
// ctx is j.ctx — the job's own context (rooted at Background, not the worker ctx).
//
// Upload concurrency is bounded by util.DynamicGate, which re-reads the live
// config.Get().ConcurrentUploads on every Acquire. Reloading mid-upload
// takes effect immediately for new acquires; already-running PUTs finish
// regardless of the cap change.
func (j *Job) doUploadWithMonitoring(ctx context.Context, tasks []uploadTask, allURLs map[string]string) error {
	startCap := config.Get().ConcurrentUploads

	totalFiles := len(tasks)
	// totalBytes drives the per-byte progress percentage. Computed once
	// from the walk-captured sizes; protected by a max(1, …) below to
	// avoid a divide-by-zero in the (impossible-but-cheap-to-guard) case
	// of an all-empty file set.
	var totalBytes int64
	for _, t := range tasks {
		totalBytes += t.size
	}
	if totalBytes < 1 {
		totalBytes = 1
	}
	var bytesUploaded int64 // atomic, shared across both upload passes

	j.UI.Logf("[%s] uploading %d files (%s, concurrency %d, live)",
		j.JobID, totalFiles, formatDownloadBytes(totalBytes), startCap)

	// Progress publisher: drives the UI bar + the server-facing report state.
	// 250ms tick (vs the old 2s) so the bar moves smoothly even on small
	// jobs where the whole upload fits in 5–10s. Each tick is a single
	// atomic load + a UI write that reduces to an atomic int store on the
	// hot path (the actual repaint is 4Hz on the render goroutine), so
	// quadrupling the rate is essentially free.
	stopProgress := make(chan struct{})
	defer close(stopProgress)
	go func() {
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopProgress:
				return
			case <-ticker.C:
				n := atomic.LoadInt64(&bytesUploaded)
				localPct := int(n * 100 / totalBytes)
				if localPct > 100 {
					localPct = 100
				}
				j.UI.UpdateStageProgress(j.JobID, localPct)
				globalPct := 90 + localPct/10 // 90-100%
				j.Progress.Update(j.JobID, "uploading", globalPct)
				j.SetStage("uploading", globalPct)
			}
		}
	}()

	// First pass: upload everything
	failed, anyForbidden, firstErr := j.uploadConcurrent(ctx, tasks, allURLs, totalFiles, &bytesUploaded)
	if len(failed) == 0 {
		// Pin to 100% — the 250ms ticker may not have fired since the
		// last byte landed, so the bar could be sitting at 97-99%.
		j.UI.UpdateStageProgress(j.JobID, 100)
		j.Progress.Update(j.JobID, "uploading", 100)
		j.SetStage("uploading", 100)
		j.UI.Logf("[%s] upload complete", j.JobID)
		return nil
	}

	// Check for job abort
	if ctx.Err() != nil {
		return fmt.Errorf("aborted during upload: %w", ctx.Err())
	}

	// If only 5xx errors and no 403, token refresh won't help — fail immediately
	if !anyForbidden {
		return fmt.Errorf("upload failed: %w", firstErr)
	}

	// Token refresh: fetch new URLs for failed files.
	j.UI.Logf("[%s] upload token refresh (%d files)", j.JobID, len(failed))
	newURLs, err := j.fetchUploadURLsBatch(ctx, failed)
	if err != nil {
		return fmt.Errorf("refresh upload URLs: %w", err)
	}
	for k, v := range newURLs {
		allURLs[k] = v
	}

	// Second pass: retry failed files with fresh tokens
	failed2, _, firstErr2 := j.uploadConcurrent(ctx, failed, allURLs, totalFiles, &bytesUploaded)

	if ctx.Err() != nil {
		return fmt.Errorf("aborted during upload retry: %w", ctx.Err())
	}
	if len(failed2) > 0 {
		if firstErr2 != nil {
			return fmt.Errorf("upload failed after token refresh: %w", firstErr2)
		}
		return fmt.Errorf("upload failed after token refresh: %d files could not be uploaded", len(failed2))
	}

	j.UI.UpdateStageProgress(j.JobID, 100)
	j.Progress.Update(j.JobID, "uploading", 100)
	j.SetStage("uploading", 100)
	j.UI.Logf("[%s] upload complete (after token refresh)", j.JobID)
	return nil
}

// uploadConcurrent uploads a slice of uploadTasks concurrently.
//
//   - Respects j.ctx for job-level cancellation.
//   - On 403 (ErrUploadForbidden): cancels remaining in-flight uploads and
//     returns all unfinished tasks in failed (so the caller can refresh tokens).
//   - Returns (failed tasks, anyForbidden, first non-cancellation error).
//   - Concurrency is bounded by a DynamicGate reading config.Get().ConcurrentUploads
//     live, so a reload mid-upload applies to subsequent acquires.
// totalFiles is kept in the signature for symmetry with the call sites
// (and in case we ever surface "X of N files" again), but it is no longer
// used to compute the progress percentage — bytesUploaded / totalBytes is
// the sole driver, owned by doUploadWithMonitoring's ticker.
func (j *Job) uploadConcurrent(
	ctx context.Context,
	tasks []uploadTask,
	urls map[string]string,
	totalFiles int,
	bytesUploaded *int64,
) (failed []uploadTask, anyForbidden bool, firstErr error) {
	_ = totalFiles
	type uploadResult struct {
		task      uploadTask
		err       error
		forbidden bool
	}

	// Derived context: cancelled on 403 to stop remaining goroutines quickly.
	uploadCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	gate := util.NewDynamicGate(func() int { return config.Get().ConcurrentUploads })
	resultCh := make(chan uploadResult, len(tasks))

	var wg sync.WaitGroup
	for _, t := range tasks {
		wg.Add(1)
		go func(task uploadTask) {
			defer wg.Done()

			// Acquire a gate slot (blocks until active < live cap), respecting cancellation.
			if err := gate.Acquire(uploadCtx); err != nil {
				resultCh <- uploadResult{task: task, err: err}
				return
			}
			defer gate.Release()

			url := urls[task.relPath]
			if url == "" {
				resultCh <- uploadResult{task: task, err: fmt.Errorf("no presigned URL for %s", task.relPath)}
				return
			}

			err := api.UploadFile(uploadCtx, task.absPath, url)
			if err == nil {
				// Per-byte: one atomic add of this file's size lets the
				// monitor goroutine compute pct = bytesUploaded /
				// totalBytes without each upload goroutine having to do
				// the math (or know totalBytes). The previous per-file
				// Progress.Update here was redundant with the 250ms
				// ticker in doUploadWithMonitoring; removed so the bar's
				// pct and the server's pct are always in sync (single
				// writer).
				atomic.AddInt64(bytesUploaded, task.size)
				resultCh <- uploadResult{task: task}
				return
			}

			isForbidden := errors.Is(err, api.ErrUploadForbidden)
			if isForbidden {
				cancel() // cancel remaining uploads on 403
			}
			resultCh <- uploadResult{task: task, err: err, forbidden: isForbidden}
		}(t)
	}

	go func() {
		wg.Wait()
		close(resultCh)
	}()

	for r := range resultCh {
		if r.err == nil {
			continue
		}
		switch {
		case r.forbidden:
			// Genuine 403 — needs token refresh
			anyForbidden = true
			failed = append(failed, r.task)
		case errors.Is(r.err, context.Canceled) && uploadCtx.Err() != nil:
			// Cancelled by our own cancel() (due to a 403 from another goroutine)
			// or because j.ctx was cancelled — in both cases, add to retry list.
			failed = append(failed, r.task)
		default:
			// Persistent error (5xx exhausted, network, etc.)
			if firstErr == nil {
				firstErr = r.err
			}
			failed = append(failed, r.task)
		}
	}
	return
}

// fetchUploadURLsBatch requests presigned PUT URLs for a slice of uploadTasks,
// batching in chunks of 100 filenames per request.
func (j *Job) fetchUploadURLsBatch(ctx context.Context, tasks []uploadTask) (map[string]string, error) {
	names := make([]string, len(tasks))
	for i, t := range tasks {
		names[i] = t.relPath
	}

	allURLs := make(map[string]string, len(names))
	for i := 0; i < len(names); i += 100 {
		end := i + 100
		if end > len(names) {
			end = len(names)
		}
		urls, err := api.GetUploadURLsLocked(ctx, j.JobID, names[i:end])
		if err != nil {
			return nil, err
		}
		for k, v := range urls {
			allURLs[k] = v
		}
	}
	return allURLs, nil
}

// reportProfileProgress snaps the server-reported progress to the end of the
// just-finished profile step. pEnd comes from stepRange and already accounts
// for the weighted plan (analyze + profiles).
func (j *Job) reportProfileProgress(pEnd float64) {
	pct := int(pEnd)
	j.Progress.Update(j.JobID, "transcoding", pct)

	// Publish locally — worker status loop picks it up every 2 s and batches
	// with other active jobs into a single /task/status call.
	j.SetStage("processing", pct)
}

// handleError classifies a job-phase error and queues a terminal status.
//
// The actual /task/status delivery happens in the worker status loop via
// Manager.SnapshotStatuses — all this method does is:
//
//   - Return nil for errors the server already knows about (ErrJobNotFound).
//   - Queue "aborted" for worker-self-aborts (transient download, context
//     cancelled by operator/status-silence). The server requeues these.
//   - Queue "failed" for real errors (R2 403, transcode failure, etc.).
//   - Propagate ErrFFmpegFatal so the worker main loop can shut down.
func (j *Job) handleError(phase string, err error) error {
	// Job was deleted from server (404 propagated up from some earlier call).
	// Nothing to report — the server already forgot about it.
	if errors.Is(err, api.ErrJobNotFound) {
		j.Progress.Remove(j.JobID)
		j.UI.FinishJob(j.JobID, fmt.Sprintf("gone from server (phase: %s)", phase))
		return nil
	}

	// Transient download failure — requeue rather than fail the job.
	// 403 from R2 (errSourceForbidden) falls through to the "failed" branch below.
	if errors.Is(err, errTransientDownload) {
		j.UI.Logf("[%s] download error (will requeue): %v", j.JobID, err)
		j.MarkAborted(fmt.Sprintf("%s: %s", phase, err.Error()))
		j.Progress.Remove(j.JobID)
		j.UI.FinishJob(j.JobID, fmt.Sprintf("aborted (phase: %s, will requeue)", phase))
		return nil
	}

	// Worker-initiated abort (graceful shutdown, operator cancel, or the
	// status loop's 60-second silence watchdog).
	if j.ctx.Err() != nil {
		j.MarkAborted(fmt.Sprintf("%s: worker cancelled", phase))
		j.Progress.Remove(j.JobID)
		j.UI.FinishJob(j.JobID, fmt.Sprintf("aborted (phase: %s)", phase))
		return nil
	}

	// FFmpeg binary missing — fatal worker error.
	// Do NOT queue a terminal status; the server's processing-timeout will
	// requeue on its own, and we need to shut down the worker regardless.
	if errors.Is(err, transcoder.ErrFFmpegMissing) {
		j.Progress.Remove(j.JobID)
		j.UI.FinishJob(j.JobID, fmt.Sprintf("ERROR: FFmpeg binary missing during %s", phase))
		return fmt.Errorf("%w: detected during %s of job %s", ErrFFmpegFatal, phase, j.JobID)
	}

	// Real error — queue "failed" so it lands in the next status tick.
	errMsg := fmt.Sprintf("%s: %s", phase, err.Error())
	j.MarkFailed(errMsg)
	j.Progress.Remove(j.JobID)
	j.UI.FinishJob(j.JobID, fmt.Sprintf("ERROR: failed at %s: %v", phase, err))
	return fmt.Errorf("job %s failed at %s: %w", j.JobID, phase, err)
}

// runCMAF drives the CMAF (fMP4 HLS + DASH) processing branch.
//
// Video and audio run in parallel — two ffmpeg processes, one per track —
// because each uses its own encoder/codec and there's no muxing benefit to
// serialising them the way the TS pipeline does. Profiles within the video
// track are still serial to avoid oversubscribing the GPU (a single encoder
// slot from Manager backs this whole job).
//
// Progress reporting: video reports `(done*100 + pct) / N` local %, audio
// reports 0–50 during loudnorm analyze + 50–100 during encode (or 0–100 if
// norm is off). The global server-reported pct is `10 + min(V,A)*80/100`
// so the bar only advances when *both* tracks are making progress — a
// deliberate choice so a fast audio track can't peg the pct at 100 while
// the video is still grinding.
//
// On success, produces master.m3u8 + manifest.mpd + per-track playlists,
// init segments, and .m4s segments — ready for upload by the caller.
func (j *Job) runCMAF(probe *transcoder.ProbeResult) error {
	profiles := transcoder.FilterProfiles(probe, j.OutputProfiles)
	profiles = transcoder.ApplyBitrateCaps(j.JobID, profiles, probe.Height, probe.VideoBitrateKbps)
	if len(profiles) == 0 {
		return fmt.Errorf("no suitable output profiles for source %dx%d", probe.Width, probe.Height)
	}

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	audioName := fmt.Sprintf("aac_%dk", j.AudioBitrateKbps)
	audioDir := filepath.Join(j.outputDir, "audio", audioName)
	os.MkdirAll(audioDir, 0755)

	j.UI.UpdateStage(j.JobID, "processing", 10)
	j.Progress.Update(j.JobID, "processing", 10)
	j.SetStage("processing", 10)

	// Shared V / A progress state; min(V,A) drives the server-reported pct.
	var (
		vaMu     sync.Mutex
		videoPct int
		audioPct int
	)
	publish := func() {
		vaMu.Lock()
		v, a := videoPct, audioPct
		vaMu.Unlock()
		m := v
		if a < m {
			m = a
		}
		globalPct := 10 + m*80/100
		// TTY shows both V and A side by side; server-reported pct stays on
		// min(V,A) so the progress bar only advances when both tracks do.
		j.UI.UpdateStageProgressVA(j.JobID, v, a)
		j.Progress.Update(j.JobID, "processing", globalPct)
		j.SetStage("processing", globalPct)
	}
	updateV := func(p int) {
		if p < 0 {
			p = 0
		}
		if p > 100 {
			p = 100
		}
		vaMu.Lock()
		videoPct = p
		vaMu.Unlock()
		publish()
	}
	updateA := func(p int) {
		if p < 0 {
			p = 0
		}
		if p > 100 {
			p = 100
		}
		vaMu.Lock()
		audioPct = p
		vaMu.Unlock()
		publish()
	}

	// Derived context: cancel on first-track failure so the other track stops.
	egCtx, egCancel := context.WithCancel(j.ctx)
	defer egCancel()

	var (
		wg      sync.WaitGroup
		errMu   sync.Mutex
		firstErr error
	)
	recordErr := func(err error) {
		if err == nil {
			return
		}
		errMu.Lock()
		defer errMu.Unlock()
		if firstErr == nil {
			firstErr = err
			egCancel() // stop the peer track
		}
	}

	// --- Video goroutine ---
	wg.Add(1)
	go func() {
		defer wg.Done()

		totalProfiles := len(profiles)
		encoder := j.initialEncoder
		if j.failedTypes[encoder.EncoderType] {
			var err error
			encoder, err = j.Manager.NextEncoder(j.failedTypes)
			if err != nil {
				recordErr(fmt.Errorf("no encoder available: %w", err))
				return
			}
		}

		for i, p := range profiles {
			if err := egCtx.Err(); err != nil {
				recordErr(fmt.Errorf("aborted: %w", err))
				return
			}

			profileVideoDir := filepath.Join(j.outputDir, "video", p.Name)
			os.MkdirAll(profileVideoDir, 0755)

			profileStart := (i * 100) / totalProfiles
			profileEnd := ((i + 1) * 100) / totalProfiles

			onLocalProgress := func(pct int) {
				if pct < 0 {
					pct = 0
				}
				if pct > 100 {
					pct = 100
				}
				overall := profileStart + (profileEnd-profileStart)*pct/100
				updateV(overall)
			}

			if err := j.cmafVideoProfile(egCtx, &encoder, sourcePath, profileVideoDir, p, probe, onLocalProgress); err != nil {
				recordErr(fmt.Errorf("video profile %s: %w", p.Name, err))
				return
			}
			updateV(profileEnd)
		}
		updateV(100)
	}()

	// --- Audio goroutine ---
	wg.Add(1)
	go func() {
		defer wg.Done()

		// Pass 1: loudnorm analysis. Progress maps onto 0–50% of the audio
		// bar when norm is actually going to run; when it's off (or skipped)
		// the analyze call returns "" immediately and the encode owns the
		// full 0–100 range.
		normWillRun := j.AudioNormalization && probe.AudioCodec != ""
		analyzeProgress := func(pct int) {
			if normWillRun {
				updateA(pct / 2)
			}
		}
		loudnormFilter, err := j.analyzeLoudnessCMAF(probe, analyzeProgress)
		if err != nil {
			recordErr(fmt.Errorf("audio analyze: %w", err))
			return
		}

		// Pass 2: encode. Re-check against the actual filter string — if
		// analysis skipped (source silent, loudnorm bailed, etc.) the filter
		// is empty and we remap encode to 0–100.
		encodeProgress := func(pct int) {
			if loudnormFilter != "" {
				updateA(50 + pct/2)
			} else {
				updateA(pct)
			}
		}

		logFile := ffmpegLogPath(j.JobID, "audio", "cmaf-audio")
		segDur := profiles[0].SegmentDuration
		err = transcoder.TranscodeAudioCMAF(
			egCtx, sourcePath, audioDir,
			j.AudioBitrateKbps, segDur, loudnormFilter,
			probe.DurationSeconds, encodeProgress, logFile,
		)
		if err != nil {
			recordErr(fmt.Errorf("audio: %w", err))
			return
		}

		// Verify the fMP4 init segment is where we expect it. ffmpeg's HLS
		// muxer has historically put init.mp4 in the CWD when the playlist
		// path contained backslashes — catching that here surfaces the
		// failure at the ffmpeg boundary rather than much later at
		// ProbeCodecString / playback.
		if vErr := verifyCMAFInit(audioDir, logFile); vErr != nil {
			recordErr(fmt.Errorf("audio: %w", vErr))
		}
	}()

	wg.Wait()
	if firstErr != nil {
		return firstErr
	}

	// Rewrite per-rendition playlists so segment + init URIs carry {$verify}.
	for _, p := range profiles {
		pl := filepath.Join(j.outputDir, "video", p.Name, "playlist.m3u8")
		if err := transcoder.RewritePlaylistHMAC(pl); err != nil {
			return fmt.Errorf("rewrite video playlist %s: %w", p.Name, err)
		}
	}
	if err := transcoder.RewritePlaylistHMAC(filepath.Join(audioDir, "playlist.m3u8")); err != nil {
		return fmt.Errorf("rewrite audio playlist: %w", err)
	}

	// Build variants by probing each init.mp4 for its RFC 6381 codec string.
	// A missing string is non-fatal — WriteMasterPlaylistCMAF / WriteDASHManifest
	// fall back to a conservative default so the manifests still validate.
	variants := make([]transcoder.CMAFVariant, 0, len(profiles))
	for _, p := range profiles {
		initPath := filepath.Join(j.outputDir, "video", p.Name, "init.mp4")
		codecStr, err := transcoder.ProbeCodecString(initPath)
		if err != nil {
			j.UI.Logf("[%s] WARN: could not probe codec for %s: %v", j.JobID, p.Name, err)
			codecStr = ""
		}
		outFps := int(probe.FrameRate + 0.5)
		if outFps <= 0 {
			outFps = 30
		}
		if p.FpsLimit > 0 && outFps > p.FpsLimit {
			outFps = p.FpsLimit
		}
		variants = append(variants, transcoder.CMAFVariant{
			Name:             p.Name,
			Width:            p.Width,
			Height:           p.Height,
			VideoBitrateKbps: p.VideoBitrateKbps,
			Codecs:           codecStr,
			FrameRate:        outFps,
		})
	}

	if err := transcoder.WriteMasterPlaylistCMAF(j.outputDir, variants, audioName, j.AudioBitrateKbps); err != nil {
		return fmt.Errorf("write CMAF master playlist: %w", err)
	}
	if err := transcoder.WriteDASHManifest(j.outputDir, variants, audioName, j.AudioBitrateKbps, probe.DurationSeconds, profiles[0].SegmentDuration); err != nil {
		return fmt.Errorf("write DASH manifest: %w", err)
	}

	return nil
}

// cmafVideoProfile encodes one CMAF video profile with the same encoder-tier
// fallback strategy used by transcodeProfile (TS path):
//
//	tier 1: hw decode + hw encode (full GPU)  [if supported]
//	tier 2: sw decode + hw encode
//	next:   fall over to the next encoder type (Manager.NextEncoder)
//
// encoder is a *config.Encoder so a successful fallback persists across
// profiles (once a type has failed on this job we stop trying it). Remux
// takes a disjoint path: it's either applicable (copy + mux only, no encoder
// involved) or we transcode.
func (j *Job) cmafVideoProfile(ctx context.Context, encoder *config.Encoder, sourcePath, profileDir string, profile transcoder.FilteredProfile, probe *transcoder.ProbeResult, onProgress func(int)) error {
	// Remux first if eligible. CMAF remux is the simplest case — video copy,
	// no audio, no encryption — so no encoder fallback applies; a failure
	// just drops us into the transcode path below.
	if profile.CanRemux {
		j.UI.Logf("[%s] remuxing %s (cmaf)...", j.JobID, profile.Name)
		remuxLog := ffmpegLogPath(j.JobID, profile.Name, "cmaf-remux")
		progressCh, errCh := transcoder.RemuxVideoCMAF(ctx, sourcePath, profileDir, profile.OutputProfile, probe.DurationSeconds, remuxLog)
		for pct := range progressCh {
			onProgress(pct)
		}
		err := <-errCh
		if err == nil {
			// Gate remux success on the init segment actually landing in
			// profileDir (see verifyCMAFInit for the Windows hls muxer
			// backstory). If it's missing, fall back to transcode instead
			// of declaring a silent failure.
			if vErr := verifyCMAFInit(profileDir, remuxLog); vErr != nil {
				j.UI.Logf("[%s] WARN: cmaf remux for %s produced no init.mp4, falling back to transcode: %v", j.JobID, profile.Name, vErr)
				os.RemoveAll(profileDir)
				os.MkdirAll(profileDir, 0755)
			} else {
				j.UI.Logf("[%s] remux successful: %s (cmaf)", j.JobID, profile.Name)
				return nil
			}
		} else {
			if ctx.Err() != nil {
				return fmt.Errorf("aborted: %w", ctx.Err())
			}
			if errors.Is(err, transcoder.ErrFFmpegMissing) {
				return err
			}
			j.UI.Logf("[%s] WARN: cmaf remux failed for %s, falling back to transcode: %v", j.JobID, profile.Name, err)
			os.RemoveAll(profileDir)
			os.MkdirAll(profileDir, 0755)
		}
	}

	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("aborted: %w", err)
		}

		swDecode := !hwDecodeAvailable(encoder.EncoderType) || j.hwDecodeFailed[encoder.EncoderType]

		var tierLabel string
		switch {
		case encoder.EncoderType == hardware.EncoderSW:
			tierLabel = "cmaf-sw"
			j.UI.Logf("[%s] cmaf transcoding %s with software (libx264)", j.JobID, profile.Name)
		case swDecode:
			tierLabel = "cmaf-vt-swdec"
			j.UI.Logf("[%s] cmaf transcoding %s with %s (sw decode + hw encode)", j.JobID, profile.Name, encoder.EncoderType)
		default:
			tierLabel = "cmaf-vt-hwdec"
			j.UI.Logf("[%s] cmaf transcoding %s with %s (hw decode + hw encode)", j.JobID, profile.Name, encoder.EncoderType)
		}

		onProgress(0)

		logFile := ffmpegLogPath(j.JobID, profile.Name, tierLabel)
		progressCh, errCh := transcoder.TranscodeVideoCMAF(ctx, sourcePath, profileDir, profile.OutputProfile, *encoder, probe.DurationSeconds, swDecode, logFile, probe.Width, probe.Height, probe.FrameRate)

		for pct := range progressCh {
			onProgress(pct)
		}

		err := <-errCh
		if err == nil {
			// Same defensive init.mp4 check as the remux path.
			if vErr := verifyCMAFInit(profileDir, logFile); vErr != nil {
				j.UI.Logf("[%s] WARN: cmaf transcode for %s produced no init.mp4: %v", j.JobID, profile.Name, vErr)
				return vErr
			}
			j.UI.Logf("[%s] transcoded %s successfully (cmaf)", j.JobID, profile.Name)
			return nil
		}

		if ctx.Err() != nil {
			return fmt.Errorf("aborted during transcode: %w", ctx.Err())
		}
		if errors.Is(err, transcoder.ErrFFmpegMissing) {
			return err
		}

		if !swDecode {
			j.UI.Logf("[%s] WARN: %s full-GPU failed for %s (cmaf), retrying with sw decode: %v", j.JobID, encoder.EncoderType, profile.Name, err)
			j.hwDecodeFailed[encoder.EncoderType] = true
			os.RemoveAll(profileDir)
			os.MkdirAll(profileDir, 0755)
			continue
		}

		j.UI.Logf("[%s] WARN: %s exhausted for %s (cmaf), trying next encoder: %v", j.JobID, encoder.EncoderType, profile.Name, err)
		j.failedTypes[encoder.EncoderType] = true
		os.RemoveAll(profileDir)
		os.MkdirAll(profileDir, 0755)

		next, nextErr := j.Manager.NextEncoder(j.failedTypes)
		if nextErr != nil {
			return fmt.Errorf("all encoders failed for profile %s: %w", profile.Name, nextErr)
		}
		*encoder = next
	}
}

func (j *Job) cleanup() {
	if j.tempDir != "" {
		util.CleanupTempDir(j.JobID)
	}
}

// verifyCMAFInit confirms that {dir}/init.mp4 was produced (non-empty) after
// a CMAF ffmpeg run completes. ffmpeg's HLS muxer locates fmp4_init_filename
// by running strrchr('/') over the playlist URL string; on Windows the native
// backslash paths used to send init.mp4 to the worker's CWD while ffmpeg still
// returned exit 0. The main fix lives in transcoder/cmaf.go (all paths are
// ToSlash'd before being handed to ffmpeg), but this check is the belt: if a
// future build of ffmpeg, a third encoder option, or some other quirk puts
// the init segment somewhere unexpected, we catch it here with a directory
// listing and the ffmpeg log path so diagnosis is trivial — instead of
// showing up hours later as a 404 in the browser.
func verifyCMAFInit(dir, logFile string) error {
	initPath := filepath.Join(dir, "init.mp4")
	if st, err := os.Stat(initPath); err == nil && st.Size() > 0 {
		return nil
	}
	var names []string
	if entries, derr := os.ReadDir(dir); derr == nil {
		for _, e := range entries {
			names = append(names, e.Name())
		}
	}
	return fmt.Errorf("init.mp4 missing from %s (produced: %v; ffmpeg log: %s)", dir, names, logFile)
}
