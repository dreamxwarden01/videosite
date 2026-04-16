package ui

import (
	"os"

	"github.com/mattn/go-isatty"
)

// NewManager returns the right implementation for the current stdout.
//
// Selection order:
//  1. Stdout is not a terminal (piped, redirected, dumb console) → plain.
//  2. Stdout is a terminal but enabling VT escape processing fails (very
//     old Windows conhost; SSH from clients with no VT support) → plain.
//     newTTY surfaces the enableVT error so we can downgrade gracefully
//     instead of painting raw escape bytes the user perceives as garbage.
//  3. Otherwise → tty manager with sticky progress bars.
//
// Stdout is the chosen stream (not stderr) to match the worker's existing
// output convention: users who redirect output to a file did
// `worker > out.log`, and we want their log file to keep containing
// everything.
func NewManager() Manager {
	fd := os.Stdout.Fd()
	if isatty.IsTerminal(fd) || isatty.IsCygwinTerminal(fd) {
		if m, err := newTTY(os.Stdout); err == nil {
			return m
		}
	}
	return newPlain(os.Stdout)
}
