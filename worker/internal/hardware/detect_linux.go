//go:build linux

package hardware

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"videosite-worker/internal/config"
	"videosite-worker/internal/util"
)

// detectGPUs detects available GPUs on Linux via nvidia-smi (NVENC) and the
// /dev/dri/renderD12* device nodes (QSV, Intel only).
func detectGPUs() []DetectedGPU {
	var gpus []DetectedGPU
	gpus = append(gpus, detectNVIDIA()...)
	gpus = append(gpus, detectIntelQSV()...)
	return gpus
}

func detectNVIDIA() []DetectedGPU {
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

// detectIntelQSV enumerates /dev/dri/renderD12* nodes and registers each one
// whose PCI vendor is Intel (0x8086) as a candidate QSV encoder. The functional
// check happens later in ValidateEncoder — non-Intel devices are filtered here
// to avoid probing NVIDIA's DRM node with h264_qsv.
func detectIntelQSV() []DetectedGPU {
	matches, err := filepath.Glob("/dev/dri/renderD12*")
	if err != nil {
		return nil
	}

	var gpus []DetectedGPU
	for _, devPath := range matches {
		base := filepath.Base(devPath) // e.g. "renderD128"

		vendorBytes, err := os.ReadFile(fmt.Sprintf("/sys/class/drm/%s/device/vendor", base))
		if err != nil {
			continue
		}
		vendor := strings.TrimSpace(string(vendorBytes))
		if !strings.EqualFold(vendor, "0x8086") {
			continue
		}

		var idx int
		fmt.Sscanf(base, "renderD%d", &idx)

		// Best-effort display name. Falls back to a synthetic label if
		// the PCI device ID can't be read.
		name := fmt.Sprintf("Intel GPU @ %s", devPath)
		if devIDBytes, err := os.ReadFile(fmt.Sprintf("/sys/class/drm/%s/device/device", base)); err == nil {
			devID := strings.TrimPrefix(strings.TrimSpace(string(devIDBytes)), "0x")
			name = fmt.Sprintf("Intel GPU (PCI 8086:%s) @ %s", devID, devPath)
		}

		gpus = append(gpus, DetectedGPU{
			HardwareID:  devPath, // /dev path is stable across reboots
			Name:        name,
			EncoderType: EncoderQSV,
			DeviceIndex: idx,
		})
	}
	return gpus
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
//   - QSV: -init_hw_device qsv=hw,child_device=/dev/dri/renderD<N>
//   - NVENC: -gpu N to target the specific CUDA device
//   - SOFTWARE: standard test
func ValidateEncoder(encoderType string, deviceIndex int) bool {
	ffmpegName, ok := FFmpegEncoderName[encoderType]
	if !ok {
		return false
	}

	var args []string
	switch encoderType {
	case EncoderQSV:
		// Target the specific DRM render node so we validate the actual
		// device we'll use during transcoding.
		args = []string{
			"-init_hw_device", fmt.Sprintf("qsv=hw,child_device=/dev/dri/renderD%d", deviceIndex),
			"-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
			"-c:v", ffmpegName,
			"-f", "null", "-",
		}
	case EncoderNVENC:
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
	SetCUDAHWDecodeSupported(ProbeCUDAHWDecode())

	existing, _ := config.LoadCapabilities()

	detected := detectGPUs()

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

	// Linux: global concurrent_jobs is 0 (omitted); per-encoder slots are authoritative.
	merged := config.MergeCapabilities(existing, validated, "", "", 0)

	if err := config.SaveCapabilities(merged); err != nil {
		return nil, err
	}

	return merged, nil
}
