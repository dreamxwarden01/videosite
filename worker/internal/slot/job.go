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
	JobID          string
	VideoID        int
	DownloadURL    string
	EncryptionKey  string // hex-encoded AES-128 key (empty = no encryption)
	Manager        *Manager
	Progress       *progress.Tracker

	ctx            context.Context
	cancel         context.CancelFunc
	failedTypes    map[string]bool
	initialEncoder config.Encoder // encoder assigned when the slot was acquired (includes device index)
	hwDecodeFailed map[string]bool // per encoder-type: true if full-GPU (hw decode) path failed this job
	tempDir        string
	outputDir      string
	duration       float64
	phase          atomic.Value // current phase: "downloading", "probing", "transcoding", "uploading", "completing"
}

// NewJob creates a new job.
// The job context is always rooted at context.Background() — it is NOT derived
// from the worker context. This means the worker can cancel its own poll loop
// (w.cancel) without affecting active jobs; jobs are cancelled individually
// via job.Cancel() when the worker needs to abort them.
func NewJob(jobID string, videoID int, downloadURL string, encryptionKey string, initialEncoder config.Encoder, mgr *Manager, tracker *progress.Tracker) *Job {
	jobCtx, cancel := context.WithCancel(context.Background())
	j := &Job{
		JobID:          jobID,
		VideoID:        videoID,
		DownloadURL:    downloadURL,
		EncryptionKey:  encryptionKey,
		Manager:        mgr,
		Progress:       tracker,
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

// Run executes the full job lifecycle: download → probe → transcode → upload → complete.
func (j *Job) Run() error {
	defer j.cancel()
	defer j.Manager.ReleaseSlot(j.JobID)
	defer j.cleanup()

	fmt.Printf("%s [%s] job started (video %d, encoder %s device %d)\n", util.Ts(), j.JobID, j.VideoID, j.initialEncoder.EncoderType, j.initialEncoder.DeviceIndex)

	// 1. DOWNLOAD
	j.phase.Store("downloading")
	if err := j.download(); err != nil {
		return j.handleError("download", err)
	}

	// 2. PROBE
	j.phase.Store("probing")
	probe, err := j.probe()
	if err != nil {
		return j.handleError("probe", err)
	}

	// 3. ANALYZE AUDIO (loudness, for normalization)
	loudnormFilter, err := j.analyzeLoudness(probe)
	if err != nil {
		return j.handleError("audio analysis", err)
	}

	// 4. TRANSCODE
	j.phase.Store("transcoding")
	profiles, err := j.transcode(probe, loudnormFilter)
	if err != nil {
		return j.handleError("transcode", err)
	}

	// 6. GENERATE MASTER PLAYLIST
	if err := j.generateMasterPlaylist(profiles); err != nil {
		return j.handleError("master playlist", err)
	}

	// 7. UPLOAD
	j.phase.Store("uploading")
	if err := j.upload(); err != nil {
		return j.handleError("upload", err)
	}

	// 8. COMPLETE (with retry — all work is done, don't waste it)
	j.phase.Store("completing")
	err = api.RetryWithBackoff(j.ctx, "report completion", func() error {
		return api.Complete(j.ctx, j.JobID, j.duration)
	})
	if err != nil && !errors.Is(err, api.ErrJobNotFound) {
		fmt.Printf("%s [%s] ERROR: failed to report completion: %v\n", util.Ts(), j.JobID, err)
	}
	// ErrJobNotFound here means the job was deleted while we were uploading.
	// Upload is done, R2 files exist. Server's delayed R2 cleanup handles it.

	j.Progress.Remove(j.JobID)
	fmt.Printf("%s [%s] completed\n", util.Ts(), j.JobID)
	return nil
}

func (j *Job) download() error {
	j.tempDir = util.TempDir(j.JobID)
	j.outputDir = filepath.Join(j.tempDir, "output")
	os.MkdirAll(j.tempDir, 0755)

	j.Progress.Update(j.JobID, "downloading", 0)

	// Report status to server (non-fatal, 404 → abort)
	err := api.UpdateStatus(j.ctx, j.JobID, "leased", 0, "worker_downloading", 0)
	if errors.Is(err, api.ErrJobNotFound) {
		return fmt.Errorf("aborted: job no longer exists")
	}
	if err != nil {
		fmt.Printf("%s [%s] WARN: failed to report download start: %v\n", util.Ts(), j.JobID, err)
	}

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
		fmt.Printf("%s [%s] no Content-Length from R2, using single-connection download\n", util.Ts(), j.JobID)
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
				fmt.Printf("%s [%s] WARN: R2 request error, retrying (%d/%d): %v\n", util.Ts(), j.JobID, i+1, len(delays), err)
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
				fmt.Printf("%s [%s] WARN: R2 5xx (status %d), retrying (%d/%d)\n", util.Ts(), j.JobID, resp.StatusCode, i+1, len(delays))
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
func (j *Job) downloadMultipart(totalSize int64) error {
	numParts := int((totalSize + downloadPartSize - 1) / downloadPartSize)

	cfg := config.Get()
	concurrency := cfg.ConcurrentDownloads
	if concurrency <= 0 {
		concurrency = 5
	}

	fmt.Printf("%s [%s] downloading %s in %d parts (concurrency %d)\n",
		util.Ts(), j.JobID, formatDownloadBytes(totalSize), numParts, concurrency)

	// Shared atomic byte counter: updated in real-time by all part goroutines.
	var downloaded int64

	// Progress reporting goroutine: fires every 2s for the duration of the download.
	// Console shows local 0-100%; API reports global 0-9% (download phase slice).
	stopProgress := make(chan struct{})
	lastConsolePct := -1
	go func() {
		ticker := time.NewTicker(2 * time.Second)
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
				if localPct != lastConsolePct {
					fmt.Printf("%s [%s] downloading: %d%%\n", util.Ts(), j.JobID, localPct)
					lastConsolePct = localPct
				}
				globalPct := localPct / 10 // 0-9% globally
				if globalPct > 9 {
					globalPct = 9
				}
				j.Progress.Update(j.JobID, "downloading", globalPct)
				err := api.UpdateStatus(j.ctx, j.JobID, "leased", globalPct, "worker_downloading", 0)
				if errors.Is(err, api.ErrJobNotFound) {
					j.cancel()
					return
				}
			}
		}
	}()
	defer close(stopProgress)

	// Derived context: cancelled on first part failure so other parts stop.
	dlCtx, dlCancel := context.WithCancel(j.ctx)
	defer dlCancel()

	// Per-part error storage — one writer per index, no mutex needed.
	partErrors := make([]error, numParts)
	sem := make(chan struct{}, concurrency)

	var wg sync.WaitGroup
	for i := 0; i < numParts; i++ {
		wg.Add(1)
		go func(partNum int) {
			defer wg.Done()

			// Acquire semaphore, abort if already cancelled by another part.
			select {
			case sem <- struct{}{}:
			case <-dlCtx.Done():
				return
			}
			defer func() { <-sem }()

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

	fmt.Printf("%s [%s] download complete\n", util.Ts(), j.JobID)
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
				fmt.Printf("%s [%s] WARN: part %d request error, retrying (%d/%d): %v\n", util.Ts(), j.JobID, partNum, i+1, len(delays), err)
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
				fmt.Printf("%s [%s] WARN: part %d R2 5xx (status %d), retrying (%d/%d)\n", util.Ts(), j.JobID, partNum, resp.StatusCode, i+1, len(delays))
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
			fmt.Printf("%s [%s] WARN: part %d stream error, retrying (%d/%d): %v\n", util.Ts(), j.JobID, partNum, i+1, len(delays), copyErr)
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
	stopCh := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-j.ctx.Done():
				return
			case <-stopCh:
				return
			case <-ticker.C:
				j.Progress.Update(j.JobID, "downloading", 0)
				err := api.UpdateStatus(j.ctx, j.JobID, "leased", 0, "worker_downloading", 0)
				if errors.Is(err, api.ErrJobNotFound) {
					j.cancel()
					return
				}
			}
		}
	}()

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	f, err := os.Create(sourcePath)
	if err != nil {
		close(stopCh)
		return fmt.Errorf("create source file: %w", err)
	}
	_, copyErr := io.Copy(f, io.TeeReader(resp.Body, counter))
	close(stopCh)
	f.Close()
	if copyErr != nil {
		return fmt.Errorf("save source file: %w", copyErr)
	}

	fmt.Printf("%s [%s] download complete\n", util.Ts(), j.JobID)
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
	fmt.Printf("%s [%s] probe complete: %dx%d, %.1fs, %s\n", util.Ts(), j.JobID, probe.Width, probe.Height, probe.DurationSeconds, probe.Codec)

	// Report duration to server (non-fatal, check 404 only)
	err = api.UpdateStatus(j.ctx, j.JobID, "processing", 9, "processing", probe.DurationSeconds)
	if errors.Is(err, api.ErrJobNotFound) {
		return nil, fmt.Errorf("aborted: job no longer exists")
	}
	if err != nil {
		fmt.Printf("%s [%s] WARN: failed to report probe status: %v\n", util.Ts(), j.JobID, err)
	}

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

	fmt.Printf("%s [%s] encryption prepared\n", util.Ts(), j.JobID)
	return keyInfoPath, nil
}

