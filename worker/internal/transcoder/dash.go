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
// profile. Both video and audio AdaptationSets use a single per-job
// timescale ({{.Timescale}} = 1000000, so durations are in microseconds);
// each Representation independently chooses between
// SegmentTemplate-with-duration (compact, when its segments are uniform)
// and SegmentTemplate-with-SegmentTimeline (per-segment durations, when
// not). Per ISO/IEC 23009-1 §5.3, AdaptationSets and Representations may
// each carry their own SegmentTemplate addressing.
//
// Why μs timescale: timescale=1000 (ms) loses sub-ms precision per
// segment. For a source like 60000/1001 fps with chosen_seg = 4 × 117/59.94
// = 7.8078078...s, the ms-form rounds to 7808 and accumulates ~0.2ms/seg
// of declared-vs-actual drift; on multi-hour content that's visible as
// scrub-bar jitter. timescale=1000000 reduces the per-segment drift to
// <1 μs, eliminating accumulation under any realistic content length.
//
// Why per-Representation duration: fps-cap downsampling makes the encoder
// snap forced IDRs to the output's frame grid, which differs from the
// source's frame grid. A 60000/1001 source with a 30fps-capped rendition
// produces ~59-frame GOPs (1.9667s) on the cap, vs 117-frame GOPs
// (1.95195s) on the source-fps renditions. Each rendition therefore needs
// its own SegmentTemplate@duration value. The video AdaptationSet omits
// segmentAlignment="true" since renditions may differ at the segment
// boundary level (per-segment switching still works, just not at the
// frame-aligned guarantee).
//
// Why mixed uniform / SegmentTimeline coexists: video renditions can
// be either uniform (steady GOP cadence + integer GOPs per segment) or
// not (fps-cap rounding, source-GOP adopt, etc.). Audio is uniform
// when TranscodeAudio is fed an AAC-frame-aligned -hls_time (every
// segment is exactly N frames at 48 kHz, so the modal equals the
// average). Pre-alignment, the muxer would pick 281 or 282 frames per
// segment to chase a non-aligned 6.0 s target and the run-length
// timeline path was the only honest representation; now the uniform
// path is the common case for audio too. Each rendition decides for
// itself based on its actual playlist EXTINFs.
//
// File layout referenced:
//
//	{outputDir}/manifest.mpd
//	{outputDir}/video/{rep.Name}/init.mp4
//	{outputDir}/video/{rep.Name}/segment_0000.m4s, 0001.m4s, ...
//	{outputDir}/audio/{AudioName}/init.mp4
//	{outputDir}/audio/{AudioName}/segment_0000.m4s, ...
//
// Shaka Player appends ?verify=... to every segment request via the
// existing registerRequestFilter — DASH does NOT use the HLS
// EXT-X-DEFINE mechanism — so this template is deliberately free of any
// HMAC substitution. The audio AdaptationSet is gated by {{if .HasAudio}}
// so no-audio sources emit a video-only MPD.
const dashMPDTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static"
     mediaPresentationDuration="{{.DurationISO}}"
     minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" startWithSAP="1">
{{- range .VideoReps}}
      <Representation id="{{.Name}}" codecs="{{.Codecs}}" bandwidth="{{.Bandwidth}}" width="{{.Width}}" height="{{.Height}}" frameRate="{{.FrameRate}}">
{{- if .Uniform}}
        <SegmentTemplate media="video/{{.Name}}/segment_$Number%04d$.m4s" initialization="video/{{.Name}}/init.mp4" timescale="{{$.Timescale}}" startNumber="0" duration="{{.SegmentDurationTicks}}"/>
{{- else}}
        <SegmentTemplate media="video/{{.Name}}/segment_$Number%04d$.m4s" initialization="video/{{.Name}}/init.mp4" timescale="{{$.Timescale}}" startNumber="0">
          <SegmentTimeline>
{{- range .Timeline}}
            <S d="{{.Duration}}"{{if gt .Repeat 0}} r="{{.Repeat}}"{{end}}/>
{{- end}}
          </SegmentTimeline>
        </SegmentTemplate>
{{- end}}
      </Representation>
{{- end}}
    </AdaptationSet>
{{- if .HasAudio}}
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="und">
      <Representation id="{{.AudioName}}" codecs="mp4a.40.2" bandwidth="{{.AudioBandwidth}}" audioSamplingRate="48000">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
{{- if .AudioUniform}}
        <SegmentTemplate media="audio/{{.AudioName}}/segment_$Number%04d$.m4s" initialization="audio/{{.AudioName}}/init.mp4" timescale="{{$.Timescale}}" startNumber="0" duration="{{.AudioSegmentDurationTicks}}"/>
{{- else}}
        <SegmentTemplate media="audio/{{.AudioName}}/segment_$Number%04d$.m4s" initialization="audio/{{.AudioName}}/init.mp4" timescale="{{$.Timescale}}" startNumber="0">
          <SegmentTimeline>
{{- range .AudioTimeline}}
            <S d="{{.Duration}}"{{if gt .Repeat 0}} r="{{.Repeat}}"{{end}}/>
{{- end}}
          </SegmentTimeline>
        </SegmentTemplate>
{{- end}}
      </Representation>
    </AdaptationSet>
{{- end}}
  </Period>
