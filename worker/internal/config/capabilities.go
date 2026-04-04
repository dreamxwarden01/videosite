package config

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Encoder represents a detected hardware encoder entry.
type Encoder struct {
	NumberID       int    `json:"number_id"`
	HardwareID     string `json:"hardware_id"`
	Name           string `json:"name"`
	EncoderType    string `json:"encoder_type"`
	Enable         bool   `json:"enable"`
	DeviceIndex    int    `json:"device_index"`
	ConcurrentJobs int    `json:"concurrent_jobs,omitempty"` // per-encoder slot limit (Windows); 0 treated as 1
}

// EffectiveConcurrentJobs returns the encoder's concurrent job limit,
// defaulting to 1 when unset (zero value).
func EffectiveConcurrentJobs(enc Encoder) int {
	if enc.ConcurrentJobs > 0 {
		return enc.ConcurrentJobs
	}
	return 1
}

// Capabilities holds detected hardware info and user-configurable settings.
type Capabilities struct {
	// ChipModel is the raw brand string (macOS only, e.g. "Apple M4").
	ChipModel string `json:"chip_model,omitempty"`

	// ChipTier is the parsed tier (macOS only: "Base", "Pro", "Max", "Ultra").
	ChipTier string `json:"chip_tier,omitempty"`

	// ConcurrentJobs is the number of simultaneous transcoding jobs allowed.
	// macOS: defaults based on chip tier. Windows: defaults to enabled encoder count.
	// User can edit capabilities.json to customise.
	ConcurrentJobs int `json:"concurrent_jobs,omitempty"`

	// Encoders holds the detected encoder(s).
	Encoders []Encoder `json:"encoders"`
}

var (
	currentCaps *Capabilities
	capsMu      sync.RWMutex
)

const capsFile = "capabilities.json"

// LoadCapabilities reads capabilities.json. Returns nil if not found.
func LoadCapabilities() (*Capabilities, error) {
	data, err := os.ReadFile(capsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read capabilities: %w", err)
	}

	var caps Capabilities
	if err := json.Unmarshal(data, &caps); err != nil {
		// File corrupt — return nil so it will be regenerated
		return nil, nil
	}

	capsMu.Lock()
	currentCaps = &caps
	capsMu.Unlock()

	return &caps, nil
}

// GetCapabilities returns the current capabilities (thread-safe).
func GetCapabilities() *Capabilities {
	capsMu.RLock()
	defer capsMu.RUnlock()
	return currentCaps
}

// SetCapabilities updates the in-memory capabilities (thread-safe).
func SetCapabilities(caps *Capabilities) {
	capsMu.Lock()
	currentCaps = caps
	capsMu.Unlock()
}

// SaveCapabilities writes capabilities to capabilities.json.
func SaveCapabilities(caps *Capabilities) error {
	data, err := json.MarshalIndent(caps, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal capabilities: %w", err)
	}

	if err := os.WriteFile(capsFile, data, 0644); err != nil {
		return fmt.Errorf("write capabilities: %w", err)
	}

	capsMu.Lock()
	currentCaps = caps
	capsMu.Unlock()

	return nil
}

// MergeCapabilities merges newly detected state with existing user-edited capabilities.
// chipModel, chipTier, and concurrentJobs are optional (pass "" and 0 on Windows).
func MergeCapabilities(existing *Capabilities, detected []Encoder, chipModel, chipTier string, concurrentJobs int) *Capabilities {
	if existing == nil {
		existing = &Capabilities{}
	}

	// Build maps of existing user-edited settings by hardware_id.
	enableMap := make(map[string]bool)
	concurrentMap := make(map[string]int)
	for _, e := range existing.Encoders {
		enableMap[e.HardwareID] = e.Enable
		if e.ConcurrentJobs > 0 {
			concurrentMap[e.HardwareID] = e.ConcurrentJobs
		}
	}

	// Build merged encoder list from detected entries.
	merged := make([]Encoder, 0, len(detected))
	for i, d := range detected {
		enc := Encoder{
			NumberID:       i,
			HardwareID:     d.HardwareID,
			Name:           d.Name,
			EncoderType:    d.EncoderType,
			Enable:         true, // default for newly detected
			DeviceIndex:    d.DeviceIndex,
			ConcurrentJobs: d.ConcurrentJobs, // carry forward from detection default
		}
		// Preserve user-set enable state.
		if prev, ok := enableMap[d.HardwareID]; ok {
			enc.Enable = prev
		}
		// Preserve user-set per-encoder concurrent jobs.
		if prev, ok := concurrentMap[d.HardwareID]; ok {
			enc.ConcurrentJobs = prev
		}
		merged = append(merged, enc)
	}

	return &Capabilities{
		ChipModel:      chipModel,
		ChipTier:       chipTier,
		ConcurrentJobs: concurrentJobs,
		Encoders:       merged,
	}
}

// EnabledEncoders returns only enabled encoders.
func EnabledEncoders() []Encoder {
	capsMu.RLock()
	defer capsMu.RUnlock()
	if currentCaps == nil {
		return nil
	}
	var enabled []Encoder
	for _, e := range currentCaps.Encoders {
		if e.Enable {
			enabled = append(enabled, e)
		}
	}
	return enabled
}
