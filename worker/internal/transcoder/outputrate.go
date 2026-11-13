package transcoder

// OutputFrameRate keeps a verified CFR grid. VFR/unknown inputs are normalized
// to their reported average (then nominal, then default) rate before applying
// the profile cap. The encoder explicitly realizes this rational CFR rate.
func OutputFrameRate(probe *ProbeResult, cadence CadenceInfo, limit int) (num, den int, reason string) {
	valid := func(n, d int) bool { return n > 0 && d > 0 && n <= 1_000_000_000 && d <= 1_000_000_000 }
	if cadence.Kind == CadenceCFR && valid(cadence.RateNum, cadence.RateDen) {
		num, den, reason = cadence.RateNum, cadence.RateDen, "verified CFR grid"
	} else if probe != nil && valid(probe.AvgFrameRateNum, probe.AvgFrameRateDen) {
		num, den, reason = probe.AvgFrameRateNum, probe.AvgFrameRateDen, "normalize average rate to CFR"
	} else if probe != nil && valid(probe.FrameRateNum, probe.FrameRateDen) {
		num, den, reason = probe.FrameRateNum, probe.FrameRateDen, "normalize nominal rate to CFR"
	} else {
		num, den, reason = defaultPlanFPSNum, defaultPlanFPSDen, "normalize unknown rate to default CFR"
	}
	if limit > 0 && float64(num)/float64(den) > float64(limit) {
		num, den, reason = limit, 1, "profile CFR cap"
	}
	divisor := gcd(num, den)
	return num / divisor, den / divisor, reason
}
