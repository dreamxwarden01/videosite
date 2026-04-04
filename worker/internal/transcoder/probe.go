package transcoder

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// ProbeResult holds the results from probing a source file.
type ProbeResult struct {
	Width           int
	Height          int
	Codec           string
	VideoBitrateKbps int
	DurationSeconds float64
	FrameRate       float64
	AudioCodec      string
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
			result.AudioCodec = s.CodecName
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
