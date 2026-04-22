package transcoder

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

// dashMPDTemplate is a MPEG-DASH static VOD manifest using the isoff-live
// profile + SegmentTemplate addressing. The file layout it references matches
// the CMAF folder layout produced by TranscodeVideoCMAF / TranscodeAudioCMAF:
//
//	{outputDir}/manifest.mpd
//	{outputDir}/video/{rep.Name}/init.mp4
//	{outputDir}/video/{rep.Name}/segment_0000.m4s, 0001.m4s, ...
//	{outputDir}/audio/{AudioName}/init.mp4
//	{outputDir}/audio/{AudioName}/segment_0000.m4s, ...
//
// Shaka Player appends ?verify=... to every segment request via the existing
// registerRequestFilter — DASH does NOT use the HLS EXT-X-DEFINE mechanism —
// so this template is deliberately free of any HMAC substitution.
// The audio AdaptationSet is gated by {{- if .HasAudio}} so no-audio sources
// emit a video-only MPD. Shaka accepts an MPD with zero audio sets and plays
// the <video> element silently; declaring an audio set whose segments never
// resolve would leave Shaka stuck in the buffering state forever.
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
        <SegmentTemplate media="video/{{.Name}}/segment_$Number%04d$.m4s" initialization="video/{{.Name}}/init.mp4" duration="{{$.SegmentDurationMs}}" timescale="1000" startNumber="0"/>
      </Representation>
{{- end}}
    </AdaptationSet>
{{- if .HasAudio}}
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="und">
      <Representation id="{{.AudioName}}" codecs="mp4a.40.2" bandwidth="{{.AudioBandwidth}}" audioSamplingRate="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <SegmentTemplate media="audio/{{.AudioName}}/segment_$Number%04d$.m4s" initialization="audio/{{.AudioName}}/init.mp4" duration="{{.SegmentDurationMs}}" timescale="1000" startNumber="0"/>
      </Representation>
    </AdaptationSet>
{{- end}}
  </Period>
</MPD>
`

// dashVideoRep is the template view of one video Representation.
type dashVideoRep struct {
	Name      string
	Codecs    string
	Bandwidth int // bits/sec
	Width     int
	Height    int
	FrameRate int
}

// dashTmplContext is the full view passed to the MPD template.
//
// HasAudio gates the audio AdaptationSet in the template (see dashMPDTemplate
// above). When false, AudioName and AudioBandwidth are unused — keep them
// zero-valued.
type dashTmplContext struct {
	DurationISO       string
	SegmentDurationMs int
	VideoReps         []dashVideoRep
	AudioName         string
	AudioBandwidth    int
	HasAudio          bool
}

// WriteDASHManifest renders an MPD into outputDir/manifest.mpd.
//
// variants describe the video renditions (shared with WriteMasterPlaylistCMAF
// so Codecs/FrameRate/Bandwidth stay consistent across the HLS and DASH
// manifests). audioName is the audio folder name under audio/ (e.g.
// "aac_192k"); audioBitrateKbps feeds the DASH bandwidth attribute.
// durationSec is the source duration from ffprobe; segmentDurationSec is the
// same value baked into each per-profile HLS playlist (profiles[0] convention).
//
// hasAudio MUST match the master.m3u8's hasAudio — the two manifests
// describe the same set of renditions, just in different syntaxes, and
// Shaka / Safari / hls.js will all diverge confusingly if one lists audio
// and the other doesn't.
func WriteDASHManifest(outputDir string, variants []CMAFVariant, audioName string, audioBitrateKbps int, durationSec float64, segmentDurationSec int, hasAudio bool) error {
	reps := make([]dashVideoRep, 0, len(variants))
	for _, v := range variants {
		codecs := v.Codecs
		if codecs == "" {
			codecs = "avc1.640028"
		}
		frameRate := v.FrameRate
		if frameRate <= 0 {
			// Fallback — a missing frameRate attribute is legal but makes some
			// parsers unhappy. Default to 30 which is the plan's site-wide
			// profile default.
			frameRate = 30
		}
		reps = append(reps, dashVideoRep{
			Name:      v.Name,
			Codecs:    codecs,
			Bandwidth: v.VideoBitrateKbps * 1000,
			Width:     v.Width,
			Height:    v.Height,
			FrameRate: frameRate,
		})
	}

	ctx := dashTmplContext{
		DurationISO:       formatISODuration(durationSec),
		SegmentDurationMs: segmentDurationSec * 1000,
		VideoReps:         reps,
		AudioName:         audioName,
		AudioBandwidth:    audioBitrateKbps * 1000,
		HasAudio:          hasAudio,
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
