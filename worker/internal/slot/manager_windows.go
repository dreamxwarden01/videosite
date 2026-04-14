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
//
// Diff-based graceful-shrink model:
//
//  1. If a previously-deactivated encoder is back in the new enabled list,
//     clear its deactivated flag and drop its shrinkRemaining counter.
//     Its in-flight jobs go back to the normal release path.
//
//  2. For each encoder in the OLD list that's not in the new list: if it
//     has active jobs, mark it deactivated so their future releases shrink
//     totalSlots instead of freeing slots. If it has no active jobs, it's
//     simply removed.
//
//  3. For each still-enabled encoder whose per-encoder cap dropped below
//     current usage, queue shrinkRemaining[hwID] = usage − newCap so that
//     many future releases on that encoder shrink totalSlots. Once the
//     counter drains, further releases take the normal free-slot path.
//
//  4. Recompute totalSlots as:
//     sum(effective cap of each enabled encoder)
//     + sum(active usage on deactivated encoders)       — retire on release
//     + sum(shrinkRemaining for capped-down encoders)   — retire on release
//
//     The extra terms keep FreeSlots accurate: jobs that haven't released
//     yet still count as occupying real slots until they hit the graceful
//     shrink path.
func (m *Manager) Reload() {
	m.mu.Lock()
	defer m.mu.Unlock()

	newEncoders := config.EnabledEncoders()

	// Build lookup of new enabled set for O(1) membership checks below.
	newByID := make(map[string]config.Encoder, len(newEncoders))
	for _, e := range newEncoders {
		newByID[e.HardwareID] = e
	}

	if m.deactivated == nil {
		m.deactivated = make(map[string]bool)
	}
	if m.shrinkRemaining == nil {
		m.shrinkRemaining = make(map[string]int)
	}

	// 1. Re-enable: if a previously-deactivated encoder is back in the new
	//    list, clear the deactivated flag and reset any shrinkRemaining for
	//    it. In-flight jobs on that encoder will now release normally.
	for hid := range newByID {
		if m.deactivated[hid] {
			delete(m.deactivated, hid)
			delete(m.shrinkRemaining, hid)
		}
	}

	// 2. Disable-with-jobs: any encoder in the old list but not in the new
	//    list that still has active jobs gets marked deactivated. If it has
	//    no active jobs, it's implicitly dropped when we replace m.encoders.
	for _, old := range m.encoders {
		if _, stillEnabled := newByID[old.HardwareID]; stillEnabled {
			continue
		}
		if m.encoderUsage[old.HardwareID] > 0 {
			m.deactivated[old.HardwareID] = true
		}
	}

	// 3. Per-encoder cap shrink: for each encoder still enabled, if the new
	//    cap is below current usage, queue (usage − newCap) future releases
	//    to shrink totalSlots instead of freeing a slot.
	//    We clear any prior shrinkRemaining entry first so back-to-back
	//    reloads don't stack (e.g., 5→3 then 3→2 should leave exactly 1
	//    queued shrink remaining per subsequent reload, not accumulate).
	for _, enc := range newEncoders {
		usage := m.encoderUsage[enc.HardwareID]
		newCap := config.EffectiveConcurrentJobs(enc)
		if usage > newCap {
			m.shrinkRemaining[enc.HardwareID] = usage - newCap
		} else {
			// No over-capacity on this encoder — drop any stale shrink queue.
			delete(m.shrinkRemaining, enc.HardwareID)
		}
	}

	m.encoders = newEncoders

	// 4. Recompute totalSlots: live encoder capacity plus the outstanding
	//    occupancy on deactivated/shrinking encoders so FreeSlots reports
	//    correctly until those graceful shrinks drain.
	newTotal := 0
	for _, enc := range newEncoders {
		newTotal += config.EffectiveConcurrentJobs(enc)
	}
	for hid := range m.deactivated {
		newTotal += m.encoderUsage[hid]
	}
	for _, over := range m.shrinkRemaining {
		newTotal += over
	}
	if newTotal == 0 {
		newTotal = 1 // software-only fallback
	}
	m.totalSlots = newTotal
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
