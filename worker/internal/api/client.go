package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
	"videosite-worker/internal/auth"
	"videosite-worker/internal/config"
	"videosite-worker/internal/mtls"
)

// ErrAuthFailed indicates a 401 response that even a re-auth could not recover.
// The worker treats this as fatal (bad credentials — config mismatch).
var ErrAuthFailed = fmt.Errorf("authentication failed (401)")

// ErrJobNotFound indicates a 404 response from the server.
// Only /tasks/complete uses it today (job already completed / cleaned up).
var ErrJobNotFound = fmt.Errorf("job not found (404)")

// ErrCertFatal indicates the in-memory mTLS client certificate is invalid
// (expired or not yet valid). The worker treats this as fatal — no amount of
// retrying helps until the cert is renewed on disk and the worker restarts.
var ErrCertFatal = fmt.Errorf("mTLS certificate invalid — worker must restart")

// Shared HTTP client, rebuilt in-place by Reconfigure when use_system_proxies
// flips. Stored in an atomic.Pointer so rebuilds are lock-free for readers
// (every request path reads it on the hot path).
var httpClientPtr atomic.Pointer[http.Client]

// cachedTLS retains the *tls.Config supplied at Init so Reconfigure can
// rebuild the transport without needing to re-parse certs.
// cachedCert is the parsed leaf certificate, used for NotBefore/NotAfter
// checks on every outbound request. Both are nil when mTLS is disabled.
var (
	cachedTLS  atomic.Pointer[tls.Config]
	cachedCert atomic.Pointer[x509.Certificate]
)

func init() {
	// Sensible default so any accidental pre-Init HTTP call doesn't panic.
	httpClientPtr.Store(&http.Client{Timeout: 60 * time.Second})
}

// activeSession holds the bearer-token session used on every authenticated call.
// Set by SetSession during worker startup, before any API calls go out.
var activeSession atomic.Pointer[auth.Session]

// SetSession registers the bearer session used by all authenticated requests.
// Must be called after the first successful Authenticate so the token is populated.
func SetSession(s *auth.Session) {
	activeSession.Store(s)
}

// Init configures the shared HTTP client with optional mTLS and proxy settings.
// Call this once during startup, before any API calls are made.
//
//   - tlsCfg: if non-nil, the client presents the mTLS certificate on all requests.
//     (R2 presigned uploads also go through this client but R2 simply ignores the cert.)
//   - cert: parsed leaf certificate paired with tlsCfg, used for per-request
//     NotBefore/NotAfter checks. Ignored when tlsCfg is nil.
//   - useProxy: if true, reads the system proxy (Windows: IE/WinINET registry;
//     other: HTTPS_PROXY / HTTP_PROXY env vars) on EACH request. If false,
//     direct connection.
func Init(tlsCfg *tls.Config, cert *x509.Certificate, useProxy bool) {
	if tlsCfg != nil {
		cachedTLS.Store(tlsCfg)
	}
	if cert != nil {
		cachedCert.Store(cert)
	}
	buildClient(useProxy)
}

// Reconfigure rebuilds the HTTP client transport to apply a changed
// use_system_proxies setting. The cached TLS config and cert are retained —
// mTLS changes require a restart and won't reach this function.
//
// In-flight requests on the old transport finish naturally (the old *http.Client
// is orphaned; its transport drains). Subsequent calls use the new client.
func Reconfigure(useProxy bool) {
	buildClient(useProxy)
	slog.Info("API client: transport rebuilt", "use_system_proxies", useProxy)
}

// buildClient constructs a new *http.Client from cachedTLS + the given proxy
// flag and atomically swaps it into httpClientPtr.
func buildClient(useProxy bool) {
	transport := http.DefaultTransport.(*http.Transport).Clone()

	if t := cachedTLS.Load(); t != nil {
		transport.TLSClientConfig = t
	}

	if useProxy {
		transport.Proxy = systemProxyFunc()
	} else {
		transport.Proxy = nil
	}

	httpClientPtr.Store(&http.Client{
		Timeout:   60 * time.Second,
		Transport: transport,
	})
}

