package config

import "fmt"

// VideoToolboxEnabled returns true if VideoToolbox is present and enabled.
func VideoToolboxEnabled() bool {
	capsMu.RLock()
	defer capsMu.RUnlock()
	if currentCaps == nil {
		return false
	}
	for _, e := range currentCaps.Encoders {
		if e.EncoderType == "VIDEOTOOLBOX" && e.Enable {
			return true
		}
	}
	return false
}

// ReloadCapabilities re-reads capabilities.json and returns a summary of changes.
func ReloadCapabilities() (string, error) {
	capsMu.RLock()
	var oldJobs int
	var oldChip string
	if currentCaps != nil {
		oldJobs = currentCaps.ConcurrentJobs
		oldChip = currentCaps.ChipModel
	}
	capsMu.RUnlock()

	newCaps, err := LoadCapabilities()
	if err != nil {
		return "", err
	}
	if newCaps == nil {
		return "capabilities.json not found", nil
	}

	vtStatus := "disabled"
	if VideoToolboxEnabled() {
		vtStatus = "enabled"
	}

	summary := fmt.Sprintf("chip: %s (%s), concurrent_jobs: %d (was %d), VideoToolbox: %s",
		newCaps.ChipModel, newCaps.ChipTier, newCaps.ConcurrentJobs, oldJobs, vtStatus)
	if oldChip != newCaps.ChipModel {
		summary += fmt.Sprintf(" [chip changed: %s → %s]", oldChip, newCaps.ChipModel)
	}
	return summary, nil
}
