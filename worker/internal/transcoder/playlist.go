package transcoder

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// mediaPlaylist is the generated media playlist in segment order. URIs are
// preserved for local artifact lookup; errors never include URI/query values.
// TargetDurationTicks may be zero for older timing-only fixtures. Consumers
// computing HLS bandwidth must require it to be positive.
type mediaPlaylist struct {
	Durations           []int
	URIs                []string
	TargetDurationTicks int
}

// decimalDurationTicks accepts an unsigned decimal duration and rounds once to
// microseconds without floating-point precision loss or integer overflow.
func decimalDurationTicks(value string) (int, error) {
	invalid := fmt.Errorf("duration must be a positive decimal representable in microseconds")
	parts := strings.Split(value, ".")
	if len(parts) > 2 || len(parts[0]) == 0 || (len(parts) == 2 && len(parts[1]) == 0) {
		return 0, invalid
	}
	for _, part := range parts {
		for i := range part {
			if part[i] < '0' || part[i] > '9' {
				return 0, invalid
			}
		}
	}
	whole, err := strconv.ParseUint(parts[0], 10, 64)
	maxInt := uint64(^uint(0) >> 1)
	if err != nil || whole > maxInt/dashTimescale {
		return 0, invalid
	}
	frac := 0
	if len(parts) == 2 {
		for i := 0; i < 6; i++ {
			frac *= 10
			if i < len(parts[1]) {
				frac += int(parts[1][i] - '0')
			}
		}
		if len(parts[1]) > 6 && parts[1][6] >= '5' {
			frac++
		}
	}
	ticks := whole*dashTimescale + uint64(frac)
	if ticks == 0 || ticks > maxInt {
		return 0, invalid
	}
	return int(ticks), nil
}

// readMediaPlaylist reads the subset emitted by the current CMAF pipeline.
// Every EXTINF must have exactly one URI, so malformed entries cannot silently
// renumber subsequent segments. Byte ranges and discontinuities require a
// different artifact/timeline model and are rejected explicitly.
func readMediaPlaylist(path string) (mediaPlaylist, error) {
	var playlist mediaPlaylist
	f, err := os.Open(path)
	if err != nil {
		return playlist, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	pending, total, lineNumber := 0, 0, 0
	targetSeen, ended := false, false
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if lineNumber == 1 && line != "#EXTM3U" {
			return mediaPlaylist{}, fmt.Errorf("media playlist must begin with EXTM3U")
		}
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#EXT-X-BYTERANGE") || strings.HasPrefix(line, "#EXT-X-DISCONTINUITY") {
			return mediaPlaylist{}, fmt.Errorf("unsupported media addressing at line %d", lineNumber)
		}
		if strings.HasPrefix(line, "#EXT-X-TARGETDURATION:") {
			value := strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:")
			// TARGETDURATION is an integer number of seconds, not EXTINF's decimal.
			for i := range value {
				if value[i] < '0' || value[i] > '9' {
					return mediaPlaylist{}, fmt.Errorf("invalid target duration at line %d", lineNumber)
				}
			}
			target, parseErr := strconv.ParseUint(value, 10, 64)
			if targetSeen || parseErr != nil || target == 0 || target > uint64(^uint(0)>>1)/dashTimescale {
				return mediaPlaylist{}, fmt.Errorf("invalid target duration at line %d", lineNumber)
			}
			playlist.TargetDurationTicks, targetSeen = int(target*dashTimescale), true
			continue
		}
		if strings.HasPrefix(line, "#EXTINF:") {
			if pending != 0 || ended {
				return mediaPlaylist{}, fmt.Errorf("unpaired duration at line %d", lineNumber)
			}
			value, _, found := strings.Cut(strings.TrimPrefix(line, "#EXTINF:"), ",")
			if !found {
				return mediaPlaylist{}, fmt.Errorf("missing EXTINF separator at line %d", lineNumber)
			}
			pending, err = decimalDurationTicks(value)
			if err != nil {
				return mediaPlaylist{}, fmt.Errorf("invalid EXTINF at line %d: %w", lineNumber, err)
			}
			continue
		}
		if line == "#EXT-X-ENDLIST" {
			if pending != 0 {
				return mediaPlaylist{}, fmt.Errorf("duration without URI at line %d", lineNumber)
			}
			ended = true
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		if pending == 0 || ended {
			return mediaPlaylist{}, fmt.Errorf("URI without duration at line %d", lineNumber)
		}
		if pending > int(^uint(0)>>1)-total {
			return mediaPlaylist{}, fmt.Errorf("playlist duration overflows microseconds at line %d", lineNumber)
		}
		total += pending
		playlist.Durations = append(playlist.Durations, pending)
		playlist.URIs = append(playlist.URIs, line)
		pending = 0
	}
	if err := scanner.Err(); err != nil {
		return mediaPlaylist{}, fmt.Errorf("read media playlist: %w", err)
	}
	if pending != 0 {
		return mediaPlaylist{}, fmt.Errorf("duration without URI at end of playlist")
	}
	if len(playlist.Durations) == 0 {
		return mediaPlaylist{}, fmt.Errorf("media playlist contains no segments")
	}
	return playlist, nil
}

func readPlaylistSegmentDurationsTicks(path string) ([]int, error) {
	playlist, err := readMediaPlaylist(path)
	return playlist.Durations, err
}
