package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"videosite-worker/internal/config"
)

// ErrCompleteRetriesExhausted is returned when /tasks/complete failed 5× with
// non-fatal errors. The uploaded R2 output is fine — the server's processing
// timeout will eventually requeue on its own.
var ErrCompleteRetriesExhausted = fmt.Errorf("complete retries exhausted")

// AvailableTasksResponse mirrors `GET /api/worker/tasks/available?availableSlot=N`.
type AvailableTasksResponse struct {
	Tasks []struct {
		VideoID int `json:"videoId"`
	} `json:"tasks"`
}

// LeaseResult is one entry in the response to `POST /api/worker/tasks/lease`.
// Status is "leased" (with full spec), "taken" (row lost the race), or "notfound".
//
// AudioBitrateKbps is site-wide; it is no longer carried per-profile.
//
// The server may still serialize legacy fields (videoType, encryptionKey) from
// pre-cleanup deploys; JSON unmarshal silently drops unknown fields, so this
// struct is forward-compatible. Server-side cleanup of those fields is a
// separate, decoupled change.
type LeaseResult struct {
	VideoID int    `json:"videoId"`
	Status  string `json:"status"`

	// Populated only when Status == "leased".
	JobID                     string                 `json:"jobId,omitempty"`
	DownloadURL               string                 `json:"downloadUrl,omitempty"`
	AudioBitrateKbps          int                    `json:"audioBitrateKbps,omitempty"`
	OutputProfiles            []config.OutputProfile `json:"outputProfiles,omitempty"`
	AudioNormalization        bool                   `json:"audioNormalization,omitempty"`
	AudioNormalizationTarget  float64                `json:"audioNormalizationTarget,omitempty"`
	AudioNormalizationPeak    float64                `json:"audioNormalizationPeak,omitempty"`
	AudioNormalizationMaxGain float64                `json:"audioNormalizationMaxGain,omitempty"`
}

type leaseResultsResponse struct {
	Results []LeaseResult `json:"results"`
}

// JobStatus is one entry in the `POST /api/worker/tasks/status` batch.
// Status is "running", "failed", or "aborted".
// For "running", Stage + Progress are required.
// For "failed", ErrorMessage is required.
// Duration is NOT carried here — it's sent exactly once with /tasks/complete
// so videos.duration_seconds receives a single write per job.
type JobStatus struct {
	JobID        string  `json:"jobId"`
	Status       string  `json:"status"`
	Stage        string  `json:"stage,omitempty"`
	Progress     float64 `json:"progress,omitempty"`
	ErrorMessage string  `json:"errorMessage,omitempty"`
}

// JobAck is the per-job response from /tasks/status.
// Ack:false means the server does not recognize this jobId — worker should drop it.
type JobAck struct {
	JobID string `json:"jobId"`
	Ack   bool   `json:"ack"`
}

type statusResponse struct {
	Results []JobAck `json:"results"`
}

// AvailableTasks reserves up to `slots` queued tasks (queued → pending, 10s hold)
// and returns their videoIds. Returns an empty slice when nothing is queued.
func AvailableTasks(ctx context.Context, slots int) ([]int, error) {
	if slots <= 0 {
		return nil, nil
	}
	path := fmt.Sprintf("/api/worker/tasks/available?availableSlot=%d", slots)
	resp, err := doRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	var out AvailableTasksResponse
	if err := decodeJSON(resp, &out); err != nil {
		return nil, fmt.Errorf("decode available tasks: %w", err)
	}

	ids := make([]int, 0, len(out.Tasks))
	for _, t := range out.Tasks {
		ids = append(ids, t.VideoID)
	}
	return ids, nil
}

// LeaseTasks finalises the reservation for each videoId atomically (pending → leased).
// Per-videoId status in the result: "leased" (full spec), "taken", or "notfound".
func LeaseTasks(ctx context.Context, videoIDs []int) ([]LeaseResult, error) {
	if len(videoIDs) == 0 {
		return nil, nil
	}
	body := map[string]interface{}{"videoIds": videoIDs}
	resp, err := doRequest(ctx, http.MethodPost, "/api/worker/tasks/lease", body)
	if err != nil {
		return nil, err
	}

	var out leaseResultsResponse
	if err := decodeJSON(resp, &out); err != nil {
		return nil, fmt.Errorf("decode lease results: %w", err)
	}
	return out.Results, nil
}

// ReportStatus sends a batched status report. Returns per-job acks so the worker
// can drop jobs the server no longer recognises (ack:false).
func ReportStatus(ctx context.Context, jobs []JobStatus) ([]JobAck, error) {
	if len(jobs) == 0 {
		return nil, nil
	}
	body := map[string]interface{}{"jobs": jobs}
	resp, err := doRequest(ctx, http.MethodPost, "/api/worker/tasks/status", body)
	if err != nil {
		return nil, err
	}

	var out statusResponse
	if err := decodeJSON(resp, &out); err != nil {
		return nil, fmt.Errorf("decode status response: %w", err)
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status returned %d", resp.StatusCode)
	}
	return out.Results, nil
}

// completeRetryDelays is the fixed backoff schedule for /tasks/complete:
// 0s, 1s, 2s, 3s, 4s between attempts (5 attempts total, ~10s cumulative wait).
var completeRetryDelays = []time.Duration{0, 1 * time.Second, 2 * time.Second, 3 * time.Second, 4 * time.Second}

// CompletePayload is the JSON body of POST /api/worker/tasks/complete.
type CompletePayload struct {
	DurationSeconds float64 `json:"durationSeconds,omitempty"`
}

// CompleteTask reports a single job completion with up to 5 retries
// (0/1/2/3/4 s backoff). Returns nil on 204, ErrJobNotFound on 404, ErrAuthFailed
// on a 401 that re-auth could not recover, and ErrCompleteRetriesExhausted if all
// 5 attempts fail with 5xx / network errors.
func CompleteTask(ctx context.Context, jobID string, payload CompletePayload) error {
	body := map[string]interface{}{"jobId": jobID}
	if payload.DurationSeconds > 0 {
		body["durationSeconds"] = payload.DurationSeconds
	}

	var lastErr error
	for i, delay := range completeRetryDelays {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if delay > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		resp, err := doRequest(ctx, http.MethodPost, "/api/worker/tasks/complete", body)
		if err != nil {
			lastErr = err
			// Auth failures propagated from doRequest are fatal — don't retry.
			if err == ErrAuthFailed {
				return err
			}
			continue
		}
		resp.Body.Close()

		switch resp.StatusCode {
		case http.StatusNoContent:
			return nil
		case http.StatusNotFound:
			return ErrJobNotFound
		}
		if resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("complete returned %d", resp.StatusCode)
			_ = i
			continue
		}
		// 4xx other than 404 is not a retry candidate.
		return fmt.Errorf("complete returned %d", resp.StatusCode)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("complete failed with unknown error")
	}
	return fmt.Errorf("%w: %v", ErrCompleteRetriesExhausted, lastErr)
}