// analyzeLoudness runs a loudnorm pass-1 analysis if audio normalization is
// enabled in config. Returns the loudnorm filter string for pass 2, or "" if
// normalization is disabled or the source has no audio stream.
func (j *Job) analyzeLoudness(probe *transcoder.ProbeResult) (string, error) {
	cfg := config.Get()
	if !cfg.AudioNormalization {
		return "", nil
	}
	if probe.AudioCodec == "" {
		fmt.Printf("%s [%s] audio normalization: no audio stream, skipping\n", util.Ts(), j.JobID)
		return "", nil
	}

	j.Progress.Update(j.JobID, "analyzing audio", 10)
	fmt.Printf("%s [%s] analyzing audio loudness (EBU R128)...\n", util.Ts(), j.JobID)

	// Heartbeat goroutine: keeps the server stale-timer from firing during analysis.
	// Global progress stays at 10% throughout; only console shows local percentage.
	stopHeartbeat := make(chan struct{})
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-j.ctx.Done():
				return
			case <-stopHeartbeat:
				return
			case <-ticker.C:
				err := api.UpdateStatus(j.ctx, j.JobID, "processing", 10, "processing", 0)
				if errors.Is(err, api.ErrJobNotFound) {
					j.cancel()
					return
				}
			}
		}
	}()

	sourcePath := filepath.Join(j.tempDir, "source.mp4")
	lastPct := -1
	stats, err := transcoder.AnalyzeLoudness(j.ctx, sourcePath, j.duration, func(pct int) {
		if pct != lastPct {
			fmt.Printf("%s [%s] analyzing audio: %d%%\n", util.Ts(), j.JobID, pct)
			lastPct = pct
		}
	})
	close(stopHeartbeat)
	if err != nil {
		if j.ctx.Err() != nil {
			return "", fmt.Errorf("aborted: %w", j.ctx.Err())
		}
		// Non-fatal: if analysis fails, proceed without normalization.
		fmt.Printf("%s [%s] WARN: audio loudness analysis failed, skipping normalization: %v\n", util.Ts(), j.JobID, err)
		return "", nil
	}
	if stats == nil {
		fmt.Printf("%s [%s] audio normalization: no audio detected by loudnorm, skipping\n", util.Ts(), j.JobID)
		return "", nil
	}

	gainRequired := cfg.AudioNormalizationTarget - stats.InputI
	fmt.Printf("[%s] audio: measured %.1f LUFS, target %.1f LUFS, gain required %.1f dB (max %.1f dB)\n",
		j.JobID, stats.InputI, cfg.AudioNormalizationTarget, gainRequired, cfg.AudioNormalizationMaxGain)

	filter := transcoder.BuildLoudnormFilter(stats,
		cfg.AudioNormalizationTarget,
		cfg.AudioNormalizationPeak,
		cfg.AudioNormalizationMaxGain,
	)
	return filter, nil
}

