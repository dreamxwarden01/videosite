package transcoder

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
)

// dashMPDTemplate is a MPEG-DASH static VOD manifest using the isoff-live
// profile with per-Representation SegmentTimeline addressing. The file
// layout it references matches the CMAF folder layout produced by
// TranscodeVideoCMAF / TranscodeAudioCMAF:
//
//	{outputDir}/manifest.mpd
//	{outputDir}/video/{rep.Name}/init.mp4
//	{outputDir}/video/{rep.Name}/segment_0000.m4s, 0001.m4s, ...
//	{outputDir}/audio/{AudioName}/init.mp4
//	{outputDir}/audio/{AudioName}/segment_0000.m4s, ...
//
// Why SegmentTimeline and not the shorter SegmentTemplate duration="..."
// form: FFmpeg's HLS muxer decides when to cut a segment based on the
// *encoded* keyframe stream for each rendition. Two renditions with the
// same -hls_time target can legitimately end up one segment apart — a
// different GOP cadence, fps cap, or keyframe landing at a slightly
// different presentation time is enough. A single "duration=N" attribute
// then misleads the DASH player into computing segment count as
// ceil(mediaPresentationDuration / N), which 404s on whichever rendition
// came up short and tears down the player. SegmentTimeline declares the
// exact segment count and per-segment duration for each Representation,
// so players stop requesting where reality stops. The HLS side has
// always agreed with reality (each playlist.m3u8 lists the segments
// FFmpeg actually wrote); this brings DASH to the same footing.
//
// Shaka Player appends ?verify=... to every segment request via the
// existing registerRequestFilter — DASH does NOT use the HLS
// EXT-X-DEFINE mechanism — so this template is deliberately free of any
// HMAC substitution. The audio AdaptationSet is gated by
// {{- if .HasAudio}} so no-audio sources emit a video-only MPD. Shaka
// accepts an MPD with zero audio sets and plays the <video> element
// silently; declaring an audio set whose segments never resolve would
// leave Shaka stuck in the buffering state forever.
const dashMPDTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static"
     mediaPresentationDuration="{{.DurationISO}}"
     minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
{{- range .VideoReps}}
      <Representation id="{{.Name}}" codecs="{{.Codecs}}" bandwidth="{{.Bandwidth}}" width="{{.Width}}" height="{{.Height}}" frameRate="{{.FrameRate}}">
        <SegmentTemplate media="video/{{.Name}}/segment_$Number%04d$.m4s" initialization="video/{{.Name}}/init.mp4" timescale="1000" startNumber="0">
          <SegmentTimeline>
{{- range .Timeline}}
            <S d="{{.Duration}}"{{if gt .Repeat 0}} r="{{.Repeat}}"{{end}}/>
{{- end}}
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
{{- end}}
    </AdaptationSet>
{{- if .HasAudio}}
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="und">
      <Representation id="{{.AudioName}}" codecs="mp4a.40.2" bandwidth="{{.AudioBandwidth}}" audioSamplingRate="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <SegmentTemplate media="audio/{{.AudioName}}/segment_$Number%04d$.m4s" initialization="audio/{{.AudioName}}/init.mp4" timescale="1000" startNumber="0">
          <SegmentTimeline>
{{- range .AudioTimeline}}
            <S d="{{.Duration}}"{{if gt .Repeat 0}} r="{{.Repeat}}"{{end}}/>
{{- end}}
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
{{- end}}
  </Period>
