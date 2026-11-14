package transcoder

import (
	"errors"
	"fmt"
	"math"
	"math/big"
)

const aacFrameSamples int64 = 1024
const audioMicrosPerSecond int64 = 1_000_000

// ErrAudioSegmentHorizon means the rounded HLS target cannot preserve the
// selected AAC frame count for the whole output. The caller must reject the
// plan or explicitly choose another target before starting FFmpeg.
var ErrAudioSegmentHorizon = errors.New("audio segment target loses AAC alignment within output horizon")

// AudioSegmentPlan describes AAC-LC segments on a continuous sample clock.
// TargetMicros is the exact integer argument for FFmpeg's HLS muxer; the actual
// complete segment duration is SegmentSamples/SampleRate seconds. This plan
// does not repair input timestamps, establish the common A/V epoch, or describe
// the final partial AAC packet.
type AudioSegmentPlan struct {
	AACFrames      int64
	SegmentSamples int64
	SampleRate     int
	TargetMicros   int64

	// HorizonMicros covers the video duration plus two AAC frames for encoder
	// delay/tail handling. BoundaryCount also includes one additional boundary.
	HorizonMicros int64
	BoundaryCount int64
}

// TargetArgument formats the integer microsecond target without float rounding.
func (p AudioSegmentPlan) TargetArgument() string {
	return fmt.Sprintf("%d.%06d", p.TargetMicros/audioMicrosPerSecond, p.TargetMicros%audioMicrosPerSecond)
}

// NewAudioSegmentPlan selects the nearest positive integer AAC frame count
// (halfway rounds upward), retaining the requested output sample rate. It floors
// the exact rational segment duration to integer microseconds, then proves that
// every cumulative threshold through the finite output horizon still cuts at
// that frame count. It never silently changes the frame count to pass the proof.
//
// The proof assumes contiguous, full 1024-sample AAC frames up to the final
// packet and a correctly established muxer epoch. Timestamp compensation and
// offset preservation remain the responsibility of the audio filter graph.
func NewAudioSegmentPlan(targetSec float64, sampleRate int, durationSec float64) (AudioSegmentPlan, error) {
	var plan AudioSegmentPlan
	if !positiveFiniteAudioSeconds(targetSec) || !positiveFiniteAudioSeconds(durationSec) {
		return plan, fmt.Errorf("audio segment target and output duration must be finite and positive")
	}
	// FFmpeg sample rates are signed 32-bit integers. A positive integer rate is
	// accepted here; codec-specific supported-rate validation belongs upstream.
	if sampleRate <= 0 || int64(sampleRate) > math.MaxInt32 {
		return plan, fmt.Errorf("audio sample rate must be between 1 and %d", int64(math.MaxInt32))
	}

	// Convert the supplied float exactly, rather than adding a floating epsilon
	// near a half-frame boundary or flooring an already rounded decimal string.
	framesRat := new(big.Rat).SetFloat64(targetSec)
	framesRat.Mul(framesRat, new(big.Rat).SetFrac64(int64(sampleRate), aacFrameSamples))
	frames := new(big.Int)
	remainder := new(big.Int)
	frames.QuoRem(framesRat.Num(), framesRat.Denom(), remainder)
	if new(big.Int).Lsh(remainder, 1).Cmp(framesRat.Denom()) >= 0 {
		frames.Add(frames, big.NewInt(1))
	}
	if frames.Sign() == 0 {
		frames.SetInt64(1)
	}
	samples := new(big.Int).Mul(frames, big.NewInt(aacFrameSamples))
	segmentNumerator := new(big.Int).Mul(samples, big.NewInt(audioMicrosPerSecond))
	targetMicros, deficit := new(big.Int), new(big.Int)
	targetMicros.QuoRem(segmentNumerator, big.NewInt(int64(sampleRate)), deficit)
	if !frames.IsInt64() || !samples.IsInt64() || !targetMicros.IsInt64() || targetMicros.Sign() <= 0 {
		return plan, fmt.Errorf("audio segment target exceeds integer timing bounds or is below one microsecond")
	}

	durationMicros := new(big.Rat).SetFloat64(durationSec)
	durationMicros.Mul(durationMicros, new(big.Rat).SetInt64(audioMicrosPerSecond))
	// Include encoder delay/tail margin without assuming a full-sized final AAC
	// packet. Round the padded horizon upward, never inward.
	durationMicros.Add(durationMicros, new(big.Rat).SetFrac64(2*aacFrameSamples*audioMicrosPerSecond, int64(sampleRate)))
	horizon := ceilPositiveAudioRatio(durationMicros.Num(), durationMicros.Denom())
	boundaries := ceilPositiveAudioRatio(horizon, targetMicros)
	boundaries.Add(boundaries, big.NewInt(1))
	lastThreshold := new(big.Int).Mul(boundaries, targetMicros)
	if !horizon.IsInt64() || !boundaries.IsInt64() || !lastThreshold.IsInt64() {
		return plan, fmt.Errorf("audio output horizon exceeds integer timing bounds")
	}

	// At boundary n, flooring loses n*deficit/(SR*1e6) seconds.
	// ceil(n*TargetMicros*SR/(1024*1e6)) equals n*AACFrames iff
	// n*deficit < 1024*1e6. Equality would already cut one frame early.
	accumulatedDeficit := new(big.Int).Mul(boundaries, deficit)
	if accumulatedDeficit.Cmp(big.NewInt(aacFrameSamples*audioMicrosPerSecond)) >= 0 {
		return plan, fmt.Errorf("%w: %d Hz, %s AAC frames, %s boundaries", ErrAudioSegmentHorizon, sampleRate, frames.String(), boundaries.String())
	}

	return AudioSegmentPlan{
		AACFrames: frames.Int64(), SegmentSamples: samples.Int64(), SampleRate: sampleRate,
		TargetMicros: targetMicros.Int64(), HorizonMicros: horizon.Int64(), BoundaryCount: boundaries.Int64(),
	}, nil
}

func positiveFiniteAudioSeconds(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func ceilPositiveAudioRatio(numerator, denominator *big.Int) *big.Int {
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(numerator, denominator, remainder)
	if remainder.Sign() > 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	return quotient
}