func (j *Job) transcode(probe *transcoder.ProbeResult, loudnormFilter string) ([]transcoder.FilteredProfile, error) {
	cfg := config.Get()
	profiles := transcoder.FilterProfiles(probe, cfg.OutputProfiles)
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

	for i, profile := range profiles {
		if err := j.ctx.Err(); err != nil {
			return nil, fmt.Errorf("aborted: %w", err)
		}

		profileDir := filepath.Join(j.outputDir, profile.Name)
		fmt.Printf("%s [%s] transcoding profile %d/%d: %s\n", util.Ts(), j.JobID, i+1, totalProfiles, profile.Name)

		// Try remux first if eligible.
		// With normalization active, remux copies video but re-encodes audio.
		if profile.CanRemux {
			remuxTier := "remux"
			if loudnormFilter != "" {
				remuxTier = "remux+norm"
				fmt.Printf("%s [%s] remuxing %s (copy video, normalize audio)\n", util.Ts(), j.JobID, profile.Name)
			} else {
				fmt.Printf("%s [%s] remuxing %s\n", util.Ts(), j.JobID, profile.Name)
			}
			remuxLog := ffmpegLogPath(j.JobID, profile.Name, remuxTier)
			err := j.remuxProfile(sourcePath, profileDir, profile, keyInfoFile, remuxLog, i, totalProfiles, loudnormFilter)
			if err == nil {
				fmt.Printf("%s [%s] remux successful: %s\n", util.Ts(), j.JobID, profile.Name)
				j.reportProfileProgress(i, totalProfiles)
				continue
			}
			if j.ctx.Err() != nil {
				return nil, fmt.Errorf("aborted: %w", j.ctx.Err())
			}
			if errors.Is(err, transcoder.ErrFFmpegMissing) {
				return nil, err // Fatal — propagate without falling back to transcode
			}
			fmt.Printf("%s [%s] WARN: remux failed for %s, falling back to transcode: %v\n", util.Ts(), j.JobID, profile.Name, err)
			os.RemoveAll(profileDir) // Clean up failed remux
		}

		// Transcode with encoder fallback
		if err := j.transcodeProfile(sourcePath, profileDir, profile, probe.DurationSeconds, i, totalProfiles, keyInfoFile, probe.Width, probe.Height, loudnormFilter); err != nil {
			return nil, err
		}

		j.reportProfileProgress(i, totalProfiles)
	}

	return profiles, nil
}