// checkCertPreflight verifies the cached mTLS cert is within its validity
// window. Returns nil when no cert is cached (mTLS disabled) or the cert is
// currently valid. Wraps any validity error in ErrCertFatal so callers can
// use errors.Is(err, api.ErrCertFatal) to trigger the fatal-shutdown path.
func checkCertPreflight() error {
	c := cachedCert.Load()
	if c == nil {
		return nil
	}
	if err := mtls.CheckCertValidity(c); err != nil {
		return fmt.Errorf("%w: %v", ErrCertFatal, err)
	}
	return nil
}

// doRequest performs an authenticated HTTP request to the site API.
// On 401, it transparently triggers a single /api/worker/auth refresh (collapsed
// across concurrent callers via auth.Session) and retries once with the new token.
// If the retry still returns 401, ErrAuthFailed is propagated.
//
// On 403, the cached mTLS cert is re-checked for validity. Expired/not-yet-valid
// certs return ErrCertFatal for a clean shutdown. Otherwise a generic forbidden
// error is returned (server-side revocation — user must investigate).
//
// Callers must inspect resp.StatusCode for their own non-auth semantics (204, 404,
// 4xx validation errors). 404 is NOT turned into ErrJobNotFound at this layer —
// only CompleteTask interprets 404, and it does so explicitly.
func doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	s := activeSession.Load()
	if s == nil {
		return nil, fmt.Errorf("no active session (SetSession not called)")
	}

	resp, err := sendOnce(ctx, method, path, body, s.Token())
	if err != nil {
		return nil, err
	}

	if resp.StatusCode == http.StatusForbidden {
		resp.Body.Close()
		if certErr := checkCertPreflight(); certErr != nil {
			return nil, certErr
		}
		return nil, fmt.Errorf("forbidden (403) — server rejected request")
	}

	if resp.StatusCode != http.StatusUnauthorized {
		return resp, nil
	}

	// 401 — refresh token (collapsed) and retry once.
	resp.Body.Close()
	if refreshErr := s.Refresh(ctx, Authenticate); refreshErr != nil {
		// If the refresh itself failed due to an expired cert, surface it
		// untouched so the caller hits the cert-fatal path.
		if errors.Is(refreshErr, ErrCertFatal) {
			return nil, refreshErr
		}
		return nil, fmt.Errorf("re-auth after 401: %w", refreshErr)
	}

	resp, err = sendOnce(ctx, method, path, body, s.Token())
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusForbidden {
		resp.Body.Close()
		if certErr := checkCertPreflight(); certErr != nil {
			return nil, certErr
		}
		return nil, fmt.Errorf("forbidden (403) — server rejected request")
	}
	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		return nil, ErrAuthFailed
	}
	return resp, nil
}

// sendOnce builds and sends a single request with the given bearer token.
// Used by doRequest; callers with their own auth (like Authenticate) build
// requests directly.
//
// Before building the request, it runs the cached-cert validity pre-flight:
// expired/not-yet-valid certs return ErrCertFatal so the caller can shut
// down cleanly instead of waiting on an opaque TLS handshake error.
func sendOnce(ctx context.Context, method, path string, body interface{}, token string) (*http.Response, error) {
	if err := checkCertPreflight(); err != nil {
		return nil, err
	}

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
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClientPtr.Load().Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
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

// HTTPClient returns the shared HTTP client configured by Init() / Reconfigure().
// Use this for raw (non-API) HTTP requests — R2 downloads, presigned uploads —
// so they share the same proxy and TLS settings as API calls.
//
// Each call returns the current pointer, so long-running goroutines that cache
// the result for the lifetime of an upload/download keep their transport; the
// next goroutine after a Reconfigure gets the new one.
func HTTPClient() *http.Client {
	return httpClientPtr.Load()
}

// decodeJSON reads and decodes JSON from a response body.
func decodeJSON(resp *http.Response, v interface{}) error {
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(v)
}
