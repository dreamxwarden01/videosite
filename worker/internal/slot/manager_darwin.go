package slot

import (
	"fmt"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// NewManager creates a slot manager from current capabilities.
func NewManager() *Manager {
	caps := config.GetCapabilities()

	totalSlots := 1 // safe default
	if caps != nil && caps.ConcurrentJobs > 0 {
		totalSlots = caps.ConcurrentJobs
	}

	vtEnabled := config.VideoToolboxEnabled()

	return &Manager{
		vtEnabled:  vtEnabled,
		occupied:   make(map[string]config.Encoder),
		activeJobs: make(map[string]*Job),
		totalSlots: totalSlots,
	}
}

// Reload refreshes slot count and VT status from capabilities (for reload command).
func (m *Manager) Reload() {
	m.mu.Lock()
	defer m.mu.Unlock()

	caps := config.GetCapabilities()
	if caps != nil && caps.ConcurrentJobs > 0 {
		m.totalSlots = caps.ConcurrentJobs
	}
	m.vtEnabled = config.VideoToolboxEnabled()
}

// AcquireSlot assigns an encoder to a job.
//
// On macOS the assignment is simple:
//   - If VT is enabled and not excluded → assign VideoToolbox.
//   - Otherwise → assign Software (libx264).
func (m *Manager) AcquireSlot(jobID string, excludeTypes map[string]bool) (config.Encoder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.occupied) >= m.totalSlots {
		return config.Encoder{}, fmt.Errorf("no free slots")
	}

	enc := m.pickEncoder(excludeTypes)
	if enc.EncoderType == "" {
		return config.Encoder{}, fmt.Errorf("no available encoder (all types excluded)")
	}

	m.occupied[jobID] = enc
	return enc, nil
}

// NextEncoder picks the best available encoder excluding already-failed types.
// Does NOT acquire a new slot — for use within an already-running job when
// the current encoder tier fails and a fallback is needed.
func (m *Manager) NextEncoder(failedTypes map[string]bool) (config.Encoder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	enc := m.pickEncoder(failedTypes)
	if enc.EncoderType == "" {
		return config.Encoder{}, fmt.Errorf("all encoder types exhausted")
	}
	return enc, nil
}

// pickEncoder returns the best available encoder given a set of excluded types.
// Caller must hold m.mu.
func (m *Manager) pickEncoder(excludeTypes map[string]bool) config.Encoder {
	if m.vtEnabled && (excludeTypes == nil || !excludeTypes[hardware.EncoderVT]) {
		caps := config.GetCapabilities()
		name := "VideoToolbox"
		if caps != nil && caps.ChipModel != "" {
			name = fmt.Sprintf("VideoToolbox (%s)", caps.ChipModel)
		}
		return config.Encoder{
			HardwareID:  "apple-videotoolbox",
			EncoderType: hardware.EncoderVT,
			Name:        name,
			Enable:      true,
			DeviceIndex: 0,
		}
	}

	if excludeTypes == nil || !excludeTypes[hardware.EncoderSW] {
		return config.Encoder{
			HardwareID:  "software",
			EncoderType: hardware.EncoderSW,
			Name:        "Software (libx264)",
			Enable:      true,
			DeviceIndex: 0,
		}
	}

	return config.Encoder{} // all types excluded
}