// remuxProfile runs a remux for one profile and reports progress to the console
// and server on the same 2-second heartbeat cadence as transcode.
// loudnormFilter is passed through to RemuxToHLS: when non-empty, video is
// stream-copied and audio is re-encoded with normalization applied.
// Returns nil on success, a non-nil error on failure or FFmpeg missing.
// The caller must check j.ctx.Err() after a non-nil return to distinguish
// an abort from a genuine remux failure (which should fall back to transcode).
func (j *Job) remuxProfile(sourcePath, profileDir string, profile transcoder.FilteredProfile, keyInfoFile, logFile string, profileIndex, totalProfiles int, loudnormFilter string) error {
	profileShare := 80.0 / float64(totalProfiles) // each profile's share of the 10-90% range

	progressCh, errCh := transcoder.RemuxToHLS(
		j.ctx, sourcePath, profileDir, profile.OutputProfile, keyInfoFile, logFile, j.duration, loudnormFilter,
	)

	lastReport := time.Now().Add(-3 * time.Second) // allow first report immediately
	lastConsolePct := -1
	for pct := range progressCh {
		if pct != lastConsolePct {
			fmt.Printf("%s [%s] remuxing %s: %d%%\n", util.Ts(), j.JobID, profile.Name, pct)
			lastConsolePct = pct
		}
		j.Progress.Update(j.JobID, fmt.Sprintf("remuxing %s", profile.Name), pct)

		if time.Since(lastReport) >= 2*time.Second {
			globalPct := 10 + int(float64(profileIndex)*profileShare+float64(pct)/100.0*profileShare)
			err := api.UpdateStatus(j.ctx, j.JobID, "processing", globalPct, "processing", 0)
			if errors.Is(err, api.ErrJobNotFound) {
				j.cancel()
				break
			}
			if err != nil {
				fmt.Printf("%s [%s] WARN: failed to report remux progress: %v\n", util.Ts(), j.JobID, err)
			}
			lastReport = time.Now()
		}
	}
	// Drain any remaining items so the FFmpeg goroutine can close the channel.
	for range progressCh {}

	return <-errCh
}

