package hardware

import (
	"fmt"
	"os/exec"
	"strings"
	"videosite-worker/internal/config"
	"videosite-worker/internal/util"
)

// detectGPUs detects available GPUs on Windows via nvidia-smi and WMI.
func detectGPUs() []DetectedGPU {
	var gpus []DetectedGPU
	gpus = append(gpus, detectNVIDIA()...)
	gpus = append(gpus, detectWMI()...)
	return gpus
}

func detectNVIDIA() []DetectedGPU {
	// Query name, UUID, and CUDA device index for each GPU.
	out, err := exec.Command("nvidia-smi",
		"--query-gpu=name,gpu_uuid,index",
		"--format=csv,noheader").Output()
	if err != nil {
		return nil
	}

	var gpus []DetectedGPU
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ",", 3)
		if len(parts) != 3 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		uuid := strings.TrimSpace(parts[1])
		indexStr := strings.TrimSpace(parts[2])

		var cudaIndex int
		fmt.Sscanf(indexStr, "%d", &cudaIndex)

		gpus = append(gpus, DetectedGPU{
			HardwareID:  uuid,
			Name:        name,
			EncoderType: EncoderNVENC,
			DeviceIndex: cudaIndex,
		})
	}
	return gpus
}

func detectWMI() []DetectedGPU {
	// wmic is deprecated/removed in Windows 11 24H2+. Use PowerShell Get-CimInstance instead.
	// Output: quoted CSV with header "Name","PNPDeviceID"
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		`Get-CimInstance Win32_VideoController | Select-Object -Property Name,PNPDeviceID | ConvertTo-Csv -NoTypeInformation`).Output()
	if err != nil {
		return nil
	}

	var gpus []DetectedGPU
	// Separate counters so each encoder type gets its own sequential device index.
	qsvIndex := 0
	amfIndex := 0

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || i == 0 { // skip empty lines and header row
			continue
		}
		// CSV format: "Name","PNPDeviceID" (quoted fields)
		parts := splitCSV(line)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		pnpID := parts[1]
		nameLower := strings.ToLower(name)

		// AMD GPUs (AMF)
		if strings.Contains(nameLower, "amd") || strings.Contains(nameLower, "radeon") {
			gpus = append(gpus, DetectedGPU{
				HardwareID:  pnpID,
				Name:        name,
				EncoderType: EncoderAMF,
				DeviceIndex: amfIndex,
			})
			amfIndex++
		}

		// Intel GPUs (QSV)
		if strings.Contains(nameLower, "intel") && (strings.Contains(nameLower, "hd graphics") ||
			strings.Contains(nameLower, "uhd graphics") || strings.Contains(nameLower, "iris") ||
			strings.Contains(nameLower, "arc")) {
			gpus = append(gpus, DetectedGPU{
				HardwareID:  pnpID,
				Name:        name,
				EncoderType: EncoderQSV,
				DeviceIndex: qsvIndex,
			})
			qsvIndex++
		}
	}
	return gpus
}

// splitCSV splits a single CSV line and strips surrounding quotes from each field.
// Handles simple quoted fields as produced by PowerShell ConvertTo-Csv.
func splitCSV(line string) []string {
	parts := strings.Split(line, ",")
	result := make([]string, len(parts))
	for i, p := range parts {
		p = strings.TrimSpace(p)
		p = strings.Trim(p, `"`)
		result[i] = p
	}
	return result
}

// ProbeCUDAHWDecode checks whether NVDEC hardware decoding is available by
// looking for "cuda" in the output of "ffmpeg -hwaccels".
func ProbeCUDAHWDecode() bool {
	out, err := exec.Command("ffmpeg", "-hwaccels").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "cuda")
}

// ValidateEncoder tests if a given encoder type actually works with FFmpeg.
// Uses type-specific initialization flags to match what the transcoder uses:
//   - QSV: -init_hw_device to open the QSV device before testing h264_qsv
//   - NVENC: -gpu N to target the specific CUDA device
//   - AMF/SOFTWARE: standard test
func ValidateEncoder(encoderType string, deviceIndex int) bool {
	ffmpegName, ok := FFmpegEncoderName[encoderType]
	if !ok {
		return false
	}

	var args []string
	switch encoderType {
	case EncoderQSV:
		// h264_qsv requires the QSV device to be initialized first.
		// Without -init_hw_device, FFmpeg cannot open the QSV context and the
		// encoder fails even when Intel drivers and oneVPL/MFX are installed.
		// Use auto-select ("hw") for validation — device-specific init is used
		// during actual transcoding.
		args = []string{
			"-init_hw_device", "qsv=hw",
			"-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
			"-c:v", ffmpegName,
			"-f", "null", "-",
		}
	case EncoderNVENC:
		// Target the specific CUDA device to verify this GPU's NVENC works.
		args = []string{
			"-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
			"-c:v", ffmpegName,
			"-gpu", fmt.Sprintf("%d", deviceIndex),
			"-f", "null", "-",
		}
	default:
		args = []string{
			"-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
			"-c:v", ffmpegName,
			"-f", "null", "-",
		}
	}

	cmd := exec.Command("ffmpeg", args...)
	if err := cmd.Run(); err != nil {
		fmt.Printf("%s   [WARN] %s (%s) encoder validation failed: %v\n", util.Ts(), encoderType, ffmpegName, err)
		return false
	}
	return true
}

// DetectAndMerge detects available hardware encoders and merges with existing capabilities.
func DetectAndMerge() (*config.Capabilities, error) {
	// Probe CUDA hardware decode + scale_cuda filter support.
	// Done every startup so the flag stays accurate after FFmpeg upgrades.
	SetCUDAHWDecodeSupported(ProbeCUDAHWDecode())

	existing, _ := config.LoadCapabilities()

	detected := detectGPUs()

	// Validate each detected encoder with FFmpeg
	var validated []config.Encoder
	for i, gpu := range detected {
		fmt.Printf("%s   Detected: %s (%s, device %d) — validating...\n", util.Ts(), gpu.Name, gpu.EncoderType, gpu.DeviceIndex)
		if ValidateEncoder(gpu.EncoderType, gpu.DeviceIndex) {
			fmt.Printf("%s   OK: %s (%s)\n", util.Ts(), gpu.Name, gpu.EncoderType)
			validated = append(validated, config.Encoder{
				NumberID:       i,
				HardwareID:     gpu.HardwareID,
				Name:           gpu.Name,
				EncoderType:    gpu.EncoderType,
				Enable:         true,
				DeviceIndex:    gpu.DeviceIndex,
				ConcurrentJobs: 1,
			})
		}
	}

	// Windows: global concurrent_jobs is 0 (omitted); per-encoder slots are authoritative.
	merged := config.MergeCapabilities(existing, validated, "", "", 0)

	if err := config.SaveCapabilities(merged); err != nil {
		return nil, err
	}

	return merged, nil
}
