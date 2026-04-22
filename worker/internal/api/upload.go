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

// hlsContentType returns the correct MIME type for HLS / CMAF / DASH output
// files. Must match the ContentType used when generating the presigned PUT URL
// on the server side (processingService.js hlsContentType) — R2 rejects the
// PUT with SignatureDoesNotMatch if the signed URL's ContentType doesn't
// match the PUT request's Content-Type header exactly.
//
// Legacy TS uses .m3u8 + .ts; CMAF adds .mpd (DASH manifest), .mp4 (init
// segment), and .m4s (media segments). All are served cache-immutable.
//
// For .mp4 / .m4s we branch on whether the path sits under an /audio/
// directory — init.mp4 and segment_*.m4s under `audio/aac_192k/` get
// `audio/mp4`, everything else gets `video/mp4`. Players don't actually
// consume this header (Safari reads the fMP4 box structure, Shaka trusts
// the AdaptationSet's mimeType), but the R2 object metadata is otherwise
// self-mislabeling — `aws s3api head-object` on an audio segment would
// come back as video/mp4, which is surprising to anyone auditing the
// bucket. Normalize via filepath.ToSlash so Windows-native backslash paths
// still match — the signed URL path is always in forward-slash form on
// the server side.
//
// filePath may be a relative or absolute path; we only inspect the suffix
// and the presence of "/audio/" anywhere in it.
func hlsContentType(filePath string) string {
	lower := strings.ToLower(filepath.ToSlash(filePath))
	switch {
	case strings.HasSuffix(lower, ".m3u8"):
		return "application/vnd.apple.mpegurl"
	case strings.HasSuffix(lower, ".ts"):
		return "video/mp2t"
	case strings.HasSuffix(lower, ".mpd"):
		return "application/dash+xml"
	case strings.HasSuffix(lower, ".mp4"), strings.HasSuffix(lower, ".m4s"):
		// Prepend a leading "/" so relative paths ("audio/aac_192k/init.mp4")
		// and absolute paths ("/tmp/foo/audio/...") both match the same way.
		// The worker passes absolute local filesystem paths; the server
		// passes job-relative paths. Both forms need to resolve to the same
		// ContentType or the presigned PUT fails signature validation.
		if strings.Contains("/"+lower, "/audio/") {
			return "audio/mp4"
		}
		return "video/mp4"
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
	// Pass the full filePath (not just the basename) so hlsContentType can
	// see the /audio/ segment in the path and return audio/mp4 for init +
	// segments under /audio/. Stripping to basename made the path check
	// useless — every .m4s looked identical.
	req.Header.Set("Content-Type", hlsContentType(filePath))
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