func (j *Job) transcodeProfile(sourcePath, profileDir string, profile transcoder.FilteredProfile, duration float64, profileIndex, totalProfiles int, keyInfoFile string, srcW, srcH int, loudnormFilter string) error {
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

	// profileShare is this profile's slice of the 10-90% transcoding range.
	profileShare := 80.0 / float64(totalProfiles)

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
			fmt.Printf("%s [%s] transcoding %s with software (libx264)\n", util.Ts(), j.JobID, profile.Name)
		case swDecode:
			tierLabel = "vt-swdec"
			fmt.Printf("%s [%s] transcoding %s with %s (sw decode + hw encode)\n", util.Ts(), j.JobID, profile.Name, encoder.EncoderType)
		default:
			tierLabel = "vt-hwdec"
			fmt.Printf("%s [%s] transcoding %s with %s (hw decode + hw encode)\n", util.Ts(), j.JobID, profile.Name, encoder.EncoderType)
		}

		logFile := ffmpegLogPath(j.JobID, profile.Name, tierLabel)
		progressCh, errCh := transcoder.TranscodeToHLS(j.ctx, sourcePath, profileDir, profile.OutputProfile, encoder, duration, keyInfoFile, swDecode, logFile, srcW, srcH, loudnormFilter)

		// Drain progress updates, printing local 0-100% to console and
		// reporting global progress to the server every 2 seconds.
		lastReport := time.Now().Add(-3 * time.Second) // allow first report immediately
		lastConsolePct := -1
		for pct := range progressCh {
			if pct != lastConsolePct {
				fmt.Printf("%s [%s] transcoding %s: %d%%\n", util.Ts(), j.JobID, profile.Name, pct)
				lastConsolePct = pct
			}
			j.Progress.Update(j.JobID, fmt.Sprintf("transcoding %s", profile.Name), pct)

			if time.Since(lastReport) >= 2*time.Second {
				// Map per-profile pct (0-100) into the global 10-90% range.
				globalPct := 10 + int(float64(profileIndex)*profileShare+float64(pct)/100.0*profileShare)
				err := api.UpdateStatus(j.ctx, j.JobID, "processing", globalPct, "processing", 0)
				if errors.Is(err, api.ErrJobNotFound) {
					j.cancel()
					break
				}
				if err != nil {
					fmt.Printf("%s [%s] WARN: failed to report transcode progress: %v\n", util.Ts(), j.JobID, err)
				}
				lastReport = time.Now()
			}
		}
		// Drain any remaining items so the FFmpeg goroutine can close the channel.
		for range progressCh {}

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
			fmt.Printf("%s [%s] WARN: %s full-GPU failed for %s, retrying with sw decode: %v\n", util.Ts(), j.JobID, encoder.EncoderType, profile.Name, err)
			j.hwDecodeFailed[encoder.EncoderType] = true
			os.RemoveAll(profileDir)
			continue // same encoder type, sw decode next iteration
		}

		// Tier-2 also failed (or hw decode never available) — this encoder type is done.
		fmt.Printf("%s [%s] WARN: %s exhausted for %s, trying next encoder: %v\n", util.Ts(), j.JobID, encoder.EncoderType, profile.Name, err)
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
	if err := transcoder.WriteMasterPlaylist(j.outputDir, profiles); err != nil {
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

	// Collect all output files (only needs to be done once)
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
		tasks = append(tasks, uploadTask{relPath: relPath, absPath: path})
		return nil
	})
	if walkErr != nil {
		return fmt.Errorf("collect output files: %w", walkErr)
	}
	if len(tasks) == 0 {
		return fmt.Errorf("no output files to upload")
	}

	// 1. Report upload start (non-fatal, check 404)
	err := api.UpdateStatus(j.ctx, j.JobID, "processing", 90, "worker_uploading", 0) // 90-100% for upload
	if errors.Is(err, api.ErrJobNotFound) {
		return fmt.Errorf("aborted: job no longer exists")
	}
	if err != nil {
		fmt.Printf("%s [%s] WARN: failed to report upload start: %v\n", util.Ts(), j.JobID, err)
	}

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

