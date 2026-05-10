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
// vfFilter is the value passed to -vf and handles scaling + padding as
// required by the target profile. When scale_vt delivers exact target dims
// vfFilter uses pure GPU filtering; otherwise it scales on GPU and does a
// hwdownload + CPU pad.
func resolveHWArgs(encoder config.Encoder, swDecode bool, srcW, srcH, tgtW, tgtH int) (hwArgs []string, vfFilter string) {
	cpuVF := fmt.Sprintf(
		"scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
		tgtW, tgtH, tgtW, tgtH,
	)

	switch encoder.EncoderType {
	case hardware.EncoderVT:
		if hardware.VTHWDecodeSupported() && hardware.ScaleVTSupported() && !swDecode {
			// Tier 1: VT hw decode → scale_vt → optional pad → VT hw encode.
			scaledW, scaledH := scaleVTDims(srcW, srcH, tgtW, tgtH)
			hwArgs = []string{
				"-hwaccel", "videotoolbox",
				"-hwaccel_output_format", "videotoolbox_vld",
			}
			if scaledW == tgtW && scaledH == tgtH {
				vfFilter = fmt.Sprintf("scale_vt=%d:%d", tgtW, tgtH)
			} else {
				vfFilter = fmt.Sprintf(
					"scale_vt=%d:%d,hwdownload,format=nv12,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
					scaledW, scaledH, tgtW, tgtH,
				)
			}
			return
		}
		// Tier 2: CPU decode + CPU scale/pad + VT hw encode.
		vfFilter = cpuVF
	default: // SOFTWARE
		vfFilter = cpuVF
	}
	return
}

// scaleVTDims computes scale_vt output dimensions preserving source aspect ratio.
func scaleVTDims(srcW, srcH, tgtW, tgtH int) (outW, outH int) {
	if srcW <= 0 || srcH <= 0 {
		return tgtW, tgtH
	}
	if srcW*tgtH > srcH*tgtW {
		outW = tgtW
		outH = srcH * tgtW / srcW
	} else {
		outH = tgtH
		outW = srcW * tgtH / srcH
	}
	outW = outW &^ 1
	outH = outH &^ 1
	if outW > tgtW {
		outW = tgtW &^ 1
	}
	if outH > tgtH {
		outH = tgtH &^ 1
	}
	return
}
