//go:build windows

package config

import "fmt"

// ReloadCapabilities re-reads capabilities.json and returns a summary of changes.
func ReloadCapabilities() (string, error) {
	capsMu.RLock()
	oldCount := 0
	if currentCaps != nil {
		oldCount = len(currentCaps.Encoders)
	}
	capsMu.RUnlock()

	newCaps, err := LoadCapabilities()
	if err != nil {
		return "", err
	}
	if newCaps == nil {
		return "capabilities.json not found", nil
	}

	enabledCount := 0
	totalSlots := 0
	for _, e := range newCaps.Encoders {
		if e.Enable {
			enabledCount++
			totalSlots += EffectiveConcurrentJobs(e)
		}
	}

	return fmt.Sprintf("encoders: %d total (%d enabled, %d job slots), was %d total",
		len(newCaps.Encoders), enabledCount, totalSlots, oldCount), nil
}
