package api

import "context"

// presignGate serialises all worker-initiated presigned-URL requests so only one
// POST /api/worker/tasks/upload-urls is in flight at a time, process-wide.
//
// The server endpoint internally rate-limits + rolls encryption for each call;
// running 2+ concurrent workers (or 2+ concurrent jobs in one worker) all
// hitting it at once has occasionally produced race-condition symptoms (stale
// tokens, empty URL maps). Serialising these calls has negligible cost: a
// batch covers the early poster or a media batch, including any 403 refresh.
// Cancelled jobs can leave the queue immediately instead of waiting for
// another job's API request to finish.
//
// PUT uploads themselves stay fully concurrent via util.DynamicGate — only
// the presigned-URL request itself is serialised.
var presignGate = make(chan struct{}, 1)

// GetUploadURLsLocked is a cancellation-aware wrapper around GetUploadURLs. All
// call-sites that need presigned URLs should use this version.
func GetUploadURLsLocked(ctx context.Context, jobID string, filenames []string) (map[string]string, error) {
	select {
	case presignGate <- struct{}{}:
		defer func() { <-presignGate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return GetUploadURLs(ctx, jobID, filenames)
}
