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
type OutputProfile struct {
	Name             string `json:"name"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	VideoBitrateKbps int    `json:"video_bitrate_kbps"`
	AudioBitrateKbps int    `json:"audio_bitrate_kbps"`
	Codec            string `json:"codec"`
	Profile          string `json:"profile"`
	Preset           string `json:"preset"`
	SegmentDuration  int    `json:"segment_duration"`
	GOPSize          int    `json:"gop_size"`
}

// Config holds the worker configuration loaded from config.json.
type Config struct {
	SiteHostname      string          `json:"site_hostname"`
	AccessKeyID       string          `json:"access_key_id"`
	AccessKeySecret   string          `json:"access_key_secret"`
	EnableMTLS        *bool           `json:"enable_mtls,omitempty"`
	UseSystemProxy    bool            `json:"useSystemProxies"`
	OutputProfiles    []OutputProfile `json:"output_profiles"`
	ConcurrentUploads   int             `json:"concurrent_uploads"`   // max parallel file uploads (default 10)
	ConcurrentDownloads int             `json:"concurrent_downloads"` // max parallel part downloads (default 5)

	// Audio normalization (EBU R128 two-pass loudnorm).
	AudioNormalization        bool    `json:"audio_normalization"`         // true = normalize audio; false = skip
	AudioNormalizationTarget  float64 `json:"audio_normalization_target"`  // integrated loudness target in LUFS (e.g. -16)
	AudioNormalizationPeak    float64 `json:"audio_normalization_peak"`    // true peak ceiling in dBFS (e.g. -1.5)
	AudioNormalizationMaxGain float64 `json:"audio_normalization_max_gain"` // max upward gain in dB (e.g. 10)
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

// DefaultProfiles returns the default output profiles.
func DefaultProfiles() []OutputProfile {
	return []OutputProfile{
		{
			Name: "1080p", Width: 1920, Height: 1080,
			VideoBitrateKbps: 3500, AudioBitrateKbps: 128,
			Codec: "h264", Profile: "high", Preset: "medium",
			SegmentDuration: 6, GOPSize: 48,
		},
		{
			Name: "720p", Width: 1280, Height: 720,
			VideoBitrateKbps: 2000, AudioBitrateKbps: 128,
			Codec: "h264", Profile: "main", Preset: "medium",
			SegmentDuration: 6, GOPSize: 48,
		},
	}
}

// Load reads config.json. Returns nil if file doesn't exist (first run).
// If the file exists but is missing newer fields (e.g. concurrent_uploads),
// defaults are applied and the file is updated automatically.
func Load() (*Config, error) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	// Detect missing fields in raw JSON for migration.
	var raw map[string]json.RawMessage
	json.Unmarshal(data, &raw)

	// Auto-migrate: add missing fields introduced in newer versions.
	needsSave := false
	var migrated []string

	if cfg.ConcurrentUploads <= 0 {
		cfg.ConcurrentUploads = 10
		needsSave = true
		migrated = append(migrated, "concurrent_uploads=10")
	}
	if _, ok := raw["concurrent_downloads"]; !ok {
		cfg.ConcurrentDownloads = 5
		needsSave = true
		migrated = append(migrated, "concurrent_downloads=5")
	}
	if _, ok := raw["useSystemProxies"]; !ok {
		cfg.UseSystemProxy = false
		needsSave = true
		migrated = append(migrated, "useSystemProxies=false")
	}
	// Note: output_profiles and audio_normalization_* are now provided by the
	// server per-job via the lease response. Local config values are ignored.
	// Existing fields are kept for backward compatibility (they parse without
	// error but are never read during transcoding).

	mu.Lock()
	current = &cfg
	mu.Unlock()

	if needsSave {
		if saveErr := Save(&cfg); saveErr != nil {
			slog.Warn("Failed to save config with updated defaults", "err", saveErr)
		} else {
			slog.Info("Config auto-migrated", "fields", strings.Join(migrated, ", "))
		}
	}

	return &cfg, nil
}

// Get returns the current config (thread-safe).
func Get() *Config {
	mu.RLock()
	defer mu.RUnlock()
	return current
}

// Reload re-reads config.json and returns a summary of changes.
func Reload() (string, error) {
	mu.RLock()
	old := current
	mu.RUnlock()

	newCfg, err := Load()
	if err != nil {
		return "", err
	}
	if newCfg == nil {
		return "", fmt.Errorf("config.json not found")
	}

	var changes []string
	if old != nil {
		if old.SiteHostname != newCfg.SiteHostname {
			changes = append(changes, fmt.Sprintf("site_hostname: %s -> %s", old.SiteHostname, newCfg.SiteHostname))
		}
		if old.AccessKeyID != newCfg.AccessKeyID {
			changes = append(changes, "access_key_id changed")
		}
		if old.AccessKeySecret != newCfg.AccessKeySecret {
			changes = append(changes, "access_key_secret changed")
		}
		if old.MTLSEnabled() != newCfg.MTLSEnabled() {
			changes = append(changes, fmt.Sprintf("enable_mtls: %v -> %v", old.MTLSEnabled(), newCfg.MTLSEnabled()))
		}
		if old.UseSystemProxy != newCfg.UseSystemProxy {
			changes = append(changes, fmt.Sprintf("useSystemProxies: %v -> %v", old.UseSystemProxy, newCfg.UseSystemProxy))
		}
		if old.ConcurrentUploads != newCfg.ConcurrentUploads {
			changes = append(changes, fmt.Sprintf("concurrent_uploads: %d -> %d", old.ConcurrentUploads, newCfg.ConcurrentUploads))
		}
		if old.ConcurrentDownloads != newCfg.ConcurrentDownloads {
			changes = append(changes, fmt.Sprintf("concurrent_downloads: %d -> %d", old.ConcurrentDownloads, newCfg.ConcurrentDownloads))
		}
	}

	if len(changes) == 0 {
		return "No changes detected", nil
	}
	return strings.Join(changes, ", "), nil
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
