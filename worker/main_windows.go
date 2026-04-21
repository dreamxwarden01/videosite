//go:build windows

package main

import (
	"fmt"
	"videosite-worker/internal/config"
	"videosite-worker/internal/util"
)

func printPlatformBanner() {
	fmt.Println("VideoSite Transcoding Worker")
	fmt.Println("============================")
	fmt.Println()
}

func printHardwareInfo(caps *config.Capabilities) {
	fmt.Printf("%s Detecting hardware encoders...\n", util.Ts())

	if caps != nil {
		enabledCount := 0
		totalSlots := 0
		for _, enc := range caps.Encoders {
			if enc.Enable {
				enabledCount++
				slots := config.EffectiveConcurrentJobs(enc)
				totalSlots += slots
				fmt.Printf("%s   [%d] %s (%s) — enabled, %d slot(s)\n", util.Ts(), enc.NumberID, enc.Name, enc.EncoderType, slots)
			} else {
				fmt.Printf("%s   [%d] %s (%s) — disabled\n", util.Ts(), enc.NumberID, enc.Name, enc.EncoderType)
			}
		}
		if len(caps.Encoders) == 0 {
			fmt.Printf("%s   No hardware encoders detected — using software encoding (libx264)\n", util.Ts())
		} else {
			fmt.Printf("%s   %d encoder(s) enabled, %d total job slot(s)\n", util.Ts(), enabledCount, totalSlots)
		}
	}
	fmt.Println()
}
