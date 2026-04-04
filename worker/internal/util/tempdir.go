package util

import (
	"os"
	"path/filepath"
	"time"
)

// Ts returns the current local time formatted as "[2006-01-02 15:04:05]".
// Use it to prefix all console log lines for consistent timestamps.
func Ts() string {
	return time.Now().Format("[2006-01-02 15:04:05]")
}

const tempBase = "temp"

// TempDir returns the temporary directory path for a job.
func TempDir(jobID string) string {
	return filepath.Join(tempBase, jobID)
}

// OutputDir returns the output directory path for a job.
func OutputDir(jobID string) string {
	return filepath.Join(tempBase, jobID, "output")
}

// EnsureTempDir creates the temp and output directories for a job.
func EnsureTempDir(jobID string) error {
	if err := os.MkdirAll(TempDir(jobID), 0755); err != nil {
		return err
	}
	return os.MkdirAll(OutputDir(jobID), 0755)
}

// CleanupTempDir removes the temporary directory for a job.
func CleanupTempDir(jobID string) {
	os.RemoveAll(TempDir(jobID))
}

// CleanupAllTemp removes the entire temp directory.
func CleanupAllTemp() {
	entries, err := os.ReadDir(tempBase)
	if err != nil {
		return
	}
	for _, entry := range entries {
		os.RemoveAll(filepath.Join(tempBase, entry.Name()))
	}
}
