package transcoder

import (
	"math"
	"testing"
)

func TestAudioTargetUsesConfiguredQualityBudget(t *testing.T) {
	for _, kbps := range []int{128, 192, 320} {
		got, err := AudioTargetBitrate(kbps)
		if err != nil || got != int64(kbps)*1000 {
			t.Fatalf("%d: %d %v", kbps, got, err)
		}
	}
	for _, kbps := range []int{0, -1, math.MaxInt} {
		if _, err := AudioTargetBitrate(kbps); err == nil {
			t.Fatalf("invalid %d accepted", kbps)
		}
	}
}
