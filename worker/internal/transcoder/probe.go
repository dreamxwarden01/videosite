package transcoder

import (
	"encoding/json"
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
type ProbeResult struct {
	Width            int
	Height           int
	Codec            string
	VideoBitrateKbps int
	DurationSeconds  float64
	FrameRate        float64
	AudioCodec       string
	AudioStreamCount int
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
	BitRate      string `json:"bit_rate"`
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

			// Parse frame rate (e.g., "30/1" or "24000/1001")
			if parts := strings.Split(s.RFrameRate, "/"); len(parts) == 2 {
				num, _ := strconv.ParseFloat(parts[0], 64)
				den, _ := strconv.ParseFloat(parts[1], 64)
				if den > 0 {
					result.FrameRate = num / den
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
