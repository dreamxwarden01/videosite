package slot

// processingPlan returns the weights for the 10–90% "processing" band of
// global progress, in the order the steps execute:
//
//   - If audio normalization is on and the source has an audio stream,
//     index 0 is analyzeLoudness with weight 0.5.
//   - The remaining entries are one per transcode profile, each weight 1.0.
//
// Callers compute each step's global-pct start/end via stepRange. Weighting
// exists so the server-reported pct moves during the analyze pass instead
// of sitting at 10 until the first profile starts.
func processingPlan(profileCount int, normOn bool) []float64 {
	w := make([]float64, 0, profileCount+1)
	if normOn {
		w = append(w, 0.5)
	}
	for i := 0; i < profileCount; i++ {
		w = append(w, 1.0)
	}
	return w
}

// stepRange returns the global-pct [start, end] for step idx within the
// 10–90 band defined by weights. idx out of range collapses to [10, 90]
// so callers that miscount don't produce nonsense percentages.
func stepRange(weights []float64, idx int) (start, end float64) {
	sum := 0.0
	for _, x := range weights {
		sum += x
	}
	if sum <= 0 || idx < 0 || idx >= len(weights) {
		return 10, 90
	}
	running := 0.0
	for i, x := range weights {
		share := x / sum * 80.0
		if i == idx {
			return 10 + running, 10 + running + share
		}
		running += share
	}
	return 10, 90
}

// scaleLocal maps a local 0–100 pct into the [start, end] global-pct slice.
// Clamps the input to [0, 100] so a misbehaving progress source can't
// push the global pct outside its assigned band.
func scaleLocal(start, end float64, localPct int) int {
	if localPct < 0 {
		localPct = 0
	}
	if localPct > 100 {
		localPct = 100
	}
	return int(start + float64(localPct)/100.0*(end-start))
}
