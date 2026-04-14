//go:build windows

package api

import (
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"unsafe"
)

// systemProxyFunc returns an http.Transport-compatible proxy function that
// reads the current Windows IE/WinINET system proxy settings from the registry
// (HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings) on EACH
// request. This lets the user toggle proxies in Windows Internet Options
// while the worker is running and have it take effect on the next outbound
// call without needing a reload.
//
// This is what Charles, Fiddler, and other Windows proxies configure when they
// register themselves as the system proxy. Go's http.ProxyFromEnvironment only
// reads HTTPS_PROXY env vars, which are NOT set by Windows system proxy tools.
//
// Falls back to http.ProxyFromEnvironment if the registry cannot be read or
// if the system proxy is disabled.
func systemProxyFunc() func(*http.Request) (*url.URL, error) {
	return func(req *http.Request) (*url.URL, error) {
		if u := windowsRegistryProxyURL(); u != nil {
			return u, nil
		}
		return http.ProxyFromEnvironment(req)
	}
}

// windowsRegistryProxyURL reads the HTTPS (or HTTP) proxy address from the
// Windows registry. Returns nil if proxy is disabled or unreadable.
func windowsRegistryProxyURL() *url.URL {
	const keyPath = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

	pathPtr, _ := syscall.UTF16PtrFromString(keyPath)
	var hKey syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, pathPtr, 0, syscall.KEY_QUERY_VALUE, &hKey); err != nil {
		return nil
	}
	defer syscall.RegCloseKey(hKey)

	// ProxyEnable (DWORD): 0 = disabled, 1 = enabled
	var enabled uint32
	var dwordSize uint32 = 4
	enablePtr, _ := syscall.UTF16PtrFromString("ProxyEnable")
	if err := syscall.RegQueryValueEx(hKey, enablePtr, nil, nil, (*byte)(unsafe.Pointer(&enabled)), &dwordSize); err != nil || enabled == 0 {
		return nil
	}

	// ProxyServer (REG_SZ): "host:port" or "http=h:p;https=h:p;ftp=h:p;socks=h:p"
	serverPtr, _ := syscall.UTF16PtrFromString("ProxyServer")
	var bufSize uint32
	_ = syscall.RegQueryValueEx(hKey, serverPtr, nil, nil, nil, &bufSize)
	if bufSize == 0 {
		return nil
	}
	buf := make([]uint16, (bufSize+1)/2)
	if err := syscall.RegQueryValueEx(hKey, serverPtr, nil, nil, (*byte)(unsafe.Pointer(&buf[0])), &bufSize); err != nil {
		return nil
	}
	proxyServer := syscall.UTF16ToString(buf)
	if proxyServer == "" {
		return nil
	}

	addr := parseWindowsProxyAddr(proxyServer)
	if addr == "" {
		return nil
	}
	if !strings.Contains(addr, "://") {
		addr = "http://" + addr
	}
	u, err := url.Parse(addr)
	if err != nil {
		return nil
	}
	return u
}

// parseWindowsProxyAddr extracts the HTTPS (or fallback HTTP) proxy address
// from a Windows ProxyServer registry value.
//
// Formats:
//   - "127.0.0.1:8888"                       → all-protocol proxy
//   - "http=h:p;https=h:p;ftp=h:p;socks=h:p" → per-protocol (prefer https, fall back to http)
func parseWindowsProxyAddr(proxyServer string) string {
	if !strings.Contains(proxyServer, "=") {
		return proxyServer // simple "host:port" applies to all protocols
	}
	var httpAddr string
	for _, part := range strings.Split(proxyServer, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch strings.ToLower(kv[0]) {
		case "https":
			return kv[1] // https-specific entry is preferred
		case "http":
			httpAddr = kv[1] // remember http entry as fallback
		}
	}
	return httpAddr
}
