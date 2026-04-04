package worker

import (
	"fmt"
	"videosite-worker/internal/config"
)

// platformRegistrationMeta returns platform-specific metadata for the worker startup log.
func platformRegistrationMeta() map[string]string {
	caps := config.GetCapabilities()
	if caps != nil && caps.ChipModel != "" {
		return map[string]string{
			"chip": fmt.Sprintf("%s (%s)", caps.ChipModel, caps.ChipTier),
		}
	}
	return map[string]string{"chip": "unknown"}
}
