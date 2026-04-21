package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
)

// OutputProfile defines a transcoding output profile.
//
// This is the shape the server sends per-job in the lease response
// (see api.LeaseResult.OutputProfiles). It is NOT read from config.json —
// each job's profile set is authoritative and can differ between jobs.
//
// Audio bitrate is site-wide (api.LeaseResult.AudioBitrateKbps), not per-profile.
// FpsLimit caps the output frame rate for this profile; sources below the limit
// are passed through unchanged (no upsampling).
type OutputProfile struct {
	Name             string `json:"name"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	VideoBitrateKbps int    `json:"video_bitrate_kbps"`
	FpsLimit         int    `json:"fps_limit"`
	Codec            string `json:"codec"`
	Profile          string `json:"profile"`
	Preset           string `json:"preset"`
	SegmentDuration  int    `json:"segment_duration"`
	GOPSize          int    `json:"gop_size"`
}

// Config holds the worker configuration loaded from config.json.
//
// Note: output_profiles and audio_normalization_* are deliberately absent.
// Those values are supplied by the server per-job via the lease response
// (see api.LeaseResult), not from the worker's local config. If they appear
// in an existing config.json file they are silently ignored on parse.
type Config struct {
	SiteHostname        string `json:"site_hostname"`
	AccessKeyID         string `json:"access_key_id"`
	AccessKeySecret     string `json:"access_key_secret"`
	EnableMTLS          *bool  `json:"enable_mtls,omitempty"`
	UseSystemProxy      bool   `json:"use_system_proxies"`
	ConcurrentUploads   int    `json:"concurrent_uploads"`   // max parallel file uploads (default 10)
	ConcurrentDownloads int    `json:"concurrent_downloads"` // max parallel part downloads (default 5)
}

// MTLSEnabled returns true if enable_mtls is explicitly set to true.
func (c *Config) MTLSEnabled() bool {
	return c.EnableMTLS != nil && *c.EnableMTLS
}

// SetMTLS sets the enable_mtls field and saves to disk.
func (c *Config) SetMTLS(enabled bool) error {
	c.EnableMTLS = &enabled
	return Save(c)
}

var (
	current *Config
	mu      sync.RWMutex
)

const configFile = "config.json"

// Defaults for fields that must be positive. Applied by validateAndNormalize.
const (
	defaultConcurrentUploads   = 10
	defaultConcurrentDownloads = 5
)

// ReloadResult reports the outcome of a Reload() call so the caller can act
// per-field (rebuild HTTP client on proxy change, warn on mTLS/hostname change,
// etc.). Summary is pre-formatted for console output.
type ReloadResult struct {
	Summary            string   // human-readable, for console
	HostnameChanged    bool     // true if site_hostname differs (LOCKED — reverted in memory)
	OldHostname        string   // previous value, for the restart-required warning
	MTLSChanged        bool     // true if enable_mtls differs (LOCKED — reverted in memory)
	OldMTLSEnabled     *bool    // previous value, for the restart-required warning
	ProxyChanged       bool     // true if use_system_proxies differs
	ConcurrencyChanged bool     // true if concurrent_uploads or concurrent_downloads differs
	KeysChanged        bool     // true if access_key_id or access_key_secret differs (log-only)
	InvalidFields      []string // any fields that were auto-corrected during load
}

// validateAndNormalize resets invalid numeric fields to their defaults so the
// worker keeps running with sane values even if the user entered 0 or a
// negative number. Returns the list of corrections for user-visible logging.
func validateAndNormalize(cfg *Config) []string {
	var fixed []string
	if cfg.ConcurrentUploads <= 0 {
		cfg.ConcurrentUploads = defaultConcurrentUploads
		fixed = append(fixed, fmt.Sprintf("concurrent_uploads reset to %d (was <= 0)", defaultConcurrentUploads))
	}
	if cfg.ConcurrentDownloads <= 0 {
		cfg.ConcurrentDownloads = defaultConcurrentDownloads
		fixed = append(fixed, fmt.Sprintf("concurrent_downloads reset to %d (was <= 0)", defaultConcurrentDownloads))
	}
	return fixed
}

// Load reads config.json. Returns nil if the file doesn't exist (first run).
// Missing fields get defaults, invalid fields are reset, and the file is
// rewritten so subsequent loads see a clean shape. Startup callers log the
// fix-ups via slog; Reload uses loadAndNormalize directly to surface them in
// ReloadResult.
func Load() (*Config, error) {
	cfg, fixups, err := loadAndNormalize()
	if err != nil || cfg == nil {
		return cfg, err
	}
	if len(fixups) > 0 {
		slog.Info("Config auto-migrated", "fields", strings.Join(fixups, ", "))
	}
	return cfg, nil
}

// loadAndNormalize is the internal Load implementation. It returns the parsed
// config plus a list of any auto-corrections applied (missing fields filled
// in, invalid numeric values reset, camelCase keys migrated). On error the
// in-memory `current` pointer is NOT touched — callers keep running on the
// previous values.
func loadAndNormalize() (*Config, []string, error) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, nil, fmt.Errorf("parse config: %w", err)
	}

	// Inspect raw keys to drive migration — struct-tag unmarshal alone can't
	// tell us which keys were present in the file.
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &raw)

	needsSave := false
	var fixups []string

	// useSystemProxies → use_system_proxies rename. If the new key is absent
	// but the old one is present, port the value over. If neither is present,
	// zero value (false) is already assigned.
	if _, hasNew := raw["use_system_proxies"]; !hasNew {
		if oldVal, hasOld := raw["useSystemProxies"]; hasOld {
			_ = json.Unmarshal(oldVal, &cfg.UseSystemProxy)
			fixups = append(fixups, fmt.Sprintf("use_system_proxies=%v (migrated from useSystemProxies)", cfg.UseSystemProxy))
		} else {
			fixups = append(fixups, "use_system_proxies=false")
		}
		needsSave = true
	}

	// Missing concurrent_downloads key → add the default explicitly.
	if _, ok := raw["concurrent_downloads"]; !ok {
		cfg.ConcurrentDownloads = defaultConcurrentDownloads
		fixups = append(fixups, fmt.Sprintf("concurrent_downloads=%d", defaultConcurrentDownloads))
		needsSave = true
	}

	// Numeric validation: positive-int enforcement for the two concurrency
	// settings. Anything <= 0 gets reset to the default so fan-out doesn't
	// deadlock on a zero-sized gate.
	for _, f := range validateAndNormalize(&cfg) {
		fixups = append(fixups, f)
		needsSave = true
	}

	mu.Lock()
	current = &cfg
	mu.Unlock()

	if needsSave {
		if saveErr := Save(&cfg); saveErr != nil {
			slog.Warn("Failed to save config with updated defaults", "err", saveErr)
		}
	}

	return &cfg, fixups, nil
}

// Get returns the current config (thread-safe).
func Get() *Config {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

// Reload re-reads config.json and returns a structured change set.
//
// Two fields are locked against hot-swap because they anchor trust:
//   - site_hostname — what TLS validates against and what every URL points to.
//   - enable_mtls   — whether a client cert is presented at all.
//
// If either drifts we revert the new in-memory config to the old value before
// publishing it, and set the *Changed flags so the caller can warn the user
// that a restart is required. The user's intended change stays on disk and
// takes effect on the next restart.
//
// If the file can't be read or parsed, the in-memory `current` pointer is
// left untouched and the error is returned so the caller can print a warning
// and keep running.
func Reload() (ReloadResult, error) {
	mu.RLock()
	old := current
	mu.RUnlock()

	newCfg, fixups, err := loadAndNormalize()
	if err != nil {
		return ReloadResult{}, fmt.Errorf("config reload failed, keeping previous values: %w", err)
	}
	if newCfg == nil {
		return ReloadResult{}, fmt.Errorf("config.json not found")
	}

	result := ReloadResult{InvalidFields: fixups}
	if old == nil {
		// No previous config — treat this like a fresh load. Nothing to diff.
		result.Summary = "initial load"
		return result, nil
	}

	// --- Locked fields: detect drift, revert in memory, flag for the caller.
	if old.SiteHostname != newCfg.SiteHostname {
		result.HostnameChanged = true
		result.OldHostname = old.SiteHostname
		// Revert in the new in-memory config so readers never see the drifted
		// value. The on-disk value is left alone — a restart will apply it.
		mu.Lock()
		if current != nil {
			current.SiteHostname = old.SiteHostname
		}
		mu.Unlock()
	}
	if old.MTLSEnabled() != newCfg.MTLSEnabled() {
		result.MTLSChanged = true
		result.OldMTLSEnabled = old.EnableMTLS
		mu.Lock()
		if current != nil {
			current.EnableMTLS = old.EnableMTLS
		}
		mu.Unlock()
	}

	// --- Live-reload fields: produce a summary and set flags for side-effects.
	var changes []string
	if result.HostnameChanged {
		changes = append(changes, fmt.Sprintf("site_hostname: %s -> %s (LOCKED — restart required)", old.SiteHostname, newCfg.SiteHostname))
	}
	if result.MTLSChanged {
		changes = append(changes, fmt.Sprintf("enable_mtls: %v -> %v (LOCKED — restart required)", old.MTLSEnabled(), newCfg.MTLSEnabled()))
	}
	if old.AccessKeyID != newCfg.AccessKeyID {
		result.KeysChanged = true
		changes = append(changes, "access_key_id changed")
	}
	if old.AccessKeySecret != newCfg.AccessKeySecret {
		result.KeysChanged = true
		changes = append(changes, "access_key_secret changed")
	}
	if old.UseSystemProxy != newCfg.UseSystemProxy {
		result.ProxyChanged = true
		changes = append(changes, fmt.Sprintf("use_system_proxies: %v -> %v", old.UseSystemProxy, newCfg.UseSystemProxy))
	}
	if old.ConcurrentUploads != newCfg.ConcurrentUploads {
		result.ConcurrencyChanged = true
		changes = append(changes, fmt.Sprintf("concurrent_uploads: %d -> %d", old.ConcurrentUploads, newCfg.ConcurrentUploads))
	}
	if old.ConcurrentDownloads != newCfg.ConcurrentDownloads {
		result.ConcurrencyChanged = true
		changes = append(changes, fmt.Sprintf("concurrent_downloads: %d -> %d", old.ConcurrentDownloads, newCfg.ConcurrentDownloads))
	}

	if len(changes) == 0 {
		result.Summary = "No changes detected"
	} else {
		result.Summary = strings.Join(changes, ", ")
	}
	return result, nil
}

// Save writes config to config.json.
func Save(cfg *Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	if err := os.WriteFile(configFile, data, 0644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	mu.Lock()
	current = cfg
	mu.Unlock()

	return nil
}

// RunFirstSetup prompts the user for initial configuration via stdin.
func RunFirstSetup() (*Config, error) {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println("=== VideoSite Worker — First Run Setup ===")
	fmt.Println()

	hostname := prompt(reader, "Site hostname (e.g., example.com or localhost:3000): ")
	keyID := prompt(reader, "Worker access key ID (e.g., wk_...): ")
	keySecret := prompt(reader, "Worker access key secret: ")

	cfg := &Config{
		SiteHostname:        strings.TrimSpace(hostname),
		AccessKeyID:         strings.TrimSpace(keyID),
		AccessKeySecret:     strings.TrimSpace(keySecret),
		ConcurrentUploads:   10,
		ConcurrentDownloads: 5,
	}

	if err := Save(cfg); err != nil {
		return nil, fmt.Errorf("save config: %w", err)
	}

	fmt.Println()
	fmt.Println("Config saved to config.json")
	return cfg, nil
}

func prompt(reader *bufio.Reader, message string) string {
	fmt.Print(message)
	text, _ := reader.ReadString('\n')
	return strings.TrimRight(text, "\r\n")
}