// doUploadWithMonitoring performs the actual upload with a background goroutine
// that monitors API reachability. If upload progress reports fail continuously
// for 60 seconds, the upload is cancelled and an error is returned.
//
// ctx is j.ctx — the job's own context (rooted at Background, not the worker ctx).
// uploadCtx is derived from ctx and also cancelled on the 60-second API failure
// detection path, so all upload goroutines stop cleanly in both cases.
//
// Each UpdateStatus call in the monitoring goroutine uses its own 10-second
// timeout context (not ctx/uploadCtx) so that a hanging server is detected
// promptly regardless of other cancellation signals.
func (j *Job) doUploadWithMonitoring(ctx context.Context, tasks []uploadTask, allURLs map[string]string) error {
	cfg := config.Get()
	concurrency := cfg.ConcurrentUploads
	if concurrency <= 0 {
		concurrency = 10
	}

	totalFiles := len(tasks)
	var uploaded int64 // atomic counter shared across both passes

	fmt.Printf("%s [%s] uploading %d files\n", util.Ts(), j.JobID, totalFiles)

	// uploadCtx wraps ctx: cancelled on 60s API failure so uploads stop.
	apiFailCh := make(chan struct{})
	uploadCtx, uploadCancel := context.WithCancel(ctx)
	defer uploadCancel()

	// Background progress reporter with API failure detection.
	// Each UpdateStatus uses a fresh 10-second timeout so a hanging server
	// is caught within one tick cycle, not after the full client timeout.
	// Console shows local 0-100%; API reports global 90-100%.
	stopProgress := make(chan struct{})
	defer close(stopProgress)
	lastConsolePct := -1
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var firstFailure time.Time
		for {
			select {
			case <-uploadCtx.Done():
				return
			case <-stopProgress:
				return
			case <-ticker.C:
				n := atomic.LoadInt64(&uploaded)
				filePct := int(float64(n) / float64(totalFiles) * 100)
				if filePct != lastConsolePct {
					fmt.Printf("%s [%s] uploading: %d%%\n", util.Ts(), j.JobID, filePct)
					lastConsolePct = filePct
				}
				globalPct := 90 + filePct/10 // 90-100%
				j.Progress.Update(j.JobID, "uploading", globalPct)

				updateCtx, updateCancel := context.WithTimeout(context.Background(), 10*time.Second)
				err := api.UpdateStatus(updateCtx, j.JobID, "processing", globalPct, "worker_uploading", 0)
				updateCancel()

				if errors.Is(err, api.ErrJobNotFound) {
					j.cancel() // job deleted — abort immediately
					return
				}
				if err != nil {
					if firstFailure.IsZero() {
						firstFailure = time.Now()
					} else if time.Since(firstFailure) >= 60*time.Second {
						close(apiFailCh) // signal upload abort
						uploadCancel()
						return
					}
				} else {
					firstFailure = time.Time{} // reset on success
				}
			}
		}
	}()

	// First pass: upload everything
	failed, anyForbidden, firstErr := j.uploadConcurrent(uploadCtx, tasks, allURLs, concurrency, totalFiles, &uploaded)
	if len(failed) == 0 {
		fmt.Printf("%s [%s] upload complete\n", util.Ts(), j.JobID)
		return nil
	}

	// Check if API failure triggered the abort
	select {
	case <-apiFailCh:
		return fmt.Errorf("server API unreachable for 60s during upload")
	default:
	}

	// Check for job abort
	if ctx.Err() != nil {
		return fmt.Errorf("aborted during upload: %w", ctx.Err())
	}

	// If only 5xx errors and no 403, token refresh won't help — fail immediately
	if !anyForbidden {
		return fmt.Errorf("upload failed: %w", firstErr)
	}

	// Token refresh: fetch new URLs for failed files using the job ctx (not
	// uploadCtx, which may have been cancelled by the API-failure path above).
	fmt.Printf("%s [%s] upload token refresh (%d files)\n", util.Ts(), j.JobID, len(failed))
	newURLs, err := j.fetchUploadURLsBatch(ctx, failed)
	if err != nil {
		return fmt.Errorf("refresh upload URLs: %w", err)
	}
	for k, v := range newURLs {
		allURLs[k] = v
	}

	// Second pass: retry failed files with fresh tokens
	failed2, _, firstErr2 := j.uploadConcurrent(uploadCtx, failed, allURLs, concurrency, totalFiles, &uploaded)

	// Check API failure again
	select {
	case <-apiFailCh:
		return fmt.Errorf("server API unreachable for 60s during upload")
	default:
	}

	if ctx.Err() != nil {
		return fmt.Errorf("aborted during upload retry: %w", ctx.Err())
	}
	if len(failed2) > 0 {
		if firstErr2 != nil {
			return fmt.Errorf("upload failed after token refresh: %w", firstErr2)
		}
		return fmt.Errorf("upload failed after token refresh: %d files could not be uploaded", len(failed2))
	}

	fmt.Printf("%s [%s] upload complete (after token refresh)\n", util.Ts(), j.JobID)
	return nil
}

