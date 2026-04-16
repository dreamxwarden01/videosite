//go:build !windows

package ui

// enableVT is a no-op on Unix: VT escape processing is always on for a real
// terminal. The signature mirrors the Windows build so callers compile
// unchanged.
func enableVT(_ uintptr) error {
	return nil
}
