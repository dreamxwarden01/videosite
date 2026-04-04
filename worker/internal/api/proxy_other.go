//go:build !windows && !darwin

package api

import (
	"net/http"
	"net/url"
)

// systemProxyFunc on platforms without dedicated proxy detection falls back to
// http.ProxyFromEnvironment, which reads HTTPS_PROXY / HTTP_PROXY environment variables.
func systemProxyFunc() func(*http.Request) (*url.URL, error) {
	return http.ProxyFromEnvironment
}