</MPD>
`

// dashTimescale is the shared per-job MPD timescale: microseconds. See
// dashMPDTemplate docstring for why μs over ms.
const dashTimescale = 1000000

// dashSegmentRun is a run-length-encoded entry in a SegmentTimeline.
// Duration is in dashTimescale ticks (μs).
// Repeat follows the DASH @r semantics — "repeat this many additional
// times" — so Repeat=0 is one segment, Repeat=2 is three segments. We
// only emit @r when > 0 to keep the MPD compact for single-segment tails.
type dashSegmentRun struct {
	Duration int
	Repeat   int
}

// dashVideoRep is the template view of one video Representation. Carries
// both addressing forms; Uniform picks between them at render time. When
// Uniform is true, SegmentDurationTicks is used (in dashTimescale ticks)
// and Timeline is ignored. When false, Timeline is used.
type dashVideoRep struct {
	Name                 string
	Codecs               string
	Bandwidth            int // bits/sec
	Width                int
	Height               int
	FrameRate            int
	Uniform              bool
	SegmentDurationTicks int
	Timeline             []dashSegmentRun
}

// dashTmplContext is the full view passed to dashMPDTemplate.
//
// HasAudio gates the entire audio AdaptationSet. When false, every audio*
// field is unused.
type dashTmplContext struct {
	DurationISO string
	Timescale   int // shared timescale for both AdaptationSets

	VideoReps []dashVideoRep

	HasAudio                  bool
	AudioName                 string
	AudioBandwidth            int
	AudioUniform              bool
	AudioSegmentDurationTicks int              // when AudioUniform
	AudioTimeline             []dashSegmentRun // when !AudioUniform
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
	// Track the shortest per-rendition timeline (in ticks) so
	// mediaPresentationDuration can be clamped down if any rendition
	// undershoots the ffprobe duration — a player that sees a longer
	// mediaPresentationDuration than the timeline allows may try to
	// present a seek bar past the last segment.
	shortestTicks := -1
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
		durs, err := readPlaylistSegmentDurationsTicks(playlistPath)
		if err != nil {
			return fmt.Errorf("read %s playlist for DASH timeline: %w", v.Name, err)
		}
		if len(durs) == 0 {
			return fmt.Errorf("no #EXTINF segments found in %s playlist", v.Name)
		}
		sumTicks := 0
		for _, d := range durs {
			sumTicks += d
		}
		if shortestTicks < 0 || sumTicks < shortestTicks {
			shortestTicks = sumTicks
		}

		modalTicks, uniform := segmentDurationIfUniform(durs)
		rep := dashVideoRep{
			Name:      v.Name,
			Codecs:    codecs,
			Bandwidth: v.VideoBitrateKbps * 1000,
			Width:     v.Width,
			Height:    v.Height,
			FrameRate: frameRate,
			Uniform:   uniform,
		}
		if uniform {
			rep.SegmentDurationTicks = modalTicks
		} else {
			rep.Timeline = compressToSegmentRuns(durs)
		}
		reps = append(reps, rep)
	}

	var audioRuns []dashSegmentRun
	audioUniform := false
	audioSegTicks := 0
	if hasAudio {
		audioPlaylist := filepath.Join(outputDir, "audio", audioName, "playlist.m3u8")
		durs, err := readPlaylistSegmentDurationsTicks(audioPlaylist)
		if err != nil {
			return fmt.Errorf("read audio playlist for DASH timeline: %w", err)
		}
		if len(durs) == 0 {
			return fmt.Errorf("no #EXTINF segments found in audio playlist")
		}
		sumTicks := 0
		for _, d := range durs {
			sumTicks += d
		}
		if shortestTicks < 0 || sumTicks < shortestTicks {
			shortestTicks = sumTicks
		}
		audioSegTicks, audioUniform = segmentDurationIfUniform(durs)
		if !audioUniform {
			audioRuns = compressToSegmentRuns(durs)
		}
	}

	// mediaPresentationDuration should not exceed what every rendition can
	// actually deliver. ffprobe occasionally reports a duration slightly
	// longer than what FFmpeg's HLS muxer emits (e.g. a dangling partial
	// frame the muxer drops); using the shortest timeline here keeps the
	// header honest.
	effectiveDurationSec := durationSec
	if shortestTicks > 0 {
		timelineSec := float64(shortestTicks) / float64(dashTimescale)
		if timelineSec < effectiveDurationSec {
			effectiveDurationSec = timelineSec
		}
	}

	ctx := dashTmplContext{
		DurationISO:               formatISODuration(effectiveDurationSec),
		Timescale:                 dashTimescale,
		VideoReps:                 reps,
		HasAudio:                  hasAudio,
		AudioName:                 audioName,
		AudioBandwidth:            audioBitrateKbps * 1000,
		AudioUniform:              audioUniform,
		AudioSegmentDurationTicks: audioSegTicks,
		AudioTimeline:             audioRuns,
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

// dashUniformToleranceTicks is the per-segment deviation budget for
// declaring a Representation "uniform-duration", in dashTimescale ticks
// (μs). 100ms = 100000 μs covers fractional-fps drift (23.976fps + 2s GOP →
// real 2.002s) and ffmpeg muxer rounding while staying well under typical
// ABR switching granularity. Matches gopToleranceSec in slot/job.go.
const dashUniformToleranceTicks = 100 * 1000 // 100ms in μs

// segmentDurationIfUniform returns (modalTicks, true) when the given
// segment-duration sequence (excluding the trailing partial) is uniform
// within ±dashUniformToleranceTicks of its modal value, else (0, false).
// Used for both video and audio renditions — each gets its own uniformity
// verdict so fps-cap and AAC quirks can be handled independently.
func segmentDurationIfUniform(durs []int) (int, bool) {
	// Need at least 2 segments to make sense of "ignore the last" — for
	// very short videos with a single segment, skip uniformity and take
	// the SegmentTimeline path so the manifest is honest about what the
	// muxer emitted.
	if len(durs) < 2 {
		return 0, false
	}
	// Modal value over all-but-last. AAC quantization typically produces
	// one of two adjacent durations; fps-cap renditions produce a single
	// value with ±1 frame jitter. Either way, mode + tolerance handles it.
	counts := make(map[int]int)
	for i := 0; i < len(durs)-1; i++ {
		counts[durs[i]]++
	}
	var modal, modalCount int
	for d, c := range counts {
		if c > modalCount {
			modal = d
			modalCount = c
		}
	}
	for i := 0; i < len(durs)-1; i++ {
		dev := durs[i] - modal
		if dev < 0 {
			dev = -dev
		}
		if dev > dashUniformToleranceTicks {
			return 0, false
		}
	}
	return modal, true
}

// readPlaylistSegmentDurationsTicks parses an HLS playlist and returns each
// segment's duration in dashTimescale ticks (μs), in playlist order. Only
// #EXTINF lines are considered; comments and segment URIs are ignored. The
// HMAC-rewritten playlists produced by RewritePlaylistHMAC preserve
// #EXTINF lines verbatim, so this works regardless of whether the caller
// has already rewritten the playlist for edge verification.
//
// EXTINF format (RFC 8216 §4.4.4.1): "#EXTINF:<duration>,[<title>]". The
// fractional-second form (e.g. "#EXTINF:9.9833,") is the one FFmpeg emits
// for CMAF segments; we scale to dashTimescale (μs) and round.
func readPlaylistSegmentDurationsTicks(playlistPath string) ([]int, error) {
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
		durs = append(durs, int(math.Round(secs*float64(dashTimescale))))
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
