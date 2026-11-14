package transcoder

import (
	"fmt"
	"strings"
)

// Ignore sub-2ms quantization noise. Gradual clock drift gets at most 500ppm
// compensation; gaps of 20ms or more are filled/trimmed on the source timeline.
// Each input uses the common origin, never an independent STARTPTS reset.
const audioClockRepair = "aresample=async=1:min_comp=0.002:min_hard_comp=0.02:max_soft_comp=0.0005:first_pts=0"

// ValidateAudioTranscode rejects invalid rates/windows/plans before analysis
// or parallel video work starts. Encoding rechecks the same pure contract.
func ValidateAudioTranscode(streamCount, sampleRate int, segmentDuration, duration float64) error {
	if _, err := buildAudioFilterGraph(streamCount, sampleRate, "", duration); err != nil {
		return err
	}
	_, err := NewAudioSegmentPlan(segmentDuration, sampleRate, duration)
	return err
}

// FFmpeg's input normalization uses the same file presentation origin for
// every stream. Padding each track to that origin before amix preserves late
// starts; resetting every track's STARTPTS independently would erase them.
// The output rate is the first audio track's native AAC-supported rate. Other
// rates in a mixed input are converted by filter negotiation to that rate.
func buildAudioFilterGraph(streamCount, sampleRate int, loudnormFilter string, duration float64) (string, error) {
	if streamCount < 1 || streamCount > 128 {
		return "", fmt.Errorf("invalid audio stream count")
	}
	if sampleRate <= 0 || AACSampleRate(sampleRate) != sampleRate {
		return "", fmt.Errorf("source audio sample rate is unavailable or unsupported by AAC")
	}
	durationArg, err := audioPresentationDurationArg(duration)
	if err != nil {
		return "", err
	}
	var graph strings.Builder
	for i := 0; i < streamCount; i++ {
		fmt.Fprintf(&graph, "[0:a:%d]%s[clock%d];", i, audioClockRepair, i)
	}
	for i := 0; i < streamCount; i++ {
		fmt.Fprintf(&graph, "[clock%d]", i)
	}
	if streamCount > 1 {
		fmt.Fprintf(&graph, "amix=inputs=%d:normalize=0:duration=longest:dropout_transition=0,", streamCount)
	}
	fmt.Fprintf(&graph, "aformat=sample_rates=%d:channel_layouts=stereo,apad,atrim=end=%s", sampleRate, durationArg)
	if loudnormFilter != "" {
		graph.WriteString("," + loudnormFilter)
	} else if streamCount > 1 {
		// Keep the mix's relative levels while guarding only overload peaks.
		// latency compensates the limiter's lookahead rather than delaying audio.
		graph.WriteString(",alimiter=limit=0.95:level=false:latency=true")
	}
	// Dynamic loudnorm can return a discontinuous EOF timestamp even though
	// its PCM samples are contiguous. Rebuild only the POST-processing clock:
	// real input offsets/gaps/drift already exist in the repaired PCM above.
	// An explicit 1/SR timebase makes N an exact sample counter, avoiding the
	// floating division in N/SR/TB. Bound the final output after native resampling.
	fmt.Fprintf(&graph, ",aresample=%d,asettb=1/%d,asetpts=N,apad,atrim=end=%s[mix]", sampleRate, sampleRate, durationArg)
	return graph.String(), nil
}

func audioPresentationDurationArg(duration float64) (string, error) {
	ticks, err := durationSecondsTicks(duration)
	if err != nil {
		return "", fmt.Errorf("audio presentation duration: %w", err)
	}
	return fmt.Sprintf("%d.%06d", ticks/dashTimescale, ticks%dashTimescale), nil
}
