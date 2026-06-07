package transcoder

import (
	"fmt"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// applyEncoderOpts injects encoder-specific FFmpeg flags (preset, RC mode,
// quality tuning) immediately after the -c:v value. Platform-specific because
// the set of encoders differs (VT only on darwin).
func applyEncoderOpts(args []string, encoder config.Encoder, ffmpegEncoder string, profile config.OutputProfile) []string {
	switch encoder.EncoderType {
	case hardware.EncoderVT:
		// No -preset for VideoToolbox.
		return args
	default:
		return insertAfter(args, ffmpegEncoder, "-preset", profile.Preset)
	}
}

// resolveHWArgs returns (hwArgs, vfFilter) for the chosen encoder and decode
// tier on macOS.
//
// hwArgs contains FFmpeg global-input flags (-hwaccel …) injected before -i;
// vfFilter is the value passed to -vf and handles scaling to the pre-computed
// output dims. No padding — the caller (TranscodeVideo) has already computed
// outW/outH to preserve the source aspect ratio inside the target bounding box.
func resolveHWArgs(encoder config.Encoder, swDecode bool, outW, outH int) (hwArgs []string, vfFilter string) {
	cpuVF := fmt.Sprintf("scale=%d:%d", outW, outH)

	switch encoder.EncoderType {
	case hardware.EncoderVT:
		if hardware.VTHWDecodeSupported() && hardware.ScaleVTSupported() && !swDecode {
			// Tier 1: VT hw decode → scale_vt → VT hw encode, fully on the
			// Media Engine. outW/outH already preserve aspect so no pad step.
			hwArgs = []string{
				"-hwaccel", "videotoolbox",
				"-hwaccel_output_format", "videotoolbox_vld",
			}
			vfFilter = fmt.Sprintf("scale_vt=%d:%d", outW, outH)
			return
		}
		// Tier 2: CPU decode + CPU scale + VT hw encode.
		vfFilter = cpuVF
	default: // SOFTWARE
		vfFilter = cpuVF
	}
	return
}
