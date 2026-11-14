package transcoder

import (
	"errors"
	"math"
	"math/big"
	"testing"
)

func TestAudioSegmentPlanKnownTargets(t *testing.T) {
	for _, test := range []struct {
		name     string
		target   float64
		rate     int
		frames   int64
		micros   int64
		argument string
	}{
		{"48k nearest", 6, 48000, 281, 5994666, "5.994666"},
		{"48k exact", 6.016, 48000, 282, 6016000, "6.016000"},
		{"44.1k native", 6, 44100, 258, 5990748, "5.990748"},
		{"below one frame", 0.0001, 48000, 1, 21333, "0.021333"},
	} {
		t.Run(test.name, func(t *testing.T) {
			duration := 12_000.0
			if test.frames == 1 {
				duration = 60
			}
			plan, err := NewAudioSegmentPlan(test.target, test.rate, duration)
			if err != nil {
				t.Fatal(err)
			}
			if plan.SampleRate != test.rate || plan.AACFrames != test.frames || plan.SegmentSamples != test.frames*1024 || plan.TargetMicros != test.micros || plan.TargetArgument() != test.argument {
				t.Fatalf("unexpected plan: %+v, argument %q", plan, plan.TargetArgument())
			}
		})
	}
}

func TestAudioSegmentPlanNearestHalfFrame(t *testing.T) {
	for _, test := range []struct {
		target float64
		frames int64
	}{
		{math.Nextafter(2.5, 0), 2},
		{2.5, 3},
		{math.Nextafter(2.5, math.Inf(1)), 3},
	} {
		plan, err := NewAudioSegmentPlan(test.target, 1024, 100)
		if err != nil || plan.AACFrames != test.frames {
			t.Fatalf("target %.18g: got %+v, %v; want %d frames", test.target, plan, err, test.frames)
		}
	}
}

// This is an integer oracle for the first packet reaching FFmpeg's cumulative
// target. It does not use the planner's deficit inequality.
func audioCutIndexOracle(boundary, targetMicros int64, rate int) *big.Int {
	numerator := new(big.Int).Mul(big.NewInt(boundary), big.NewInt(targetMicros))
	numerator.Mul(numerator, big.NewInt(int64(rate)))
	denominator := big.NewInt(1024 * 1_000_000)
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, denominator, remainder)
	if remainder.Sign() != 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	return quotient
}

func TestAudioSegmentPlanAllAACRatesAgainstCutOracle(t *testing.T) {
	// Includes every standard AAC sampling-frequency index, plus unusual rates
	// to ensure the integer proof is not a 44.1/48 kHz special case.
	rates := []int{96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 12345, 65536, 192000}
	for _, rate := range rates {
		for _, target := range []float64{1.0, 5.5, 6.0, 6.016, 7.1} {
			plan, err := NewAudioSegmentPlan(target, rate, 3_600)
			if err != nil {
				t.Fatalf("rate %d target %g: %v", rate, target, err)
			}
			for n := int64(1); n <= plan.BoundaryCount; n++ {
				want := new(big.Int).Mul(big.NewInt(n), big.NewInt(plan.AACFrames))
				if got := audioCutIndexOracle(n, plan.TargetMicros, rate); got.Cmp(want) != 0 {
					t.Fatalf("rate %d target %g boundary %d: cut %s, want %s", rate, target, n, got, want)
				}
			}
		}
	}
}

func TestAudioSegmentPlanAvoidsFirstBoundaryMiss(t *testing.T) {
	plan, err := NewAudioSegmentPlan(6, 48000, 0.001)
	if err != nil {
		t.Fatal(err)
	}
	if got := audioCutIndexOracle(1, plan.TargetMicros, plan.SampleRate); got.Int64() != 281 {
		t.Fatalf("floored target cut %s, want 281", got)
	}
	if got := audioCutIndexOracle(1, 5994667, plan.SampleRate); got.Int64() != 282 {
		t.Fatalf("rounded-up regression fixture cut %s, want 282", got)
	}
	// A clip shorter than one AAC frame still gets a nonempty, conservative
	// validation horizon, including two frames plus an extra boundary.
	if plan.HorizonMicros < 43666 || plan.BoundaryCount != 2 {
		t.Fatalf("short-clip padding missing: %+v", plan)
	}
}

func TestAudioSegmentPlanRejectsCumulativeFrameDeficit(t *testing.T) {
	// At 48 kHz/281 AAC frames, each floored target loses 32000/(48000e6)
	// seconds. Exactly 32000 thresholds lose one complete AAC frame.
	const firstBadBoundary int64 = 32000
	const targetMicros int64 = 5994666
	goodDuration := float64((firstBadBoundary-3)*targetMicros) / 1e6
	plan, err := NewAudioSegmentPlan(6, 48000, goodDuration)
	if err != nil || plan.BoundaryCount >= firstBadBoundary {
		t.Fatalf("safe horizon rejected: %+v, %v", plan, err)
	}
	badDuration := float64(firstBadBoundary*targetMicros) / 1e6
	if _, err := NewAudioSegmentPlan(6, 48000, badDuration); !errors.Is(err, ErrAudioSegmentHorizon) {
		t.Fatalf("unsafe horizon accepted: %v", err)
	}
	want := firstBadBoundary*281 - 1
	if got := audioCutIndexOracle(firstBadBoundary, targetMicros, 48000); got.Int64() != want {
		t.Fatalf("equality must fail: cut %s, want %d", got, want)
	}
	if _, err := NewAudioSegmentPlan(6, 44100, 1_000_000); !errors.Is(err, ErrAudioSegmentHorizon) {
		t.Fatalf("44.1 kHz unsafe horizon accepted: %v", err)
	}
	// An exactly representable target has no cumulative decimal deficit.
	if _, err := NewAudioSegmentPlan(6.016, 48000, 1_000_000_000); err != nil {
		t.Fatalf("exact target should permit long output: %v", err)
	}
}

func TestAudioSegmentPlanRejectsInvalidAndOverflowingInputs(t *testing.T) {
	for _, target := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64} {
		if _, err := NewAudioSegmentPlan(target, 48000, 60); err == nil {
			t.Errorf("accepted target %g", target)
		}
	}
	for _, duration := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1), math.MaxFloat64, 1e13} {
		if _, err := NewAudioSegmentPlan(6, 48000, duration); err == nil {
			t.Errorf("accepted duration %g", duration)
		}
	}
	for _, rate := range []int{0, -1} {
		if _, err := NewAudioSegmentPlan(6, rate, 60); err == nil {
			t.Errorf("accepted sample rate %d", rate)
		}
	}
	if _, err := NewAudioSegmentPlan(math.SmallestNonzeroFloat64, math.MaxInt32, 60); err == nil {
		t.Error("accepted target whose single AAC frame is below one microsecond")
	}
	// The target itself fits int64, but its extra conservative threshold does
	// not; do not hand an overflowing cumulative threshold to FFmpeg.
	if _, err := NewAudioSegmentPlan(9e12, 1024, 9e12); err == nil {
		t.Error("accepted overflowing final threshold")
	}
}
