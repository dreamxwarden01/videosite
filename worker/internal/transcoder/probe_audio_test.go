package transcoder

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"
)

func probeAudioMetadataFixture(t *testing.T, audioRates ...string) *ProbeResult {
	t.Helper()
	fixture := ffprobeOutput{
		Streams: []ffprobeStream{{CodecType: "video", CodecName: "h264", Width: 1920, Height: 1080}},
		Format:  ffprobeFormat{BitRate: "12345678", Duration: "10.5"},
	}
	for i, rate := range audioRates {
		codec, sampleRate := "aac", "44100"
		if i > 0 {
			codec, sampleRate = "opus", "48000"
		}
		fixture.Streams = append(fixture.Streams, ffprobeStream{CodecType: "audio", CodecName: codec, SampleRate: sampleRate, BitRate: rate})
	}
	// Unconsumed non-audio metadata must not enter the audio aggregate.
	fixture.Streams = append(fixture.Streams, ffprobeStream{CodecType: "subtitle", BitRate: "999999999"})
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	result, err := parseProbeOutput(data, "fixture.mp4")
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestProbeAudioBitrateMetadataSumsAllAudioStreams(t *testing.T) {
	got := probeAudioMetadataFixture(t, "64000", "95732")
	if got.AudioBitrateBps != 159732 || got.AudioStreamCount != 2 {
		t.Fatalf("audio aggregate/count = %d/%d", got.AudioBitrateBps, got.AudioStreamCount)
	}
	if got.AudioCodec != "aac" || got.AudioSampleRate != 44100 {
		t.Fatalf("first audio identity changed: %+v", got)
	}
	if got.VideoBitrateKbps != 12345 || got.DurationSeconds != 10.5 {
		t.Fatalf("existing video fallback/duration changed: %+v", got)
	}
	if got := probeAudioMetadataFixture(t, "95732"); got.AudioBitrateBps != 95732 {
		t.Fatalf("source was rounded to kbps: %d", got.AudioBitrateBps)
	}
}

func TestProbeAudioBitrateUnknownTrackInvalidatesWholeAggregate(t *testing.T) {
	for _, value := range []string{"", "N/A", "bad", "0", "-1", "1.5", "64000k", "9223372036854775808"} {
		t.Run(value, func(t *testing.T) {
			for _, rates := range [][]string{{"64000", value}, {value, "64000"}, {"64000", value, "32000"}} {
				got := probeAudioMetadataFixture(t, rates...)
				if got.AudioBitrateBps != 0 {
					t.Fatalf("partial invalid aggregate for %v: %d", rates, got.AudioBitrateBps)
				}
			}
		})
	}
}

func TestProbeAudioBitrateOverflowAndNoAudio(t *testing.T) {
	maxRate := strconv.FormatInt(math.MaxInt64, 10)
	if got := probeAudioMetadataFixture(t, maxRate); got.AudioBitrateBps != math.MaxInt64 {
		t.Fatalf("valid int64 boundary: %d", got.AudioBitrateBps)
	}
	if got := probeAudioMetadataFixture(t, maxRate, "1"); got.AudioBitrateBps != 0 {
		t.Fatalf("accepted aggregate overflow: %d", got.AudioBitrateBps)
	}
	if got := probeAudioMetadataFixture(t); got.AudioBitrateBps != 0 || got.AudioStreamCount != 0 {
		t.Fatalf("format bitrate became audio: %+v", got)
	}
}

func TestProbeAudioBitrateDoesNotUseVideoOrFormatMetadata(t *testing.T) {
	fixture := []byte(`{"streams":[{"codec_type":"video","width":1,"height":1,"bit_rate":"8888000"},{"codec_type":"audio","codec_name":"aac"}],"format":{"bit_rate":"99999999"}}`)
	got, err := parseProbeOutput(fixture, "fixture.mp4")
	if err != nil || got.AudioBitrateBps != 0 || got.VideoBitrateKbps != 8888 {
		t.Fatalf("video/format leaked into audio: %+v,%v", got, err)
	}
}
