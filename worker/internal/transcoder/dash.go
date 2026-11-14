package transcoder

import (
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
// <1 μs. Uniform addressing additionally checks cumulative boundary error.
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
const dashMinBufferTimeSeconds = 2.0

const dashMPDTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     type="static"
     mediaPresentationDuration="{{.DurationISO}}"
     minBufferTime="{{.MinBufferTimeISO}}"
     profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" startWithSAP="1">
{{- range .VideoReps}}
      <Representation id="{{.Name}}" codecs="{{.Codecs}}" bandwidth="{{.Bandwidth}}" width="{{.Width}}" height="{{.Height}}"{{if .FrameRate}} frameRate="{{.FrameRate}}"{{end}}>
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
      <Representation id="{{.AudioName}}" codecs="mp4a.40.2" bandwidth="{{.AudioBandwidth}}" audioSamplingRate="{{.AudioSampleRate}}">
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
	Bandwidth            int64 // bits/sec
	Width                int
	Height               int
	FrameRate            string
	Uniform              bool
	SegmentDurationTicks int
	Timeline             []dashSegmentRun
}

// dashTmplContext is the full view passed to dashMPDTemplate.
//
// HasAudio gates the entire audio AdaptationSet. When false, every audio*
// field is unused.
type dashTmplContext struct {
	DurationISO      string
	MinBufferTimeISO string
	Timescale        int // shared timescale for both AdaptationSets

	VideoReps []dashVideoRep

	HasAudio                  bool
	AudioName                 string
	AudioBandwidth            int64
	AudioSampleRate           int // Hz, as encoded — NOT a fixed constant
	AudioUniform              bool
	AudioSegmentDurationTicks int              // when AudioUniform
	AudioTimeline             []dashSegmentRun // when !AudioUniform
}

