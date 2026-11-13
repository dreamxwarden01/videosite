package transcoder

import (
	"testing"
	"videosite-worker/internal/config"
)

func TestRemuxEligibilityHonorsExactProfileFrameRateCap(t *testing.T) {
	for _, tc := range []struct {
		name      string
		n, d, cap int
		want      bool
	}{
		{"at cap", 30, 1, 30, true},
		{"NTSC below cap", 60000, 1001, 60, true},
		{"slightly above cap", 30005, 1000, 30, false},
		{"integer above cap", 60, 1, 30, false},
		{"low rate below cap", 1, 5, 30, true},
		{"uncapped", 60000, 1001, 0, true},
		// This helper only filters profile compatibility. The job's separate
		// verified-CFR/useSourceGOP gate conservatively rejects unknown cadence;
		// absence of an FPS value here alone preserves the existing contract.
		{"unknown rate handled by cadence gate", 0, 0, 30, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := &ProbeResult{Codec: "h264", Height: 720, VideoBitrateKbps: 1000, FrameRateNum: tc.n, FrameRateDen: tc.d}
			if tc.d > 0 {
				probe.FrameRate = float64(tc.n) / float64(tc.d)
			}
			profile := &config.OutputProfile{Codec: "h264", Height: 720, VideoBitrateKbps: 2000, FpsLimit: tc.cap}
			if got := checkRemuxEligibility(probe, profile); got != tc.want {
				t.Fatalf("remux %d/%d with cap%d=%v want%v", tc.n, tc.d, tc.cap, got, tc.want)
			}
		})
	}
}