// uploadConcurrent uploads a slice of uploadTasks concurrently.
//
//   - Respects j.ctx for job-level cancellation.
//   - On 403 (ErrUploadForbidden): cancels remaining in-flight uploads and
//     returns all unfinished tasks in failed (so the caller can refresh tokens).
//   - Returns (failed tasks, anyForbidden, first non-cancellation error).
func (j *Job) uploadConcurrent(
	ctx context.Context,
	tasks []uploadTask,
	urls map[string]string,
	concurrency, totalFiles int,
	uploaded *int64,
) (failed []uploadTask, anyForbidden bool, firstErr error) {
	type uploadResult struct {
		task      uploadTask
		err       error
		forbidden bool
	}

	// Derived context: cancelled on 403 to stop remaining goroutines quickly.
	uploadCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	sem := make(chan struct{}, concurrency)
	resultCh := make(chan uploadResult, len(tasks))

	var wg sync.WaitGroup
	for _, t := range tasks {
		wg.Add(1)
		go func(task uploadTask) {
			defer wg.Done()

			// Acquire semaphore slot, respecting cancellation
			select {
			case sem <- struct{}{}:
			case <-uploadCtx.Done():
				resultCh <- uploadResult{task: task, err: uploadCtx.Err()}
				return
			}
			defer func() { <-sem }()

			url := urls[task.relPath]
			if url == "" {
				resultCh <- uploadResult{task: task, err: fmt.Errorf("no presigned URL for %s", task.relPath)}
				return
			}

			err := api.UploadFile(uploadCtx, task.absPath, url)
			if err == nil {
				n := atomic.AddInt64(uploaded, 1)
				localPct := int(float64(n) / float64(totalFiles) * 100)
				j.Progress.Update(j.JobID, "uploading", 90+localPct/10)
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
		urls, err := api.GetUploadURLs(ctx, j.JobID, names[i:end])
		if err != nil {
			return nil, err
		}
		for k, v := range urls {
			allURLs[k] = v
		}
	}
	return allURLs, nil
}

func (j *Job) reportProfileProgress(completedIndex, totalProfiles int) {
	pct := 10 + int(float64(completedIndex+1)/float64(totalProfiles)*80) // 10-90% range for transcoding
	j.Progress.Update(j.JobID, "transcoding", pct)

	// Report to server with retry (profile completion is a critical checkpoint)
	err := api.RetryWithBackoff(j.ctx, "report profile completion", func() error {
		return api.UpdateStatus(j.ctx, j.JobID, "processing", pct, "processing", 0)
	})
	if errors.Is(err, api.ErrJobNotFound) {
		j.cancel()
	}
	// context cancel errors are handled by the caller checking j.ctx.Err()
}

func (j *Job) handleError(phase string, err error) error {
	// Job was deleted from server (404) — not a real error
	if errors.Is(err, api.ErrJobNotFound) {
		fmt.Printf("%s [%s] job no longer exists on server (phase: %s)\n", util.Ts(), j.JobID, phase)
		j.Progress.Remove(j.JobID)
		return nil // Don't blocklist
	}

	// Transient download failure — requeue for another attempt rather than failing the job.
	// 403 from R2 (errSourceForbidden) is NOT transient and falls through to ReportError below.
	if errors.Is(err, errTransientDownload) {
		fmt.Printf("%s [%s] download error (will requeue): %v\n", util.Ts(), j.JobID, err)
		reportCtx, reportCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer reportCancel()
		if reportErr := api.ReportAbort(reportCtx, j.JobID); reportErr != nil {
			if !errors.Is(reportErr, api.ErrJobNotFound) {
				fmt.Printf("%s [%s] WARN: failed to report abort: %v\n", util.Ts(), j.JobID, reportErr)
			}
		}
		j.Progress.Remove(j.JobID)
		return nil // not a real error — don't blocklist
	}

	// Worker-initiated abort (graceful shutdown or 404-triggered cancel)
	if j.ctx.Err() != nil {
		fmt.Printf("%s [%s] aborted (phase: %s)\n", util.Ts(), j.JobID, phase)

		// Report abort so server requeues. Use a background context since
		// j.ctx is already cancelled — we still want this call to go through.
		reportCtx, reportCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer reportCancel()
		if reportErr := api.ReportAbort(reportCtx, j.JobID); reportErr != nil {
			if !errors.Is(reportErr, api.ErrJobNotFound) {
				fmt.Printf("%s [%s] WARN: failed to report abort: %v\n", util.Ts(), j.JobID, reportErr)
			}
		}

		j.Progress.Remove(j.JobID)
		return nil // Not a real error — don't blocklist
	}

	// FFmpeg binary missing — fatal worker error.
	// Do NOT report to server so the task gets released after heartbeat timeout.
	if errors.Is(err, transcoder.ErrFFmpegMissing) {
		fmt.Printf("%s [%s] ERROR: FFmpeg binary missing during %s\n", util.Ts(), j.JobID, phase)
		j.Progress.Remove(j.JobID)
		return fmt.Errorf("%w: detected during %s of job %s", ErrFFmpegFatal, phase, j.JobID)
	}

	// Real error — report to server (best-effort, no retry)
	errMsg := fmt.Sprintf("%s: %s", phase, err.Error())
	fmt.Printf("%s [%s] ERROR: job failed at %s: %v\n", util.Ts(), j.JobID, phase, err)
	reportCtx, reportCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer reportCancel()
	if reportErr := api.ReportError(reportCtx, j.JobID, errMsg); reportErr != nil {
		fmt.Printf("%s [%s] ERROR: failed to report error to server: %v\n", util.Ts(), j.JobID, reportErr)
	}

	j.Progress.Remove(j.JobID)
	return fmt.Errorf("job %s failed at %s: %w", j.JobID, phase, err)
}

func (j *Job) cleanup() {
	if j.tempDir != "" {
		util.CleanupTempDir(j.JobID)
	}
}
