package slot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"videosite-worker/internal/api"
)

// runWithEarlyUpload lets processing proceed independently of the poster. A
// successful processing pass waits for that upload before the ordinary media
// sweep starts, keeping the existing per-job upload concurrency limit intact.
// Every exit cancels and joins the upload before Run can report a terminal
// status, delete its files or release its slot. Cancelling this derived context
// never changes a processing failure into a job-level cancellation.
func runWithEarlyUpload(ctx context.Context, upload func(context.Context) error, process func() error) (string, error) {
	if upload == nil {
		return "processing", process()
	}
	uploadCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	var uploadErr error
	go func() {
		defer close(done)
		uploadErr = upload(uploadCtx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	if err := process(); err != nil {
		return "processing", err
	}
	<-done
	return "upload", uploadErr
}

// uploadPoster deliberately bypasses the final-upload progress ticker: its
// network retries must not replace an in-progress transcode's phase/percentage.
func (j *Job) uploadPoster(ctx context.Context) error {
	file := filepath.Join(j.outputDir, "poster.jpg")
	info, err := os.Stat(file)
	if err != nil {
		return fmt.Errorf("stat poster: %w", err)
	}
	tasks := []uploadTask{{relPath: "poster.jpg", absPath: file, size: info.Size()}}
	urls, err := j.fetchUploadURLsWithRetry(ctx, tasks)
	if err != nil {
		return err
	}
	j.UI.Logf("[%s] poster: uploading", j.JobID)
	var uploaded int64
	_, err = j.uploadFiles(ctx, tasks, urls, &uploaded)
	if err != nil {
		return err
	}
	j.UI.Logf("[%s] poster: upload complete", j.JobID)
	// Readiness is a separate idempotent request. A lost acknowledgement retries
	// only this API operation, preserving the completed PUT and its retry budget.
	return api.ReportPosterReady(ctx, j.JobID)
}
