package hardware

import (
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"videosite-worker/internal/config"
	"videosite-worker/internal/util"
)

// chipTierDefaults maps chip tier suffix to default concurrent job count.
// Tier detection is case-insensitive and matched against the trailing word.
// Values align with the number of Apple Media Engines per chip tier.
//
//	Apple M<N>        → Base  → 1 concurrent job  (1 media engine)
//	Apple M<N> Pro    → Pro   → 1 concurrent job  (1 media engine)
//	Apple M<N> Max    → Max   → 2 concurrent jobs (2 media engines)
//	Apple M<N> Ultra  → Ultra → 4 concurrent jobs (4 media engines)
var chipTierDefaults = []struct {
	suffix     string
	tier       string
	concurrent int
}{
	{"ultra", "Ultra", 4},
	{"max", "Max", 2},
	{"pro", "Pro", 1},
}

// appleChipRe matches "Apple M<number>" optionally followed by Pro/Max/Ultra.
var appleChipRe = regexp.MustCompile(`(?i)^Apple\s+M\d+`)

// ReadChipBrandString reads the raw chip brand string from sysctl.
// Returns e.g. "Apple M4", "Apple M3 Pro", "Apple M3 Ultra".
func ReadChipBrandString() (string, error) {
	out, err := exec.Command("/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string").Output()
	if err != nil {
		return "", fmt.Errorf("sysctl machdep.cpu.brand_string: %w", err)
	}
	brand := strings.TrimSpace(string(out))
	if brand == "" {
		return "", fmt.Errorf("machdep.cpu.brand_string is empty")
	}
	return brand, nil
}

// ParseChipTier extracts tier name and default concurrent job count from a
// chip brand string. Non-Apple or unrecognised strings default to Base/1.
func ParseChipTier(brandString string) (tier string, defaultConcurrent int) {
	lower := strings.ToLower(strings.TrimSpace(brandString))
	for _, entry := range chipTierDefaults {
		if strings.HasSuffix(lower, " "+entry.suffix) {
			return entry.tier, entry.concurrent
		}
	}
	return "Base", 1
}

// DetectChip reads machdep.cpu.brand_string and extracts chip model + tier.
// Returns (model, tier, defaultConcurrentJobs, error).
func DetectChip() (model, tier string, defaultConcurrent int, err error) {
	brand, err := ReadChipBrandString()
	if err != nil {
		return "", "", 1, err
	}
	if !appleChipRe.MatchString(brand) {
		// Not a recognised Apple Silicon chip string — treat as Base.
		return brand, "Base", 1, nil
	}
	tier, defaultConcurrent = ParseChipTier(brand)
	return brand, tier, defaultConcurrent, nil
}

// ProbeVTHWDecode checks whether VideoToolbox hardware decoding is available
// by scanning the output of "ffmpeg -hwaccels" for "videotoolbox".
//
// Note: FFmpeg's stream mapping displays "h264 (native)" as the decoder name
// even when VT hwaccel is active — this is normal. The true indicator is the
// pixel format, which will be "videotoolbox_vld" when VT decode is in use.
func ProbeVTHWDecode() bool {
	out, err := exec.Command("ffmpeg", "-hwaccels").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "videotoolbox")
}

// ProbeScaleVT checks whether the scale_vt filter is available in the current
// FFmpeg build. scale_vt performs hardware scaling on VideoToolbox frames
// (videotoolbox_vld pixel format), enabling a fully Media Engine pipeline:
//
//	VT hw decode → scale_vt → h264_videotoolbox
//
// No frames are downloaded to system memory; no CPU involvement for video.
// Available since FFmpeg 6.x with --enable-videotoolbox.
func ProbeScaleVT() bool {
	out, err := exec.Command("ffmpeg", "-filters").Output()
	if err != nil {
		return false
	}
	// The filter list contains " scale_vt " with surrounding whitespace.
	return strings.Contains(string(out), " scale_vt ")
}

// ValidateEncoder tests if h264_videotoolbox (or libx264) works with FFmpeg
// by attempting to encode a null video source.
func ValidateEncoder(encoderType string, deviceIndex int) bool {
	ffmpegName, ok := FFmpegEncoderName[encoderType]
	if !ok {
		return false
	}

	args := []string{
		"-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
		"-c:v", ffmpegName,
		"-f", "null", "-",
	}
	cmd := exec.Command("ffmpeg", args...)
	if err := cmd.Run(); err != nil {
		fmt.Printf("%s   [WARN] %s (%s) encoder validation failed: %v\n", util.Ts(), encoderType, ffmpegName, err)
		return false
	}
	return true
}

// ChipGeneration extracts the generation number from an Apple chip brand string.
// E.g. "Apple M4 Pro" → 4. Returns 0 if not parseable.
func ChipGeneration(brandString string) int {
	// Find "M" followed by digits
	re := regexp.MustCompile(`(?i)Apple\s+M(\d+)`)
	m := re.FindStringSubmatch(brandString)
	if len(m) < 2 {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// DetectAndMerge detects the chip, probes VideoToolbox availability, and merges
// with any existing capabilities.json (preserving user customisations).
//
// Returns the merged capabilities and an error describing any detection problem.
// A non-nil error here is non-fatal (capabilities may still be usable).
func DetectAndMerge() (*config.Capabilities, error) {
	// Probe VT hardware capabilities.
	// Done every startup so flags stay accurate after FFmpeg upgrades.
	SetVTHWDecodeSupported(ProbeVTHWDecode())
	SetScaleVTSupported(ProbeScaleVT())

	// Detect chip model and tier.
	chipModel, chipTier, defaultConcurrent, chipErr := DetectChip()

	existing, _ := config.LoadCapabilities()

	// Build the detected VT encoder entry.
	var detected []config.Encoder
	vtName := "VideoToolbox"
	if chipModel != "" {
		vtName = fmt.Sprintf("VideoToolbox (%s)", chipModel)
	}

	fmt.Printf("%s   Detected: %s — validating...\n", util.Ts(), vtName)
	if ValidateEncoder(EncoderVT, 0) {
		fmt.Printf("%s   OK: %s\n", util.Ts(), vtName)
		detected = append(detected, config.Encoder{
			NumberID:    0,
			HardwareID:  "apple-videotoolbox",
			Name:        vtName,
			EncoderType: EncoderVT,
			Enable:      true,
			DeviceIndex: 0,
		})
	} else {
		fmt.Printf("%s   WARN: VideoToolbox encoder validation failed — software encoding only\n", util.Ts())
	}

	// Determine concurrent_jobs default.
	// If existing caps already have a custom value, preserve it.
	// If the existing value is 0 or caps are absent, use the chip default.
	concurrentJobs := defaultConcurrent
	if existing != nil && existing.ConcurrentJobs > 0 {
		concurrentJobs = existing.ConcurrentJobs
	}

	merged := config.MergeCapabilities(existing, detected, chipModel, chipTier, concurrentJobs)

	if err := config.SaveCapabilities(merged); err != nil {
		return nil, err
	}

	if chipErr != nil {
		return merged, fmt.Errorf("chip detection: %w", chipErr)
	}
	return merged, nil
}
