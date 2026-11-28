package api

import (
	"context"
	"fmt"
	"net/http"
)

// ReportPosterReady acknowledges a completed poster PUT for this exact leased
// job. The server owns idempotency and current-job/worker fencing. Retrying this
// request must never repeat the R2 PUT; only a confirmed 204 publishes readiness.
func ReportPosterReady(ctx context.Context, jobID string) error {
	return RetryWithBackoff(ctx, "report poster ready", func() error {
		resp, err := doRequest(ctx, http.MethodPost, "/api/worker/tasks/poster-ready", map[string]string{"jobId": jobID})
		if err != nil {
			return err
		}
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusNoContent:
			return nil
		case http.StatusNotFound:
			return ErrJobNotFound
		default:
			return fmt.Errorf("poster ready returned %d", resp.StatusCode)
		}
	})
}
