package transcoder

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
)

// ProbeAudioSampleRate reads the sample rate out of a produced audio fMP4 init
// segment.
//
// The DASH manifest has to declare audioSamplingRate, and it has to be the
// rate that was actually encoded — the encoder keeps the source's rate rather
// than forcing a fixed one (see TranscodeAudio), so there is no constant to
// fall back on. Reading it off the artefact is the same approach
// ProbeCodecString takes for the video codec string, and it cannot drift from
// what shipped.
//
// Returns an error if the init has no parseable audio rate. Finalization must
// verify the artifact matches the selected native rate.
func ProbeAudioSampleRate(mp4Path string) (int, error) {
	cmd := exec.Command(ffprobePath,
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=sample_rate",
		"-of", "csv=p=0",
		mp4Path,
	)
	out, err := cmd.Output()
	if err != nil {
		if isExecMissing(err) {
			return 0, fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return 0, fmt.Errorf("ffprobe audio sample rate: %w", err)
	}
	rate, convErr := strconv.Atoi(strings.TrimSpace(string(out)))
	if convErr != nil || rate <= 0 {
		return 0, fmt.Errorf("could not parse sample rate from %s", mp4Path)
	}
	return rate, nil
}

// GOPScan is the result of scanning a source's IDR layout across the WHOLE
// file. The worker uses it to decide whether to adopt the source cadence for
// the job (so every rendition cuts on the same instants, enabling DASH
// SegmentTemplate-without-Timeline) or fall back to the fixed default.
//
// MeanSec is also stashed by the caller so the bitrate-cap logic can boost
// transcoded outputs when the GOP tightens (longer source GOP → tighter target
// GOP needs proportionally more bits to preserve quality).
//
// Source records which path produced the data ("moov" or "ffprobe") purely so
// the decision log says where the numbers came from.
type GOPScan struct {
	IDRTimes  []float64
	Source    string
	MeanSec   float64
	MaxDevSec float64
	Cadence   CadenceInfo
}

// Count returns the number of IDRs found.
func (g *GOPScan) Count() int { return len(g.IDRTimes) }

// ScanGOP measures the source's inter-IDR intervals over the entire file.
//
// Scanning the whole file rather than a leading window matters because a
// source can look perfectly constant at the head and drift later: a 3.4h
// 59.94fps lecture measured 0.001s max deviation over its first 120s while
// carrying 22 longer-than-nominal GOPs spread through the rest of the file.
// Those extra frames feed straight into the muxer's cumulative segment
// threshold, so a decision made on the first two minutes is a decision made on
// the wrong data.
//
// The cost is paid on the index, not the payload: ReadKeyframeTimes parses
// only the moov sample tables (2 KB - 4 MB, 5-75 ms on our sources) and we
// fall back to a full ffprobe packet scan (0.35-4.3 s on the same files) only
// for containers with no usable index.
//
// Sources with fewer than 3 IDRs are "indeterminate" — the caller falls back
// to the default GOP. Same for the ffprobe-missing case.
func ScanGOP(filePath string, hints ...*ProbeResult) (*GOPScan, error) {
	var hint *ProbeResult
	if len(hints) > 0 {
		hint = hints[0]
	}
	scan := &GOPScan{Source: "moov"}

	times, cadence, err := readSourceIndex(filePath, hint)
	if err != nil {
		if !errors.Is(err, ErrNoMP4Index) {
			return nil, err
		}
		scan.Source = "ffprobe"
		if hint == nil {
			hint, _ = Probe(filePath)
		}
		times, cadence, err = probeSourceTimelineFFprobe(filePath, hint)
		if err != nil {
			return nil, err
		}
	}
	scan.IDRTimes = times
	scan.Cadence = cadence

	if len(times) < 3 {
		return scan, nil
	}

	// Inter-IDR intervals, from the second IDR onward (the first is usually at
	// t=0 and contributes no interval).
	var sum float64
	for i := 1; i < len(times); i++ {
		sum += times[i] - times[i-1]
	}
	scan.MeanSec = sum / float64(len(times)-1)

	// Max deviation (not stddev) — easier to reason about against the
	// tolerance the caller compares to.
	for i := 1; i < len(times); i++ {
		dev := times[i] - times[i-1] - scan.MeanSec
		if dev < 0 {
			dev = -dev
		}
		if dev > scan.MaxDevSec {
			scan.MaxDevSec = dev
		}
	}
	return scan, nil
}

// probeKeyframeTimesFFprobe is the fallback keyframe scan for containers with
// no usable moov index (MKV, MPEG-TS, fragmented MP4). It walks packet headers
// without decoding, so it is I/O bound rather than CPU bound — roughly 1 GB/s
// on a warm page cache.
//
// Deliberately NOT -skip_frame nokey: that decodes every keyframe and measured
// 7x slower than reading every packet header on the same file.
//
// Output is streamed as CSV rather than buffered as JSON. This scan now covers
// the whole file, and a 3-hour 60fps source is on the order of 700k packets —
// enough that collecting the entire output and then unmarshalling it would
// cost a couple of hundred MB per job, multiplied by the number of concurrent
// slots. Only the keyframe timestamps are retained.
func probeKeyframeTimesFFprobe(filePath string) ([]float64, error) {
	times, _, err := probeSourceTimelineFFprobe(filePath, nil)
	return times, err
}

func probeSourceTimelineFFprobe(filePath string, hints *ProbeResult) ([]float64, CadenceInfo, error) {
	cmd := exec.Command(ffprobePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "packet=pts,pts_time,flags",
		"-of", "csv=p=0",
		filePath,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, CadenceInfo{}, fmt.Errorf("ffprobe gop scan pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		if isExecMissing(err) {
			return nil, CadenceInfo{}, fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return nil, CadenceInfo{}, fmt.Errorf("ffprobe gop scan: %w", err)
	}

	// Each line is "<pts>,<pts_time>,<flags>"; ffprobe marks keyframes by setting the
	// first character of flags to 'K' (e.g. "K_" or "K__"). A packet with no
	// timestamp prints "N/A" and is skipped.
	var idrTimes []float64
	scale, tick := int64(1_000_000), int64(1)
	if hints != nil && hints.TimeBaseNum > 0 && hints.TimeBaseDen > 0 {
		scale = int64(hints.TimeBaseDen)
		tick = int64(hints.TimeBaseNum)
	}
	var pts []int64
	var count int64
	incomplete := false
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		columns := strings.Split(sc.Text(), ",")
		if len(columns) < 3 {
			incomplete = true
			continue
		}
		count++
		t, ferr := strconv.ParseFloat(columns[1], 64)
		if ferr != nil || math.IsNaN(t) || math.IsInf(t, 0) {
			incomplete = true
			continue
		}
		if len(columns[2]) > 0 && columns[2][0] == 'K' {
			idrTimes = append(idrTimes, t)
		}
		if count <= cadenceFrameCap {
			// Integer pts preserves the container clock exactly; pts_time is
			// decimal text rounded by ffprobe and cannot prove nanosecond grids.
			if hints == nil || hints.TimeBaseNum <= 0 || hints.TimeBaseDen <= 0 {
				incomplete = true
				continue
			}
			raw, e := strconv.ParseInt(columns[0], 10, 64)
			if e != nil || raw > math.MaxInt64/tick || raw < math.MinInt64/tick {
				incomplete = true
				continue
			}
			pts = append(pts, raw*tick)
		}
	}
	scanErr := sc.Err()
	if scanErr != nil {
		_ = cmd.Process.Kill()
	}
	if err := cmd.Wait(); err != nil {
		return nil, CadenceInfo{}, fmt.Errorf("ffprobe gop scan: %w", err)
	}
	if scanErr != nil {
		return nil, CadenceInfo{}, fmt.Errorf("read ffprobe packets: %w", scanErr)
	}
	cadence := unknownCadence(count, "missing packet timestamps or cadence memory cap exceeded")
	if !incomplete && count <= cadenceFrameCap {
		cadence = cadenceFromPTSWithTick(pts, scale, tick, hints)
	}
	return idrTimes, cadence, nil
}

// ProbeResult holds the results from probing a source file.
//
// AudioCodec is the codec of the **first** audio stream (track 0) — not the
// last, which is what earlier code captured by overwriting in a loop.
// Consistent with `-map 0:a:0` (single-track path) and amix input ordering
// (multi-track path), where stream 0 is what we actually consume.
//
// AudioStreamCount is the total number of audio streams in the source. Used
// to (a) skip the audio pipeline entirely when 0, and (b) decide whether to
// emit an amix filter chain (≥ 2).
//
// AudioSampleRate is the rate of the first audio stream. The audio encoder
// keeps this rate rather than resampling to a fixed one — see TranscodeAudio.
// 0 means unknown; audio processing rejects unknown or unsupported native rates
// rather than silently resampling.
//
// FrameRateNum/FrameRateDen carry the source frame rate as the exact rational
// ffprobe reported (e.g. 24000/1001), not just its float quotient. Segment and
// GOP lengths are decided in whole frames and converted back to time with this
// rational, so NTSC rates land on exact values instead of accumulating the
// rounding error a float carries.
type ProbeResult struct {
	Width            int
	Height           int
	Codec            string
	VideoBitrateKbps int
	DurationSeconds  float64
	FrameRate        float64
	FrameRateNum     int
	FrameRateDen     int
	AvgFrameRateNum  int
	AvgFrameRateDen  int
	TimeBaseNum      int
	TimeBaseDen      int
	AudioCodec       string
	AudioStreamCount int
	AudioSampleRate  int
	// AudioBitrateBps sums positive audio-stream bit_rate metadata only.
	// Zero means absent/incomplete/invalid metadata and requires measurement
	// before using a source bitrate ceiling. It never uses format.bit_rate.
	AudioBitrateBps int64
}

// ffprobeOutput holds the raw ffprobe JSON output.
type ffprobeOutput struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	CodecType    string `json:"codec_type"`
	CodecName    string `json:"codec_name"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	RFrameRate   string `json:"r_frame_rate"`
	AvgFrameRate string `json:"avg_frame_rate"`
	TimeBase     string `json:"time_base"`
	BitRate      string `json:"bit_rate"`
	SampleRate   string `json:"sample_rate"`
}

type ffprobeFormat struct {
	Duration string `json:"duration"`
	BitRate  string `json:"bit_rate"`
}

// Probe runs ffprobe on a source file and returns its properties.
func Probe(filePath string) (*ProbeResult, error) {
	cmd := exec.Command(ffprobePath,
		"-v", "quiet",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		filePath,
	)

	out, err := cmd.Output()
	if err != nil {
		if isExecMissing(err) {
			return nil, fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return nil, fmt.Errorf("ffprobe failed: %w", err)
	}
	return parseProbeOutput(out, filePath)
}

func parseProbeOutput(out []byte, filePath string) (*ProbeResult, error) {
	var probe ffprobeOutput
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}

	result := &ProbeResult{}

	// Find video stream
	videoSeen := false
	audioBitrateKnown := true
	for _, s := range probe.Streams {
		if s.CodecType == "video" && !videoSeen {
			videoSeen = true
			result.Width = s.Width
			result.Height = s.Height
			result.Codec = s.CodecName

			if s.BitRate != "" {
				if br, err := strconv.Atoi(s.BitRate); err == nil {
					result.VideoBitrateKbps = br / 1000
				}
			}

			if parts := strings.Split(s.TimeBase, "/"); len(parts) == 2 {
				num, en := strconv.Atoi(parts[0])
				den, ed := strconv.Atoi(parts[1])
				if en == nil && ed == nil && num > 0 && den > 0 {
					result.TimeBaseNum = num
					result.TimeBaseDen = den
				}
			}
			if parts := strings.Split(s.AvgFrameRate, "/"); len(parts) == 2 {
				num, en := strconv.Atoi(parts[0])
				den, ed := strconv.Atoi(parts[1])
				if en == nil && ed == nil && num > 0 && den > 0 {
					result.AvgFrameRateNum = num
					result.AvgFrameRateDen = den
				}
			}
			// Parse frame rate (e.g., "30/1" or "24000/1001"). Both the exact
			// rational and its float quotient are kept: the rational drives
			// frame-count segment maths, the float stays for the existing
			// comparisons (fps caps, remux eligibility).
			//
			// The float is parsed independently of the integer pair so an
			// unexpected non-integer numerator still yields a usable rate for
			// the comparisons rather than zeroing the frame rate outright.
			if parts := strings.Split(s.RFrameRate, "/"); len(parts) == 2 {
				fnum, errN := strconv.ParseFloat(parts[0], 64)
				fden, errD := strconv.ParseFloat(parts[1], 64)
				if errN == nil && errD == nil && fden > 0 {
					result.FrameRate = fnum / fden
				}
				num, errN := strconv.Atoi(parts[0])
				den, errD := strconv.Atoi(parts[1])
				if errN == nil && errD == nil && num > 0 && den > 0 {
					result.FrameRateNum = num
					result.FrameRateDen = den
				}
			}
		}
		if s.CodecType == "audio" {
			br, err := strconv.ParseInt(s.BitRate, 10, 64)
			if err != nil || br <= 0 || br > math.MaxInt64-result.AudioBitrateBps {
				audioBitrateKnown = false
			} else if audioBitrateKnown {
				result.AudioBitrateBps += br
			}
			// AudioCodec must reflect the first audio stream (track 0) — it's
			// the one we -map in the single-track path and it's the first
			// input into amix in the multi-track path. Previous code
			// overwrote on each iteration and kept the last stream's codec,
			// which silently disagreed with what we actually encoded.
			if result.AudioStreamCount == 0 {
				result.AudioCodec = s.CodecName
				if sr, err := strconv.Atoi(s.SampleRate); err == nil && sr > 0 {
					result.AudioSampleRate = sr
				}
			}
			result.AudioStreamCount++
		}
	}
	if !audioBitrateKnown {
		result.AudioBitrateBps = 0
	}

	// Parse duration
	if probe.Format.Duration != "" {
		if dur, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
			result.DurationSeconds = dur
		}
	}

	// Fallback: use format bitrate if video bitrate not available
	if result.VideoBitrateKbps == 0 && probe.Format.BitRate != "" {
		if br, err := strconv.Atoi(probe.Format.BitRate); err == nil {
			result.VideoBitrateKbps = br / 1000
		}
	}

	if result.Width == 0 || result.Height == 0 {
		return nil, fmt.Errorf("no video stream found in %s", filePath)
	}

	return result, nil
}