// WriteDASHManifest renders an MPD into outputDir/manifest.mpd.
//
// variants describe the video renditions (shared with WriteMasterPlaylistCMAF
// so Codecs/FrameRate/Bandwidth stay consistent across the HLS and DASH
// manifests). audioName is the audio folder name under audio/ (e.g.
// "aac"). Encoder target arguments are retained for callers; bandwidth
// declarations are measured from the completed local media artifacts.
//
// audioSampleRateHz must be the rate that was actually encoded, not a
// site-wide constant. The audio encoder keeps whatever rate the source had
// (see TranscodeAudio), so a hard-coded value here silently misdeclares every
// 44.1 kHz source as 48 kHz. The caller reads it back off the produced audio
// init segment via ProbeAudioSampleRate for exactly that reason. HLS needs no
// equivalent — neither EXT-X-MEDIA nor the mp4a.40.2 codec string carries a
// sample rate, so master.m3u8 was never affected.
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
func WriteDASHManifest(outputDir string, variants []Variant, audioName string, audioBitrateKbps int, audioSampleRateHz int, durationSec float64, hasAudio bool) error {
	if err := validateVariantCodecs(variants); err != nil {
		return err
	}
	sourceTicks, err := durationSecondsTicks(durationSec)
	if err != nil {
		return fmt.Errorf("source duration: %w", err)
	}
	reps := make([]dashVideoRep, 0, len(variants))
	videoDurations := make([][]int, 0, len(variants))
	// Track the shortest per-rendition timeline (in ticks) so
	// mediaPresentationDuration can be clamped down if any rendition
	// undershoots the ffprobe duration — a player that sees a longer
	// mediaPresentationDuration than the timeline allows may try to
	// present a seek bar past the last segment.
	shortestTicks := -1
	for _, v := range variants {
		codecs := v.Codecs
		frameRate := ""
		if v.FrameRateNum > 0 && v.FrameRateDen > 0 {
			n, d := v.FrameRateNum, v.FrameRateDen
			g := gcd(n, d)
			n, d = n/g, d/g
			frameRate = strconv.Itoa(n)
			if d != 1 {
				frameRate += "/" + strconv.Itoa(d)
			}
		} else if v.FrameRate > 0 {
			frameRate = strconv.Itoa(v.FrameRate)
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

		rates, err := MeasureRenditionBandwidth(playlistPath, dashMinBufferTimeSeconds)
		if err != nil {
			return fmt.Errorf("measure DASH video bandwidth %s: %w", v.Name, err)
		}
		rep := dashVideoRep{
			Name:      v.Name,
			Codecs:    codecs,
			Bandwidth: rates.DASH,
			Width:     v.Width,
			Height:    v.Height,
			FrameRate: frameRate,
		}
		reps = append(reps, rep)
		videoDurations = append(videoDurations, durs)
	}

	var audioBandwidth int64
	var audioRuns []dashSegmentRun
	var audioDurations []int
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
		rates, err := MeasureRenditionBandwidth(audioPlaylist, dashMinBufferTimeSeconds)
		if err != nil {
			return fmt.Errorf("measure DASH audio bandwidth: %w", err)
		}
		audioBandwidth = rates.DASH
		audioDurations = durs
	}

	// mediaPresentationDuration should not exceed what every rendition can
	// actually deliver. ffprobe occasionally reports a duration slightly
	// longer than what FFmpeg's HLS muxer emits (e.g. a dangling partial
	// frame the muxer drops); using the shortest timeline here keeps the
	// header honest.
	effectiveTicks := sourceTicks
	if shortestTicks > 0 && shortestTicks < effectiveTicks {
		effectiveTicks = shortestTicks
	}
	// The final period cap participates in simple addressing: ceil(period / d)
	// must name exactly the artifacts we have, including the trailing partial.
	for i := range reps {
		reps[i].SegmentDurationTicks, reps[i].Uniform = compactDurationForPeriod(videoDurations[i], effectiveTicks)
		if !reps[i].Uniform {
			reps[i].Timeline = compressToSegmentRuns(videoDurations[i])
		}
	}
	if hasAudio {
		audioSegTicks, audioUniform = compactDurationForPeriod(audioDurations, effectiveTicks)
		if !audioUniform {
			audioRuns = compressToSegmentRuns(audioDurations)
		}
	}

	ctx := dashTmplContext{
		DurationISO:               formatISODurationTicks(effectiveTicks),
		MinBufferTimeISO:          formatISODuration(dashMinBufferTimeSeconds),
		Timescale:                 dashTimescale,
		VideoReps:                 reps,
		HasAudio:                  hasAudio,
		AudioName:                 audioName,
		AudioBandwidth:            audioBandwidth,
		AudioSampleRate:           audioSampleRateHz,
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

// dashUniformToleranceTicks bounds both individual duration deviation and every
// absolute cumulative boundary error, in microseconds. The final partial is
// excluded from fitting and checked against the effective period separately.
const dashUniformToleranceTicks = 100 * 1000

func segmentDurationIfUniform(durs []int) (int, bool) {
	if len(durs) < 2 {
		return 0, false
	}
	return uniformDurationTicks(durs[:len(durs)-1])
}

// uniformDurationTicks tries the deterministic mode first, then the rounded
// measured mean. Both must pass the same local and whole-file prefix checks.
// Remux simulation uses this same test for predicted full segments.
func uniformDurationTicks(durs []int) (int, bool) {
	modal, mean, ok := uniformDurationCandidates(durs)
	if !ok {
		return 0, false
	}
	for _, candidate := range []int{modal, mean} {
		if durationCandidateFits(durs, candidate) {
			return candidate, true
		}
	}
	return 0, false
}

// compactDurationForPeriod checks each candidate against the complete final
// period before selecting it. A locally valid mode may imply the wrong final
// segment count while the measured mean still permits compact addressing.
func compactDurationForPeriod(durs []int, effective int) (int, bool) {
	if len(durs) < 2 {
		return 0, false
	}
	full := durs[:len(durs)-1]
	modal, mean, ok := uniformDurationCandidates(full)
	if !ok {
		return 0, false
	}
	for _, candidate := range []int{modal, mean} {
		if durationCandidateFits(full, candidate) && compactDurationCovers(durs, candidate, effective) {
			return candidate, true
		}
	}
	return 0, false
}

func uniformDurationCandidates(durs []int) (modal, mean int, ok bool) {
	if len(durs) == 0 {
		return 0, 0, false
	}
	counts := make(map[int]int)
	total, modalCount := 0, 0
	for _, d := range durs {
		if d <= 0 || d > int(^uint(0)>>1)-total {
			return 0, 0, false
		}
		total += d
		counts[d]++
		if counts[d] > modalCount || (counts[d] == modalCount && d < modal) {
			modal, modalCount = d, counts[d]
		}
	}
	mean = total / len(durs)
	if total%len(durs) >= len(durs)/2+len(durs)%2 {
		mean++
	}
	return modal, mean, true
}

func durationCandidateFits(durs []int, nominal int) bool {
	if nominal <= 0 {
		return false
	}
	prefixError := 0
	for _, d := range durs {
		deviation := d - nominal
		if d <= 0 || deviation < -dashUniformToleranceTicks || deviation > dashUniformToleranceTicks {
			return false
		}
		// This stays in [-200ms, 200ms], avoiding large sums/products.
		prefixError += deviation
		if prefixError < -dashUniformToleranceTicks || prefixError > dashUniformToleranceTicks {
			return false
		}
	}
	return true
}

func compactDurationCovers(durs []int, nominal, effective int) bool {
	if nominal <= 0 || effective <= 0 || len(durs) == 0 {
		return false
	}
	// ceil without effective+nominal-1 overflow.
	if (effective-1)/nominal+1 != len(durs) {
		return false
	}
	total := 0
	for _, d := range durs {
		if d <= 0 || d > int(^uint(0)>>1)-total {
			return false
		}
		total += d
	}
	// The actual final artifact must cover the end of the advertised period.
	return effective <= total && effective > total-durs[len(durs)-1]
}

// compressToSegmentRuns run-length-encodes a sequence of per-segment
// durations (in μs) into DASH <S> runs. Consecutive equal durations
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

// durationSecondsTicks converts the source ffprobe value once. The bound is
// exclusive because float64(maxInt) rounds upward on 64-bit platforms.
func durationSecondsTicks(sec float64) (int, error) {
	if math.IsNaN(sec) || math.IsInf(sec, 0) || sec <= 0 {
		return 0, fmt.Errorf("duration must be finite and positive")
	}
	rounded := math.Round(sec * dashTimescale)
	if rounded < 1 || rounded >= float64(int(^uint(0)>>1)) {
		return 0, fmt.Errorf("duration overflows or rounds below one microsecond")
	}
	return int(rounded), nil
}

// formatISODurationTicks uses exact integer carries and at most six decimal
// places, so rounding can never produce an invalid seconds component of 60.
func formatISODurationTicks(ticks int) string {
	whole, fraction := ticks/dashTimescale, ticks%dashTimescale
	hours, mins, secs := whole/3600, (whole%3600)/60, whole%60
	var sb strings.Builder
	sb.WriteString("PT")
	if hours > 0 {
		fmt.Fprintf(&sb, "%dH", hours)
	}
	if mins > 0 {
		fmt.Fprintf(&sb, "%dM", mins)
	}
	if secs > 0 || fraction > 0 || (hours == 0 && mins == 0) {
		fmt.Fprintf(&sb, "%d", secs)
		if fraction > 0 {
			fmt.Fprintf(&sb, ".%s", strings.TrimRight(fmt.Sprintf("%06d", fraction), "0"))
		}
		sb.WriteString("S")
	}
	return sb.String()
}

// formatISODuration remains a seconds-based convenience for callers/tests;
// the writer uses the already-converted integer value directly.
func formatISODuration(sec float64) string {
	ticks, err := durationSecondsTicks(sec)
	if err != nil {
		return "PT0S"
	}
	return formatISODurationTicks(ticks)
}
