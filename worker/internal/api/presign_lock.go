package api

import (
	"context"
	"sync"
)

// presignMu serialises all worker-initiated presigned-URL requests so only one
// POST /api/worker/tasks/upload-urls is in flight at a time, process-wide.
//
// The server endpoint internally rate-limits + rolls encryption for each call;
// running 2+ concurrent workers (or 2+ concurrent jobs in one worker) all
// hitting it at once has occasionally produced race-condition symptoms (stale
// tokens, empty URL maps). Serialising these calls has negligible cost: a
// single batch is ~50–200 ms and only fires twice per job (initial + any
// 403 refresh), so with N concurrent jobs the worst-case extra wait is on
// the order of (N-1) × 200 ms at upload boundaries, which is dwarfed by the
// actual PUT-to-R2 time.
//
// PUT uploads themselves stay fully concurrent via util.DynamicGate — only
// the presigned-URL request itself is serialised.
var presignMu sync.Mutex

// GetUploadURLsLocked is a mutex-guarded wrapper around GetUploadURLs. All
// call-sites that need presigned URLs should use this version.
func GetUploadURLsLocked(ctx context.Context, jobID string, filenames []string) (map[string]string, error) {
	presignMu.Lock()
	defer presignMu.Unlock()
	return GetUploadURLs(ctx, jobID, filenames)
}
