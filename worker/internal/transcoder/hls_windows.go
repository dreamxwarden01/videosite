//go:build windows

package transcoder

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// TranscodeToHLS transcodes a source file to HLS for a given profile.
//
// Hardware acceleration strategies per encoder type:
//
//   - NVENC: NVDEC decode → scale_cuda → h264_nvenc (frames stay on GPU)
//   - AMF:   D3D11VA decode → CPU scale/pad → h264_amf
//   - QSV:   QSV decode → vpp_qsv scale → h264_qsv (no padding support)
//
// Each has a tier-2 fallback: CPU decode + CPU scale/pad → hardware encode.
// swDecode=true forces the tier-2 path.
func TranscodeToHLS(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, encoder config.Encoder, duration float64, keyInfoFile string, swDecode bool, logFile string, srcW, srcH int, loudnormFilter string) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	ffmpegEncoder := hardware.FFmpegEncoderName[encoder.EncoderType]
	if ffmpegEncoder == "" {
		ffmpegEncoder = "libx264"
	}

	// CPU scale+pad filter used by AMF, QSV, and software paths.
	cpuVF := fmt.Sprintf(
		"scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
		profile.Width, profile.Height, profile.Width, profile.Height,
	)

	var hwArgs []string
	var vfFilter string

	switch encoder.EncoderType {
	case hardware.EncoderNVENC:
		if hardware.CUDAHWDecodeSupported() && !swDecode {
			// Full GPU: NVDEC decode → scale_cuda → h264_nvenc, frames never leave GPU.
			hwArgs = []string{
				"-hwaccel", "cuda",
				"-hwaccel_device", strconv.Itoa(encoder.DeviceIndex),
				"-hwaccel_output_format", "cuda",
			}
			vfFilter = fmt.Sprintf("scale_cuda=%d:%d", profile.Width, profile.Height)
		} else {
			// Tier 2: CPU decode+scale, GPU encode via h264_nvenc.
			vfFilter = cpuVF
		}
	case hardware.EncoderAMF:
		if !swDecode {
			// Full GPU: D3D11VA decode on the specific adapter.
			hwArgs = []string{"-hwaccel", "d3d11va", "-hwaccel_device", strconv.Itoa(encoder.DeviceIndex)}
		}
		// CPU scale/pad for both tiers (no d3d11va scaling filter).
		vfFilter = cpuVF
	case hardware.EncoderQSV:
		// Check if padding is needed (source aspect ratio differs from output).
		// vpp_qsv cannot pad, so fall back to CPU scale/pad when needed.
		needsPad := srcW > 0 && srcH > 0 &&
			srcW*profile.Height != srcH*profile.Width

		if !swDecode && !needsPad {
			// Full GPU: QSV decode → vpp_qsv scale → h264_qsv encode.
			hwArgs = []string{
				"-init_hw_device", fmt.Sprintf("qsv=hw:%d", encoder.DeviceIndex),
				"-hwaccel", "qsv",
				"-hwaccel_device", "hw",
				"-hwaccel_output_format", "qsv",
			}
			vfFilter = fmt.Sprintf("vpp_qsv=w=%d:h=%d", profile.Width, profile.Height)
		} else {
			// Tier 2: CPU decode + CPU scale/pad → h264_qsv encode.
			vfFilter = cpuVF
		}
	default: // SOFTWARE
		vfFilter = cpuVF
	}

	args := buildBaseTranscodeArgs(hwArgs, sourcePath, outputDir, profile, ffmpegEncoder, vfFilter, loudnormFilter, keyInfoFile)

	// Encoder-specific options.
	switch encoder.EncoderType {
	case hardware.EncoderNVENC:
		args = insertAfter(args, ffmpegEncoder, "-gpu", strconv.Itoa(encoder.DeviceIndex), "-preset", profile.Preset, "-rc", "vbr")
	case hardware.EncoderAMF:
		args = insertAfter(args, ffmpegEncoder, "-quality", "balanced")
	case hardware.EncoderQSV:
		args = insertAfter(args, ffmpegEncoder, "-preset", profile.Preset)
	default:
		args = insertAfter(args, ffmpegEncoder, "-preset", profile.Preset)
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}
