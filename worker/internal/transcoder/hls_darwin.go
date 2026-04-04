package transcoder

import (
	"context"
	"fmt"
	"os"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
)

// TranscodeToHLS transcodes a source file to HLS for a given profile.
//
// Hardware acceleration strategy (three tiers, tried in order):
//
//  1. VideoToolbox full-HW decode+encode:
//     -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld
//     → scale_vt (Media Engine) → optional hwdownload+pad for non-16:9
//     → h264_videotoolbox hardware encode.
//
//  2. VT encode-only: CPU decode + CPU scale/pad → h264_videotoolbox.
//
//  3. Full software: CPU decode + CPU scale/pad → libx264.
//
// swDecode=true → skip VideoToolbox hardware decode (tier-2 path).
func TranscodeToHLS(ctx context.Context, sourcePath, outputDir string, profile config.OutputProfile, encoder config.Encoder, duration float64, keyInfoFile string, swDecode bool, logFile string, srcW, srcH int, loudnormFilter string) (<-chan int, <-chan error) {
	os.MkdirAll(outputDir, 0755)

	ffmpegEncoder := hardware.FFmpegEncoderName[encoder.EncoderType]
	if ffmpegEncoder == "" {
		ffmpegEncoder = "libx264"
	}

	// CPU scale+pad filter used by tiers 2 and 3.
	cpuVF := fmt.Sprintf(
		"scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
		profile.Width, profile.Height, profile.Width, profile.Height,
	)

	var hwArgs []string
	var vfFilter string

	switch encoder.EncoderType {
	case hardware.EncoderVT:
		if hardware.VTHWDecodeSupported() && hardware.ScaleVTSupported() && !swDecode {
			// Tier 1: VT hw decode → scale_vt → optional pad → VT hw encode.
			scaledW, scaledH := scaleVTDims(srcW, srcH, profile.Width, profile.Height)
			hwArgs = []string{
				"-hwaccel", "videotoolbox",
				"-hwaccel_output_format", "videotoolbox_vld",
			}
			if scaledW == profile.Width && scaledH == profile.Height {
				vfFilter = fmt.Sprintf("scale_vt=%d:%d", profile.Width, profile.Height)
			} else {
				vfFilter = fmt.Sprintf(
					"scale_vt=%d:%d,hwdownload,format=nv12,pad=%d:%d:(ow-iw)/2:(oh-ih)/2",
					scaledW, scaledH, profile.Width, profile.Height,
				)
			}
		} else {
			// Tier 2: CPU decode + CPU scale/pad + VT hw encode.
			vfFilter = cpuVF
		}
	default: // SOFTWARE
		vfFilter = cpuVF
	}

	args := buildBaseTranscodeArgs(hwArgs, sourcePath, outputDir, profile, ffmpegEncoder, vfFilter, loudnormFilter, keyInfoFile)

	// Encoder-specific options.
	switch encoder.EncoderType {
	case hardware.EncoderVT:
		// No -preset for VideoToolbox.
	default:
		args = insertAfter(args, ffmpegEncoder, "-preset", profile.Preset)
	}

	return RunFFmpegWithProgress(ctx, duration, logFile, args...)
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