</MPD>
`

// dashSegmentRun is a run-length-encoded entry in a SegmentTimeline.
// Duration is in milliseconds (matches SegmentTemplate timescale="1000").
// Repeat follows the DASH @r semantics — "repeat this many additional
// times" — so Repeat=0 is one segment, Repeat=2 is three segments. We
// only emit @r when > 0 to keep the MPD compact for single-segment tails.
type dashSegmentRun struct {
	Duration int
	Repeat   int
}

// dashVideoRep is the template view of one video Representation.
type dashVideoRep struct {
	Name      string
	Codecs    string
	Bandwidth int // bits/sec
	Width     int
	Height    int
	FrameRate int
	Timeline  []dashSegmentRun
}

// dashTmplContext is the full view passed to the MPD template.
//
// HasAudio gates the audio AdaptationSet in the template (see
// dashMPDTemplate above). When false, AudioName, AudioBandwidth, and
// AudioTimeline are unused — keep them zero-valued.
type dashTmplContext struct {
	DurationISO    string
	VideoReps      []dashVideoRep
	AudioName      string
	AudioBandwidth int
	AudioTimeline  []dashSegmentRun
	HasAudio       bool
}

// WriteDASHManifest renders an MPD into outputDir/manifest.mpd.
//
// variants describe the video renditions (shared with WriteMasterPlaylistCMAF
// so Codecs/FrameRate/Bandwidth stay consistent across the HLS and DASH
// manifests). audioName is the audio folder name under audio/ (e.g.
// "aac_192k"); audioBitrateKbps feeds the DASH bandwidth attribute.
// durationSec is the source duration from ffprobe — used as a cap for
// mediaPresentationDuration. If any rendition's timeline sum falls below
// that cap we take the shortest timeline instead, so the MPD header does
// not advertise a playable range longer than what every rendition can
// actually deliver.
//
// hasAudio MUST match the master.m3u8's hasAudio — the two manifests
// describe the same set of renditions, just in different syntaxes, and
// Shaka / Safari / hls.js will all diverge confusingly if one lists audio
// and the other doesn't.
//
// For every rendition this reads the corresponding playlist.m3u8 (already
// written + HMAC-rewritten by the caller — RewritePlaylistHMAC preserves
// #EXTINF lines verbatim) and extracts per-segment durations into a
// SegmentTimeline. The playlist is the authoritative source: FFmpeg
// decides the exact segment count and durations per rendition, and the
// HLS playlist is the only record that reflects those decisions.
func WriteDASHManifest(outputDir string, variants []Variant, audioName string, audioBitrateKbps int, durationSec float64, hasAudio bool) error {
	reps := make([]dashVideoRep, 0, len(variants))
	// Track the shortest per-rendition timeline so mediaPresentationDuration
	// can be clamped down if any rendition undershoots the ffprobe duration
	// — a player that sees a longer mediaPresentationDuration than the
	// timeline allows may try to present a seek bar past the last segment.
	shortestMs := -1
	for _, v := range variants {
		codecs := v.Codecs
		if codecs == "" {
			codecs = "avc1.640028"
		}
		frameRate := v.FrameRate
		if frameRate <= 0 {
			// Fallback — a missing frameRate attribute is legal but makes
			// some parsers unhappy. Default to 30 which is the plan's
			// site-wide profile default.
			frameRate = 30
		}

		playlistPath := filepath.Join(outputDir, "video", v.Name, "playlist.m3u8")
		durs, err := readPlaylistSegmentDurationsMs(playlistPath)
		if err != nil {
			return fmt.Errorf("read %s playlist for DASH timeline: %w", v.Name, err)
		}
		if len(durs) == 0 {
			return fmt.Errorf("no #EXTINF segments found in %s playlist", v.Name)
		}
		sumMs := 0
		for _, d := range durs {
			sumMs += d
		}
		if shortestMs < 0 || sumMs < shortestMs {
			shortestMs = sumMs
		}

		reps = append(reps, dashVideoRep{
			Name:      v.Name,
			Codecs:    codecs,
			Bandwidth: v.VideoBitrateKbps * 1000,
			Width:     v.Width,
			Height:    v.Height,
			FrameRate: frameRate,
			Timeline:  compressToSegmentRuns(durs),
		})
	}

	var audioRuns []dashSegmentRun
	if hasAudio {
		audioPlaylist := filepath.Join(outputDir, "audio", audioName, "playlist.m3u8")
		durs, err := readPlaylistSegmentDurationsMs(audioPlaylist)
		if err != nil {
			return fmt.Errorf("read audio playlist for DASH timeline: %w", err)
		}
		if len(durs) == 0 {
			return fmt.Errorf("no #EXTINF segments found in audio playlist")
		}
		sumMs := 0
		for _, d := range durs {
			sumMs += d
		}
		if shortestMs < 0 || sumMs < shortestMs {
			shortestMs = sumMs
		}
		audioRuns = compressToSegmentRuns(durs)
	}

	// mediaPresentationDuration should not exceed what every rendition can
	// actually deliver. ffprobe occasionally reports a duration slightly
	// longer than what FFmpeg's HLS muxer emits (e.g. a dangling partial
	// frame the muxer drops); using the shortest timeline here keeps the
	// header honest.
	effectiveDurationSec := durationSec
	if shortestMs > 0 {
		timelineSec := float64(shortestMs) / 1000.0
		if timelineSec < effectiveDurationSec {
			effectiveDurationSec = timelineSec
		}
	}

	ctx := dashTmplContext{
		DurationISO:    formatISODuration(effectiveDurationSec),
		VideoReps:      reps,
		AudioName:      audioName,
		AudioBandwidth: audioBitrateKbps * 1000,
		AudioTimeline:  audioRuns,
		HasAudio:       hasAudio,
	}

	tmpl, err := template.New("mpd").Parse(dashMPDTemplate)
	if err != nil {
		return fmt.Errorf("parse MPD template: %w", err)
	}

	var sb strings.Builder
	if err := tmpl.Execute(&sb, ctx); err != nil {
		return fmt.Errorf("render MPD: %w", err)
	}

	mpdPath := filepath.Join(outputDir, "manifest.mpd")
	return os.WriteFile(mpdPath, []byte(sb.String()), 0644)
}

// readPlaylistSegmentDurationsMs parses an HLS playlist and returns each
// segment's duration in milliseconds, in playlist order. Only #EXTINF
// lines are considered; comments and segment URIs are ignored. The
// HMAC-rewritten playlists produced by RewritePlaylistHMAC preserve
// #EXTINF lines verbatim, so this works regardless of whether the caller
// has already rewritten the playlist for edge verification.
//
// EXTINF format (RFC 8216 §4.4.4.1): "#EXTINF:<duration>,[<title>]". The
// fractional-second form (e.g. "#EXTINF:9.9833,") is the one FFmpeg emits
// for CMAF segments; we round to the nearest millisecond.
func readPlaylistSegmentDurationsMs(playlistPath string) ([]int, error) {
	f, err := os.Open(playlistPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var durs []int
	scanner := bufio.NewScanner(f)
	// Allow long lines: segment URIs can be long after HMAC rewrite adds
	// "?verify={$verify}" tokens, and some muxers emit long titles.
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "#EXTINF:") {
			continue
		}
		rest := strings.TrimPrefix(line, "#EXTINF:")
		// Strip any trailing title after the comma.
		if comma := strings.IndexByte(rest, ','); comma >= 0 {
			rest = rest[:comma]
		}
		rest = strings.TrimSpace(rest)
		secs, parseErr := strconv.ParseFloat(rest, 64)
		if parseErr != nil || secs <= 0 {
			continue
		}
		durs = append(durs, int(math.Round(secs*1000)))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return durs, nil
}

// compressToSegmentRuns run-length-encodes a sequence of per-segment
// durations (in ms) into DASH <S> runs. Consecutive equal durations
// collapse into a single run with Repeat = count - 1 (matching the DASH
// @r semantics). A trailing partial segment — common because FFmpeg
// rarely lands the source duration exactly on a segment boundary — ends
// up as its own run with Repeat = 0.
func compressToSegmentRuns(durs []int) []dashSegmentRun {
	if len(durs) == 0 {
		return nil
	}
	runs := []dashSegmentRun{{Duration: durs[0], Repeat: 0}}
	for i := 1; i < len(durs); i++ {
		last := &runs[len(runs)-1]
		if durs[i] == last.Duration {
			last.Repeat++
		} else {
			runs = append(runs, dashSegmentRun{Duration: durs[i], Repeat: 0})
		}
	}
	return runs
}

// formatISODuration formats a duration in seconds as an ISO-8601 PT spec
// suitable for the MPD mediaPresentationDuration attribute. Handles hours,
// minutes, and fractional seconds; strips zero components (e.g. 63 seconds
// → "PT1M3S", not "PT0H1M3S").
//
// Seconds carry one decimal place of precision — ffprobe reports durations
// like 123.45; rounding down to an integer loses the tail segment's true
// length on short clips.
func formatISODuration(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	hours := int(sec) / 3600
	mins := (int(sec) % 3600) / 60
	secs := sec - float64(hours*3600) - float64(mins*60)

	var sb strings.Builder
	sb.WriteString("PT")
	if hours > 0 {
		fmt.Fprintf(&sb, "%dH", hours)
	}
	if mins > 0 {
		fmt.Fprintf(&sb, "%dM", mins)
	}
	if secs > 0 || (hours == 0 && mins == 0) {
		// Trim trailing zero on fractional part ("PT12S" not "PT12.0S").
		formatted := fmt.Sprintf("%.1f", secs)
		formatted = strings.TrimSuffix(formatted, ".0")
		fmt.Fprintf(&sb, "%sS", formatted)
	}
	return sb.String()
}
