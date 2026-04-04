package main

import (
	"fmt"
	"videosite-worker/internal/config"
	"videosite-worker/internal/hardware"
	"videosite-worker/internal/util"
)

func printPlatformBanner() {
	fmt.Println("VideoSite Transcoding Worker (macOS)")
	fmt.Println("=====================================")
	fmt.Println()
}

func printHardwareInfo(caps *config.Capabilities) {
	fmt.Printf("%s Detecting hardware capabilities...\n", util.Ts())

	if caps != nil {
		fmt.Printf("%s   Chip: %s (%s)\n", util.Ts(), caps.ChipModel, caps.ChipTier)
		fmt.Printf("%s   Concurrent jobs: %d\n", util.Ts(), caps.ConcurrentJobs)

		for _, enc := range caps.Encoders {
			status := "disabled"
			if enc.Enable {
				status = "enabled"
			}
			fmt.Printf("%s   [%d] %s (%s) — %s\n", util.Ts(), enc.NumberID, enc.Name, enc.EncoderType, status)
		}
		if len(caps.Encoders) == 0 {
			fmt.Printf("%s   No hardware encoders available — using software encoding (libx264)\n", util.Ts())
		}
	}

	vtDecode := hardware.VTHWDecodeSupported()
	scaleVT := hardware.ScaleVTSupported()

	switch {
	case vtDecode && scaleVT:
		fmt.Println("  Tier 1 (full Media Engine): VT hw decode → scale_vt → VT hw encode")
		fmt.Println("    zero CPU frame processing — all video work on the Media Engine")
	case vtDecode:
		fmt.Println("  Tier 1 degraded (scale_vt unavailable): VT hw decode → CPU scale → VT hw encode")
	default:
		fmt.Println("  Tier 1 unavailable: VT hw decode not available")
	}

	if !vtDecode {
		fmt.Println("  Tier 2: CPU decode → CPU scale/pad → VT hw encode")
	} else if !scaleVT {
		fmt.Println("  Tier 2: CPU decode → CPU scale/pad → VT hw encode")
	} else {
		fmt.Println("  Tier 2 fallback: CPU decode → CPU scale/pad → VT hw encode")
	}
	fmt.Println("  Tier 3 fallback: CPU decode → CPU scale/pad → libx264 (software)")
	fmt.Println()
	fmt.Println("NOTE: VideoToolbox runs on the dedicated Media Engine, not the GPU shader")
	fmt.Println("      array. Activity Monitor GPU% shows 0% — this is correct and expected.")
	fmt.Println("      Verify Media Engine activity: sudo powermetrics -s gpu_power -i 1000")
	fmt.Println()
}
