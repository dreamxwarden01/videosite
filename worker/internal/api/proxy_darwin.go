package api

import (
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
)

// systemProxyFunc returns an http.Transport-compatible proxy function that
// reads macOS system proxy settings from System Configuration via `scutil --proxy`.
//
// This covers proxies configured in System Settings → Network → Proxies (e.g. Charles,
// Proxyman, corporate HTTP(S) proxies). These are NOT exposed as environment variables,
// so Go's http.ProxyFromEnvironment alone does not pick them up.
//
// Strategy:
//  1. Run `scutil --proxy`, parse HTTPS proxy (preferred), fall back to HTTP proxy.
//  2. If scutil fails or reports no proxy, fall back to http.ProxyFromEnvironment
//     which reads HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment variables.
func systemProxyFunc() func(*http.Request) (*url.URL, error) {
	if u := macOSSystemProxyURL(); u != nil {
		return http.ProxyURL(u)
	}
	return http.ProxyFromEnvironment
}

// macOSSystemProxyURL reads the macOS system-level proxy from scutil --proxy.
// Returns nil if no proxy is configured or if parsing fails.
func macOSSystemProxyURL() *url.URL {
	out, err := exec.Command("/usr/sbin/scutil", "--proxy").Output()
	if err != nil {
		return nil
	}
	return parseScutilProxy(string(out))
}

// parseScutilProxy extracts an HTTPS (preferred) or HTTP proxy URL from the
// `scutil --proxy` output. The output is a plist-like key/value format, e.g.:
//
//	<dictionary> {
//	  HTTPSEnable : 1
//	  HTTPSProxy  : 127.0.0.1
//	  HTTPSPort   : 8888
//	  HTTPEnable  : 1
//	  HTTPProxy   : 127.0.0.1
//	  HTTPPort    : 8080
//	}
//
// Returns nil if no usable proxy entry is found.
func parseScutilProxy(output string) *url.URL {
	kv := parseScutilKV(output)

	// Try HTTPS proxy first (preferred for our HTTPS API calls).
	if kv["HTTPSEnable"] == "1" {
		host := kv["HTTPSProxy"]
		port := kv["HTTPSPort"]
		if host != "" && port != "" {
			if u := buildProxyURL(host, port); u != nil {
				return u
			}
		}
	}

	// Fall back to HTTP proxy.
	if kv["HTTPEnable"] == "1" {
		host := kv["HTTPProxy"]
		port := kv["HTTPPort"]
		if host != "" && port != "" {
			if u := buildProxyURL(host, port); u != nil {
				return u
			}
		}
	}

	return nil
}

// parseScutilKV extracts flat key/value pairs from scutil's plist-like output.
// Lines matching "  KEY : VALUE" are collected; array/nested entries are skipped.
func parseScutilKV(output string) map[string]string {
	kv := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		// Skip structural lines
		if line == "" || line == "<dictionary> {" || line == "}" ||
			line == "<array> {" || strings.HasPrefix(line, "<") {
			continue
		}
		idx := strings.Index(line, " : ")
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+3:])
		kv[key] = val
	}
	return kv
}

// buildProxyURL constructs a proxy URL from a host string and port string.
// Returns nil if either is unusable.
func buildProxyURL(host, portStr string) *url.URL {
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return nil
	}
	raw := fmt.Sprintf("http://%s:%d", host, port)
	u, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	return u
}
