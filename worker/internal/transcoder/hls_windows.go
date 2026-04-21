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
//
// audioBitrateKbps is the site-wide AAC bitrate injected into the single
// ffmpeg process (TS muxes video and audio together; for CMAF, audio runs
// in a separate ffmpeg invocation — see TranscodeAudioCMAF in cmaf.go).
func TranscodeToHLS(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, audioBitrateKbps int, encoder config.Encoder, duration float64, keyInfoFile string, swDecode bool, logFile string, srcW, srcH int, loudnormFilter string) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	ffmpegEncoder := hardware.FFmpegEncoderName[encoder.EncoderType]
	if ffmpegEncoder == "" {
		ffmpegEncoder = "libx264"
	}

	hwArgs, vfFilter := resolveHWArgs(encoder, swDecode, srcW, srcH, profile.Width, profile.Height)

	args := buildBaseTranscodeArgs(hwArgs, sourcePath, outputDir, profile, audioBitrateKbps, ffmpegEncoder, vfFilter, loudnormFilter, keyInfoFile)

	// Encoder-specific options (shared with CMAF path via applyEncoderOpts).
	args = applyEncoderOpts(args, encoder, ffmpegEncoder, profile)

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
}

// applyEncoderOpts injects encoder-specific FFmpeg flags (preset, RC mode,
// quality tuning) immediately after the -c:v value. Shared between TS
// (TranscodeToHLS) and CMAF (TranscodeVideoCMAF); platform-specific because
// the set of encoders differs (NVENC/AMF/QSV on windows).
func applyEncoderOpts(args []string, encoder config.Encoder, ffmpegEncoder string, profile config.OutputProfile) []string {
	switch encoder.EncoderType {
	case hardware.EncoderNVENC:
		return insertAfter(args, ffmpegEncoder, "-gpu", strconv.Itoa(encoder.DeviceIndex), "-preset", profile.Preset, "-rc", "vbr")
	case hardware.EncoderAMF:
		return insertAfter(args, ffmpegEncoder, "-quality", "balanced")
	case hardware.EncoderQSV:
		return insertAfter(args, ffmpegEncoder, "-preset", profile.Preset)
	default:
		return insertAfter(args, ffmpegEncoder, "-preset", profile.Preset)
	}
}

// resolveHWArgs returns (hwArgs, vfFilter) for the chosen encoder and decode
// tier on Windows. Shared between TS (TranscodeToHLS) and CMAF (cmaf.go).
//
// hwArgs contains FFmpeg global-input flags (-hwaccel … -init_hw_device …)
// injected before -i; vfFilter is the value passed to -vf and handles scaling
// + padding as required by the target profile.
//
// QSV's vpp_qsv cannot pad, so padding sources force tier-2 (CPU scale+pad).
func resolveHWArgs(encoder config.Encoder, swDecode bool, srcW, srcH, tgtW, tgtH int) (hwArgs []string, vfFilter string) {
	cpuVF := fmt.Sprintf(
		"scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
		tgtW, tgtH, tgtW, tgtH,
	)

	switch encoder.EncoderType {
	case hardware.EncoderNVENC:
		if hardware.CUDAHWDecodeSupported() && !swDecode {
			// Full GPU: NVDEC decode → scale_cuda → h264_nvenc, frames never leave GPU.
			hwArgs = []string{
				"-hwaccel", "cuda",
				"-hwaccel_device", strconv.Itoa(encoder.DeviceIndex),
				"-hwaccel_output_format", "cuda",
			}
			vfFilter = fmt.Sprintf("scale_cuda=%d:%d", tgtW, tgtH)
			return
		}
		// Tier 2: CPU decode+scale, GPU encode via h264_nvenc.
		vfFilter = cpuVF
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
			srcW*tgtH != srcH*tgtW

		if !swDecode && !needsPad {
			// Full GPU: QSV decode → vpp_qsv scale → h264_qsv encode.
			hwArgs = []string{
				"-init_hw_device", fmt.Sprintf("qsv=hw:%d", encoder.DeviceIndex),
				"-hwaccel", "qsv",
				"-hwaccel_device", "hw",
				"-hwaccel_output_format", "qsv",
			}
			vfFilter = fmt.Sprintf("vpp_qsv=w=%d:h=%d", tgtW, tgtH)
			return
		}
		// Tier 2: CPU decode + CPU scale/pad → h264_qsv encode.
		vfFilter = cpuVF
	default: // SOFTWARE
		vfFilter = cpuVF
	}
	return
}
