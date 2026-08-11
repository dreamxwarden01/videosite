package transcoder

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// ProbeCodecString extracts the RFC 6381 codec string (e.g. "avc1.64001F") from
// an fMP4 init segment. This is needed for the CMAF master.m3u8 CODECS attribute
// and DASH Representation codecs attribute — both require the full avc1.xxxxxx
// form including profile/constraints/level, not just "avc1".
//
// ffprobe's codec_tag_string gives the fourcc ("avc1"); we synthesize the
// profile/level suffix from stream profile + level. For non-AVC codecs this
// returns the tag string as-is.
func ProbeCodecString(mp4Path string) (string, error) {
	cmd := exec.Command(ffprobePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=codec_tag_string,codec_name,profile,level",
		"-print_format", "json",
		mp4Path,
	)
	out, err := cmd.Output()
	if err != nil {
		if isExecMissing(err) {
			return "", fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return "", fmt.Errorf("ffprobe codec string: %w", err)
	}

	var parsed struct {
		Streams []struct {
			CodecTagString string `json:"codec_tag_string"`
			CodecName      string `json:"codec_name"`
			Profile        string `json:"profile"`
			Level          int    `json:"level"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return "", fmt.Errorf("parse ffprobe codec output: %w", err)
	}
	if len(parsed.Streams) == 0 {
		return "", fmt.Errorf("no video stream in %s", mp4Path)
	}
	s := parsed.Streams[0]

	// For H.264, build the avc1.PPCCLL form expected by HLS/DASH:
	//   PP = profile_idc (hex), CC = profile_compat_flags (hex),
	//   LL = level_idc (hex). ffprobe gives the numeric level as level*10
	//   (e.g. level 3.1 → 31) and the profile by name.
	if s.CodecName == "h264" {
		profileIDC, profileCompat := h264ProfileIDC(s.Profile)
		if profileIDC > 0 {
			return fmt.Sprintf("avc1.%02X%02X%02X", profileIDC, profileCompat, s.Level), nil
		}
		// H.264 with an unrecognized profile name — do NOT return the bare
		// fourcc "avc1". Both the HLS master CODECS attr and the DASH
		// Representation codecs attr require the full avc1.PPCCLL form;
		// Shaka's manifest parser outright rejects bare "avc1" (no profile/
		// level) and stops before any segment is fetched. High@4.0 is the
		// conservative site-wide default and matches every shipped profile.
		return "avc1.640028", nil
	}

	// Fallback: bare fourcc tag — acceptable for non-H.264 codecs where the
	// tag alone is a valid codec string (e.g. "mp4a" variants, "hev1", etc).
	if s.CodecTagString != "" {
		return s.CodecTagString, nil
	}
	return "", fmt.Errorf("could not determine codec string for %s", mp4Path)
}

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
// Returns 0 with an error if the init segment has no audio stream or an
// unparseable rate; the caller falls back to the rate it asked for.
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

// h264ProfileIDC maps ffprobe's human-readable profile name to the
// (profile_idc, profile_compat_flags) bytes used in the avc1 codec string.
// Returns (0, 0) for unknown profiles — callers should fall back.
func h264ProfileIDC(profile string) (idc, compat int) {
	// Strip trailing " Intra" etc.; ffprobe sometimes adds qualifiers.
	p := strings.SplitN(profile, " ", 2)[0]
	switch strings.ToLower(p) {
	case "baseline", "constrained":
		// Constrained Baseline: profile_idc=66, constraint_set1=1
		return 66, 0x40
	case "main":
		// Main: profile_idc=77
		return 77, 0x00
	case "extended":
		return 88, 0x00
	case "high":
		// High: profile_idc=100
		return 100, 0x00
	case "high10":
		return 110, 0x00
	case "high422":
		return 122, 0x00
	case "high444":
		return 244, 0x00
	}
	return 0, 0
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
func ScanGOP(filePath string) (*GOPScan, error) {
	scan := &GOPScan{Source: "moov"}

	times, err := ReadKeyframeTimes(filePath)
	if err != nil {
		if !errors.Is(err, ErrNoMP4Index) {
			return nil, err
		}
		scan.Source = "ffprobe"
		times, err = probeKeyframeTimesFFprobe(filePath)
		if err != nil {
			return nil, err
		}
	}
	scan.IDRTimes = times

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
	cmd := exec.Command(ffprobePath,
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "packet=pts_time,flags",
		"-of", "csv=p=0",
		filePath,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ffprobe gop scan pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		if isExecMissing(err) {
			return nil, fmt.Errorf("%w: %v", ErrFFmpegMissing, err)
		}
		return nil, fmt.Errorf("ffprobe gop scan: %w", err)
	}

	// Each line is "<pts_time>,<flags>"; ffprobe marks keyframes by setting the
	// first character of flags to 'K' (e.g. "K_" or "K__"). A packet with no
	// timestamp prints "N/A" and is skipped.
	var idrTimes []float64
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		comma := strings.IndexByte(line, ',')
		if comma < 0 || comma+1 >= len(line) || line[comma+1] != 'K' {
			continue
		}
		t, ferr := strconv.ParseFloat(line[:comma], 64)
		if ferr != nil {
			continue
		}
		idrTimes = append(idrTimes, t)
	}
	scanErr := sc.Err()
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("ffprobe gop scan: %w", err)
	}
	if scanErr != nil {
		return nil, fmt.Errorf("read ffprobe packets: %w", scanErr)
	}
	return idrTimes, nil
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
// 0 means unknown (no audio, or an unparseable rate), and the caller falls
// back to defaultAudioSampleRate.
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
	AudioCodec       string
	AudioStreamCount int
	AudioSampleRate  int
}

// ffprobeOutput holds the raw ffprobe JSON output.
type ffprobeOutput struct {
	Streams []ffprobeStream `json:"streams"`
	Format  ffprobeFormat   `json:"format"`
}

type ffprobeStream struct {
	CodecType  string `json:"codec_type"`
	CodecName  string `json:"codec_name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	RFrameRate string `json:"r_frame_rate"`
	BitRate    string `json:"bit_rate"`
	SampleRate string `json:"sample_rate"`
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

	var probe ffprobeOutput
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}

	result := &ProbeResult{}

	// Find video stream
	for _, s := range probe.Streams {
		if s.CodecType == "video" {
			result.Width = s.Width
			result.Height = s.Height
			result.Codec = s.CodecName

			if s.BitRate != "" {
				if br, err := strconv.Atoi(s.BitRate); err == nil {
					result.VideoBitrateKbps = br / 1000
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
