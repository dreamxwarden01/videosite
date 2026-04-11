package api

import (
	"context"
	"fmt"

	"videosite-worker/internal/config"
)

// AvailableResponse is the response from GET /api/worker/tasks/available.
type AvailableResponse struct {
	HasAvailableTask bool `json:"hasAvailableTask"`
	VideoID          int  `json:"videoId"`
}

// LeaseResponse is the response from POST /api/worker/tasks/lease.
type LeaseResponse struct {
	IsLeaseSuccess bool   `json:"isLeaseSuccess"`
	JobID          string `json:"jobId"`
	DownloadURL    string `json:"downloadUrl"`
	EncryptionKey  string `json:"encryptionKey"` // hex-encoded 16-byte AES-128 key
	VideoID        int    `json:"videoId"`

	// Server-provided transcoding config (per-course or global defaults).
	OutputProfiles            []config.OutputProfile `json:"outputProfiles,omitempty"`
	AudioNormalization        bool                   `json:"audioNormalization,omitempty"`
	AudioNormalizationTarget  float64                `json:"audioNormalizationTarget,omitempty"`
	AudioNormalizationPeak    float64                `json:"audioNormalizationPeak,omitempty"`
	AudioNormalizationMaxGain float64                `json:"audioNormalizationMaxGain,omitempty"`
}

// CheckAvailable polls the server for an available task.
func CheckAvailable(ctx context.Context) (*AvailableResponse, error) {
	resp, err := doRequest(ctx, "GET", "/api/worker/tasks/available", nil)
	if err != nil {
		return nil, err
	}

	var result AvailableResponse
	if err := decodeJSON(resp, &result); err != nil {
		return nil, fmt.Errorf("decode available response: %w", err)
	}
	return &result, nil
}

// Lease requests to lease a specific video's task.
func Lease(ctx context.Context, videoID int) (*LeaseResponse, error) {
	body := map[string]interface{}{
		"videoId": videoID,
	}

	resp, err := doRequest(ctx, "POST", "/api/worker/tasks/lease", body)
	if err != nil {
		return nil, err
	}

	var result LeaseResponse
	if err := decodeJSON(resp, &result); err != nil {
		return nil, fmt.Errorf("decode lease response: %w", err)
	}
	return &result, nil
}

// UpdateStatus reports job status to the server.
// Returns ErrJobNotFound if the job no longer exists (404-based abort signal).
func UpdateStatus(ctx context.Context, jobID, status string, progress int, videoStatus string, durationSeconds float64) error {
	body := map[string]interface{}{
		"status":   status,
		"progress": progress,
	}
	if videoStatus != "" {
		body["videoStatus"] = videoStatus
	}
	if durationSeconds > 0 {
		body["durationSeconds"] = durationSeconds
	}

	resp, err := doRequest(ctx, "POST", fmt.Sprintf("/api/worker/task/%s/status", jobID), body)
	if err != nil {
		return err // includes ErrJobNotFound from doRequest
	}
	resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("status update returned %d", resp.StatusCode)
	}
	return nil
}

// Complete marks a job as completed.
func Complete(ctx context.Context, jobID string, durationSeconds float64) error {
	body := map[string]interface{}{}
	if durationSeconds > 0 {
		body["durationSeconds"] = durationSeconds
	}

	resp, err := doRequest(ctx, "POST", fmt.Sprintf("/api/worker/task/%s/complete", jobID), body)
	if err != nil {
		return err
	}
	resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("complete returned status %d", resp.StatusCode)
	}
	return nil
}

// ReportError reports a job error to the server.
// Returns ErrJobNotFound if the job no longer exists.
func ReportError(ctx context.Context, jobID, message string) error {
	body := map[string]interface{}{
		"message": message,
	}

	resp, err := doRequest(ctx, "POST", fmt.Sprintf("/api/worker/task/%s/error", jobID), body)
	if err != nil {
		return err // includes ErrJobNotFound
	}
	resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("error report returned status %d", resp.StatusCode)
	}
	return nil
}

// ReportAbort tells the server the job was aborted (worker shutdown), so it can requeue.
func ReportAbort(ctx context.Context, jobID string) error {
	resp, err := doRequest(ctx, "POST", fmt.Sprintf("/api/worker/task/%s/abort", jobID), nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("abort report returned status %d", resp.StatusCode)
	}
	return nil
}
