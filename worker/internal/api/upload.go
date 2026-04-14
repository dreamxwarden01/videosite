package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrUploadForbidden indicates a 403 response from R2.
// The presigned URL is expired or the signature is invalid.
// The caller must regenerate tokens — do NOT retry with the same URL.
var ErrUploadForbidden = errors.New("upload forbidden (403): token expired or invalid")

// UploadURLsResponse is the response from POST /api/worker/tasks/upload-urls.
type UploadURLsResponse struct {
	URLs map[string]string `json:"urls"`
}

// GetUploadURLs requests presigned PUT URLs for the given filenames.
func GetUploadURLs(ctx context.Context, jobID string, filenames []string) (map[string]string, error) {
	body := map[string]interface{}{
		"jobId":     jobID,
		"filenames": filenames,
	}

	resp, err := doRequest(ctx, "POST", "/api/worker/tasks/upload-urls", body)
	if err != nil {
		return nil, err
	}

	var result UploadURLsResponse
	if err := decodeJSON(resp, &result); err != nil {
		return nil, fmt.Errorf("decode upload URLs response: %w", err)
	}
	return result.URLs, nil
}

// maxUploadRetries is the number of additional attempts after the first try
// for 5xx responses (total attempts = maxUploadRetries + 1).
const maxUploadRetries = 5

// UploadFile uploads a local file to a presigned PUT URL.
//
//   - Returns ErrUploadForbidden on HTTP 403: caller must regenerate the token.
//   - Retries up to maxUploadRetries times (1 second between attempts) on 5xx.
//   - Respects ctx cancellation at every retry boundary and within the request.
func UploadFile(ctx context.Context, filePath, presignedURL string) error {
	var lastErr error
	for attempt := 0; attempt <= maxUploadRetries; attempt++ {
		if ctx.Err() != nil {
			return fmt.Errorf("upload cancelled: %w", ctx.Err())
		}

		statusCode, err := doUpload(ctx, filePath, presignedURL)
		if err == nil {
			return nil // success
		}

		// 403: expired/invalid token — signal caller to refresh, no retry
		if statusCode == 403 {
			return ErrUploadForbidden
		}

		// 5xx: transient R2/gateway error — retry with delay
		if statusCode >= 500 && attempt < maxUploadRetries {
			slog.Warn("Upload 5xx, retrying",
				"file", filepath.Base(filePath),
				"status", statusCode,
				"attempt", attempt+1,
				"max", maxUploadRetries)
			lastErr = err
			select {
			case <-ctx.Done():
				return fmt.Errorf("upload cancelled during retry: %w", ctx.Err())
			case <-time.After(time.Second):
			}
			continue
		}

		// Other errors (4xx except 403, network errors) or exhausted retries
		return fmt.Errorf("upload %s: %w", filepath.Base(filePath), err)
	}
	return fmt.Errorf("upload %s: failed after %d retries: %w", filepath.Base(filePath), maxUploadRetries, lastErr)
}

// hlsContentType returns the correct MIME type for HLS output files.
// Must match the ContentType used when generating the presigned PUT URL
// on the server side (processingService.js hlsContentType).
func hlsContentType(filename string) string {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".m3u8"):
		return "application/vnd.apple.mpegurl"
	case strings.HasSuffix(lower, ".ts"):
		return "video/mp2t"
	default:
		return "application/octet-stream"
	}
}

// doUpload performs a single PUT upload attempt.
// Returns (statusCode, error). statusCode is 0 on network-level errors.
func doUpload(ctx context.Context, filePath, presignedURL string) (int, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return 0, fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return 0, fmt.Errorf("stat file: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "PUT", presignedURL, f)
	if err != nil {
		return 0, fmt.Errorf("create upload request: %w", err)
	}
	req.ContentLength = stat.Size()
	req.Header.Set("Content-Type", hlsContentType(filepath.Base(filePath)))
	req.Header.Set("Cache-Control", "public, max-age=31536000, immutable")

	resp, err := httpClientPtr.Load().Do(req)
	if err != nil {
		return 0, fmt.Errorf("upload request failed: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("upload returned status %d", resp.StatusCode)
	}
	return resp.StatusCode, nil
}
