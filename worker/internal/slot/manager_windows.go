//go:build windows

package slot

import (
	"fmt"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// totalEncoderSlots sums per-encoder concurrent job limits.
func totalEncoderSlots(encoders []config.Encoder) int {
	total := 0
	for _, enc := range encoders {
		total += config.EffectiveConcurrentJobs(enc)
	}
	if total == 0 {
		total = 1 // software-only mode
	}
	return total
}

// NewManager creates a slot manager from enabled encoders.
func NewManager() *Manager {
	encoders := config.EnabledEncoders()
	return &Manager{
		encoders:     encoders,
		encoderUsage: make(map[string]int),
		occupied:     make(map[string]config.Encoder),
		activeJobs:   make(map[string]*Job),
		totalSlots:   totalEncoderSlots(encoders),
	}
}

// Reload refreshes the encoder list from capabilities (for reload command).
func (m *Manager) Reload() {
	m.mu.Lock()
	defer m.mu.Unlock()

	encoders := config.EnabledEncoders()
	m.encoders = encoders
	m.totalSlots = totalEncoderSlots(encoders)
}

// AcquireSlot assigns an encoder to a job using load-balanced scheduling.
//
// Selection picks the encoder with the lowest current usage among those with
// remaining capacity, breaking ties by encoder list order (priority order).
// This produces round-robin distribution: with NVENC(5) + QSV(3), the first
// 8 jobs are assigned NVENC→QSV→NVENC→QSV→NVENC→QSV→NVENC→NVENC.
func (m *Manager) AcquireSlot(jobID string, excludeTypes map[string]bool) (config.Encoder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.occupied) >= m.totalSlots {
		return config.Encoder{}, fmt.Errorf("no free slots")
	}

	// Find hardware encoder with lowest usage that has remaining capacity.
	var best *config.Encoder
	bestUsage := -1

	for i := range m.encoders {
		enc := &m.encoders[i]
		if excludeTypes != nil && excludeTypes[enc.EncoderType] {
			continue
		}
		usage := m.encoderUsage[enc.HardwareID]
		remaining := config.EffectiveConcurrentJobs(*enc) - usage
		if remaining <= 0 {
			continue
		}
		if best == nil || usage < bestUsage {
			best = enc
			bestUsage = usage
		}
	}

	if best != nil {
		m.occupied[jobID] = *best
		m.encoderUsage[best.HardwareID]++
		return *best, nil
	}

	// No hardware encoder available — fall back to software if not excluded.
	if excludeTypes == nil || !excludeTypes[hardware.EncoderSW] {
		if m.encoderUsage["software"] < 1 {
			sw := config.Encoder{
				HardwareID:  "software",
				EncoderType: hardware.EncoderSW,
				DeviceIndex: 0,
			}
			m.occupied[jobID] = sw
			m.encoderUsage["software"]++
			return sw, nil
		}
	}

	return config.Encoder{}, fmt.Errorf("no available encoder (all types excluded or at capacity)")
}

// NextEncoder picks the best available encoder from the non-failed options.
// Does NOT acquire a slot — for use within an already-running job to choose
// among fallback encoder types when the preferred encoder fails.
// Prefers encoders with remaining capacity, then lowest usage.
func (m *Manager) NextEncoder(failedTypes map[string]bool) (config.Encoder, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var best *config.Encoder
	bestUsage := -1

	for i := range m.encoders {
		enc := &m.encoders[i]
		if failedTypes[enc.EncoderType] {
			continue
		}
		usage := m.encoderUsage[enc.HardwareID]
		if best == nil || usage < bestUsage {
			best = enc
			bestUsage = usage
		}
	}

	if best != nil {
		return *best, nil
	}

	// All hardware encoders tried — fall back to software.
	if !failedTypes[hardware.EncoderSW] {
		return config.Encoder{
			HardwareID:  "software",
			EncoderType: hardware.EncoderSW,
			DeviceIndex: 0,
		}, nil
	}

	return config.Encoder{}, fmt.Errorf("all encoder types exhausted (tried %d hardware encoder(s) + software)", len(m.encoders))
}
