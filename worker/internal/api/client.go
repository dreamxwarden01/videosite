package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
	"videosite-worker/internal/config"
)

// ErrAuthFailed indicates a 401 response from the server.
var ErrAuthFailed = fmt.Errorf("authentication failed (401)")

// ErrJobNotFound indicates a 404 response from the server.
// The job no longer exists (deleted / cascade-removed). Worker should abort immediately.
var ErrJobNotFound = fmt.Errorf("job not found (404)")

var httpClient = &http.Client{
	Timeout: 60 * time.Second,
}

// Init configures the shared HTTP client with optional mTLS and proxy settings.
// Call this once during startup, before any API calls are made.
//
//   - tlsCfg: if non-nil, the client presents the mTLS certificate on all requests.
//     (R2 presigned uploads also go through this client but R2 simply ignores the cert.)
//   - useProxy: if true, reads the system proxy (Windows: IE/WinINET registry;
//     other: HTTPS_PROXY / HTTP_PROXY env vars). If false, direct connection.
func Init(tlsCfg *tls.Config, useProxy bool) {
	transport := http.DefaultTransport.(*http.Transport).Clone()

	if tlsCfg != nil {
		transport.TLSClientConfig = tlsCfg
		slog.Info("API client: mTLS enabled")
	}

	if !useProxy {
		transport.Proxy = nil
	} else {
		transport.Proxy = systemProxyFunc()
		slog.Info("API client: using system proxy")
	}

	httpClient = &http.Client{
		Timeout:   60 * time.Second,
		Transport: transport,
	}
}

// doRequest performs an authenticated HTTP request to the site API.
// ctx controls cancellation of the in-flight HTTP call.
func doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	cfg := config.Get()
	if cfg == nil {
		return nil, fmt.Errorf("config not loaded")
	}

	scheme := "https"
	if isLocalhost(cfg.SiteHostname) {
		scheme = "http"
	}
	url := fmt.Sprintf("%s://%s%s", scheme, cfg.SiteHostname, path)

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Authorization", fmt.Sprintf("WorkerKey %s:%s", cfg.AccessKeyID, cfg.AccessKeySecret))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}

	if resp.StatusCode == 401 {
		resp.Body.Close()
		return nil, ErrAuthFailed
	}

	if resp.StatusCode == 404 {
		resp.Body.Close()
		return nil, ErrJobNotFound
	}

	return resp, nil
}

func isLocalhost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" ||
		len(host) > 10 && (host[:10] == "localhost:" || host[:10] == "127.0.0.1:")
}

// BuildURL constructs a full URL from a path using the configured site hostname.
// Automatically selects http:// for localhost, https:// otherwise.
func BuildURL(path string) string {
	cfg := config.Get()
	scheme := "https"
	if isLocalhost(cfg.SiteHostname) {
		scheme = "http"
	}
	return fmt.Sprintf("%s://%s%s", scheme, cfg.SiteHostname, path)
}

// HTTPClient returns the shared HTTP client configured by Init().
// Use this for raw (non-API) HTTP requests — R2 downloads, presigned uploads —
// so they share the same proxy and TLS settings as API calls.
func HTTPClient() *http.Client {
	return httpClient
}

// decodeJSON reads and decodes JSON from a response body.
func decodeJSON(resp *http.Response, v interface{}) error {
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(v)
}
