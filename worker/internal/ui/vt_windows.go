//go:build windows

package ui

import "golang.org/x/sys/windows"

// enableVT flips ENABLE_VIRTUAL_TERMINAL_PROCESSING on the given console
// handle so our ANSI escape sequences (scroll region, cursor save/restore,
// clear-line) are interpreted as ANSI rather than printed as garbage text.
//
// Supported on Windows 10 1607+ (August 2016). On older Windows — which this
// worker does not officially target — the call returns an error and the
// caller will fall through the TTY path; the bars will paint as raw escape
// sequences, which is a clear signal to downgrade to plain mode (not yet
// wired, see NewManager).
func enableVT(fd uintptr) error {
	h := windows.Handle(fd)
	var mode uint32
	if err := windows.GetConsoleMode(h, &mode); err != nil {
		return err
	}
	if mode&windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
		return nil // already on
	}
	return windows.SetConsoleMode(h, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
}
