package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"videosite-worker/internal/config"
)

type authResponse struct {
	BearerToken      string `json:"bearerToken"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

// Authenticate calls POST /api/worker/auth with the configured key credentials
// and returns the issued bearer token. It builds the request directly so it
// cannot recurse through doRequest's 401-retry path.
//
// Returns ErrAuthFailed on 401 (bad keyId/keySecret — worker should exit).
// Returns ErrCertFatal on 403 if the in-memory mTLS cert is outside its
// validity window (hard shutdown). Other non-2xx statuses are returned as a
// plain error so the worker retries with backoff.
func Authenticate(ctx context.Context) (string, error) {
	if err := checkCertPreflight(); err != nil {
		return "", err
	}

	cfg := config.Get()
	if cfg == nil {
		return "", fmt.Errorf("config not loaded")
	}

	body, err := json.Marshal(map[string]string{
		"keyId":     cfg.AccessKeyID,
		"keySecret": cfg.AccessKeySecret,
	})
	if err != nil {
		return "", fmt.Errorf("marshal auth body: %w", err)
	}

	scheme := "https"
	if isLocalhost(cfg.SiteHostname) {
		scheme = "http"
	}
	url := fmt.Sprintf("%s://%s/api/worker/auth", scheme, cfg.SiteHostname)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create auth request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClientPtr.Load().Do(req)
	if err != nil {
		return "", fmt.Errorf("auth request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return "", ErrAuthFailed
	}
	if resp.StatusCode == http.StatusForbidden {
		if certErr := checkCertPreflight(); certErr != nil {
			return "", certErr
		}
		return "", fmt.Errorf("auth returned 403 — server rejected request")
	}
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("auth returned status %d", resp.StatusCode)
	}

	var out authResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode auth response: %w", err)
	}
	if out.BearerToken == "" {
		return "", fmt.Errorf("auth response missing bearerToken")
	}
	return out.BearerToken, nil
}
