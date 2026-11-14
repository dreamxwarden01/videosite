package transcoder

import (
	"math"
	"strings"
	"testing"
)

func TestAudioGraphCommonEpochAndBoundedWindow(t *testing.T) {
	for _, rate := range []int{44100, 48000} {
		graph, err := buildAudioFilterGraph(1, rate, "loudnorm=I=-16", 12.345678)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"[0:a:0]" + audioClockRepair + "[clock0];[clock0]", "first_pts=0", "max_soft_comp=0.0005", "apad,atrim=end=12.345678,loudnorm=I=-16"} {
			if !strings.Contains(graph, want) {
				t.Fatalf("missing %q in %s", want, graph)
			}
		}
		if strings.Contains(graph, "STARTPTS") || strings.Contains(graph, "amix") {
			t.Fatalf("single track must not independently reset its timestamps: %s", graph)
		}
	}
}

func TestAudioGraphAnalysisAndEncodeShareSignal(t *testing.T) {
	analysis, err := buildAudioFilterGraph(3, 44100, "loudnorm=print_format=json", 20)
	if err != nil {
		t.Fatal(err)
	}
	encode, err := buildAudioFilterGraph(3, 44100, "loudnorm=I=-16:linear=true", 20)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range []string{analysis, encode} {
		if strings.Count(g, audioClockRepair) != 3 {
			t.Fatalf("each input needs clock repair: %s", g)
		}
		if !strings.Contains(g, "[clock0][clock1][clock2]amix=inputs=3:normalize=0:duration=longest:dropout_transition=0,aformat=sample_rates=44100:channel_layouts=stereo,apad,atrim=end=20.000000") {
			t.Fatalf("mix/window mismatch: %s", g)
		}
		if !strings.HasSuffix(g, ",aresample=44100,asettb=1/44100,asetpts=N,apad,atrim=end=20.000000[mix]") {
			t.Fatalf("native rate not restored after normalization: %s", g)
		}
	}
	a, _, _ := strings.Cut(analysis, ",loudnorm=")
	e, _, _ := strings.Cut(encode, ",loudnorm=")
	if a != e {
		t.Fatal("analysis/encode see different PCM graphs")
	}
}

func TestAudioGraphRejectsUnknownOrChangedNativeRate(t *testing.T) {
	for _, rate := range []int{0, -1, 50000} {
		if _, err := buildAudioFilterGraph(1, rate, "", 10); err == nil {
			t.Fatalf("accepted unsupported native rate %d", rate)
		}
	}
	for _, n := range []int{0, -1, 129} {
		if _, err := buildAudioFilterGraph(n, 48000, "", 10); err == nil {
			t.Fatalf("accepted stream count %d", n)
		}
	}
	for _, d := range []float64{0, -1, math.NaN(), math.Inf(1), math.MaxFloat64, 0.0000001} {
		if _, err := buildAudioFilterGraph(1, 48000, "", d); err == nil {
			t.Fatalf("accepted duration %v", d)
		}
	}
}

func TestAudioPreflightRejectsBeforeWork(t *testing.T) {
	if err := ValidateAudioTranscode(1, 50000, 6, 100); err == nil {
		t.Fatal("unsupported source rate accepted")
	}
	if err := ValidateAudioTranscode(1, 44100, 6, 1e12); err == nil {
		t.Fatal("unsafe horizon accepted")
	}
	if err := ValidateAudioTranscode(1, 7350, 6, 100); err != nil {
		t.Fatal(err)
	}
	g, err := buildAudioFilterGraph(2, 48000, "", 12)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(g, "alimiter=limit=0.95:level=false:latency=true") {
		t.Fatal("un-normalized mix lacks compensated clip guard")
	}
}
