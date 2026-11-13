package transcoder

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestPresentationCadence(t *testing.T) {
	tests := []struct {
		name     string
		pts      []int64
		scale    int64
		hint     *ProbeResult
		kind     CadenceKind
		num, den int
	}{
		{"integer", []int64{0, 3000, 6000, 9000, 12000}, 90000, nil, CadenceCFR, 30, 1},
		{"low rate", []int64{0, 5000, 10000, 15000}, 1000, nil, CadenceCFR, 1, 5},
		{"reordered B frames", []int64{6000, 15000, 9000, 12000, 24000, 18000, 21000}, 90000, nil, CadenceCFR, 30, 1},
		{"VFR despite reported rate", []int64{0, 3000, 6000, 12000, 15000, 18000}, 90000, &ProbeResult{FrameRateNum: 30, FrameRateDen: 1, AvgFrameRateNum: 25, AvgFrameRateDen: 1}, CadenceVFR, 0, 0},
		{"two frames", []int64{0, 3000}, 90000, nil, CadenceUnknown, 0, 0},
		{"duplicate PTS", []int64{0, 3000, 3000, 6000}, 90000, nil, CadenceUnknown, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cadenceFromPTS(tt.pts, tt.scale, tt.hint)
			if got.Kind != tt.kind || got.RateNum != tt.num || got.RateDen != tt.den {
				t.Fatalf("got %+v", got)
			}
		})
	}
}

func TestQuantizedRationalCadenceAndLateVFR(t *testing.T) {
	pts := make([]int64, 100001)
	for i := range pts {
		pts[i] = int64(math.Round(float64(i) * 90000 * 1001 / 60000))
	}
	hint := &ProbeResult{FrameRateNum: 60000, FrameRateDen: 1001}
	got := cadenceFromPTS(pts, 90000, hint)
	if got.Kind != CadenceCFR || got.RateNum != 60000 || got.RateDen != 1001 {
		t.Fatalf("quantized CFR: %+v", got)
	}
	for i := 80000; i < len(pts); i++ {
		pts[i] += 1501
	}
	if got := cadenceFromPTS(pts, 90000, hint); got.Kind != CadenceVFR {
		t.Fatalf("late VFR: %+v", got)
	}
}

func TestCadenceRunTimelines(t *testing.T) {
	got := cadenceFromRuns([]runEntry{{6, 3000}}, []runEntry{{1, 6000}, {1, 12000}, {2, 3000}, {1, 9000}, {1, 3000}}, 90000, nil)
	if got.Kind != CadenceCFR || got.RateNum != 30 {
		t.Fatalf("CTTS presentation sorting: %+v", got)
	}
	got = cadenceFromRuns([]runEntry{{cadenceFrameCap + 1, 3000}}, nil, 90000, nil)
	if got.Kind != CadenceUnknown {
		t.Fatalf("cap: %+v", got)
	}
}

func cadenceBox(name string, payload ...[]byte) []byte {
	n := 8
	for _, p := range payload {
		n += len(p)
	}
	out := make([]byte, n)
	binary.BigEndian.PutUint32(out, uint32(n))
	copy(out[4:], name)
	pos := 8
	for _, p := range payload {
		copy(out[pos:], p)
		pos += len(p)
	}
	return out
}
func cadenceU32(v ...uint32) []byte {
	out := make([]byte, 4*len(v))
	for i, n := range v {
		binary.BigEndian.PutUint32(out[4*i:], n)
	}
	return out
}
func cadenceFixture(extra ...[]byte) []byte {
	stbl := [][]byte{cadenceBox("stts", cadenceU32(0, 1, 6, 3000))}
	stbl = append(stbl, extra...)
	hd := make([]byte, 12)
	copy(hd[8:], "vide")
	mdhd := cadenceBox("mdhd", cadenceU32(0, 0, 0, 90000))
	elst := cadenceBox("edts", cadenceBox("elst", cadenceU32(0, 2, 23, 0xffffffff, 0x10000, 200, 6000, 0x10000)))
	trak := cadenceBox("trak", cadenceBox("mdia", cadenceBox("hdlr", hd), mdhd, cadenceBox("minf", cadenceBox("stbl", stbl...))), elst)
	return cadenceBox("moov", cadenceBox("mvhd", cadenceU32(0, 0, 0, 1000)), trak)
}

func TestIndexOptionalTablesAbsentVersusMalformed(t *testing.T) {
	for _, name := range []string{"ctts", "stss"} {
		t.Run(name, func(t *testing.T) {
			absent := bytes.NewReader(nil)
			if name == "ctts" {
				_, err := readRunTable(absent, 0, 0, name)
				if !errors.Is(err, errMP4BoxAbsent) {
					t.Fatalf("absent: %v", err)
				}
			} else {
				got, err := readSyncSamples(absent, 0, 0, 3)
				if err != nil || len(got) != 3 {
					t.Fatalf("absent sync: %v %v", got, err)
				}
			}
			bad := append(cadenceU32(100), []byte(name)...)
			var err error
			if name == "ctts" {
				_, err = readRunTable(bytes.NewReader(bad), 0, int64(len(bad)), name)
			} else {
				_, err = readSyncSamples(bytes.NewReader(bad), 0, int64(len(bad)), 3)
			}
			if err == nil || errors.Is(err, errMP4BoxAbsent) {
				t.Fatalf("malformed accepted as absent: %v", err)
			}
		})
	}
}

func TestSourceIndexCadenceAndEditTranslation(t *testing.T) {
	data := cadenceFixture(cadenceBox("ctts", cadenceU32(0, 5, 1, 6000, 1, 12000, 2, 3000, 1, 9000, 1, 3000)), cadenceBox("stss", cadenceU32(0, 2, 1, 5)))
	path := filepath.Join(t.TempDir(), "source.mp4")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	times, cadence, err := readSourceIndex(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cadence.Kind != CadenceCFR || cadence.RateNum != 30 || cadence.FrameCount != 6 {
		t.Fatalf("cadence %+v", cadence)
	}
	if len(times) != 2 || math.Abs(times[0]-.023) > 1e-10 || math.Abs(times[1]-(.023+15000.0/90000)) > 1e-10 {
		t.Fatalf("edit+CTTS keyframe times: %v", times)
	}
}

func TestRunTableCompositionOffsetCompatibility(t *testing.T) {
	for _, tt := range []struct {
		name           string
		version, value uint32
		want           int64
		reject         bool
	}{
		{"v0 positive", 0, 3003, 3003, false},
		{"v0 offset boundary", 0, 1 << 28, 1 << 28, false},
		{"v0 extreme positive", 0, 1<<28 + 1, 0, true},
		{"v0 maximum signed", 0, 0x7fffffff, 0, true},
		{"v0 high bit ambiguous", 0, 0x80000000, 0, true},
		{"v0 negative convention ambiguous", 0, 0xfffff448, 0, true},
		{"v1 negative", 0x01000000, 0xffffffff, -1, false},
		{"v1 negative boundary", 0x01000000, 0xf0000000, -(1 << 28), false},
		{"v1 extreme negative", 0x01000000, 0xefffffff, 0, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			data := cadenceBox("ctts", cadenceU32(tt.version, 1, 3, tt.value))
			got, err := readRunTable(bytes.NewReader(data), 0, int64(len(data)), "ctts")
			if tt.reject {
				if !errors.Is(err, ErrNoMP4Index) || errors.Is(err, errMP4BoxAbsent) {
					t.Fatalf("ambiguous offset must trigger fallback: %v", err)
				}
				return
			}
			if err != nil || got[0].value != tt.want {
				t.Fatalf("got %v %v, want %d", got, err, tt.want)
			}
		})
	}
}

func TestSourceIndexRejectsMalformedOptionalTables(t *testing.T) {
	cases := map[string][]byte{
		"short ctts header":   cadenceBox("ctts", cadenceU32(0)),
		"empty ctts":          cadenceBox("ctts", cadenceU32(0, 0)),
		"short ctts table":    cadenceBox("ctts", cadenceU32(0, 2, 6, 0)),
		"ctts count mismatch": cadenceBox("ctts", cadenceU32(0, 1, 5, 0)),
		"ambiguous v0 ctts":   cadenceBox("ctts", cadenceU32(0, 1, 6, 0xfffff448)),
		"short stss header":   cadenceBox("stss", cadenceU32(0)),
		"short stss table":    cadenceBox("stss", cadenceU32(0, 2, 1)),
		"invalid stss sample": cadenceBox("stss", cadenceU32(0, 1, 7)),
	}
	for name, table := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "source.mp4")
			if err := os.WriteFile(path, cadenceFixture(table), 0600); err != nil {
				t.Fatal(err)
			}
			_, _, err := readSourceIndex(path, nil)
			if !errors.Is(err, ErrNoMP4Index) || errors.Is(err, errMP4BoxAbsent) {
				t.Fatalf("must reject malformed optional table: %v", err)
			}
		})
	}
}

func TestSourceIndexAbsentOptionalTablesStillWork(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source.mp4")
	if err := os.WriteFile(path, cadenceFixture(), 0600); err != nil {
		t.Fatal(err)
	}
	times, cadence, err := readSourceIndex(path, nil)
	if err != nil || len(times) != 6 || cadence.Kind != CadenceCFR {
		t.Fatalf("absent tables: %v %+v %v", times, cadence, err)
	}
}

func TestShortTailDoesNotChangeStartGridCadence(t *testing.T) {
	// The final duration is never used to determine the start grid.
	got := cadenceFromRuns([]runEntry{{999, 1024}, {1, 5}}, nil, 15360, &ProbeResult{FrameRateNum: 15, FrameRateDen: 1})
	if got.Kind != CadenceCFR || got.RateNum != 15 || got.RateDen != 1 {
		t.Fatalf("short tail: %+v", got)
	}
}

func TestPacketFallbackCadenceUsesContainerClock(t *testing.T) {
	old := ffprobePath
	t.Cleanup(func() { ffprobePath = old })
	script := filepath.Join(t.TempDir(), "ffprobe")
	content := "#!/bin/sh\nprintf '0,0.000000,K_\\n100,0.100000,__\\n33,0.033000,__\\n67,0.067000,__\\n167,0.167000,K_\\n133,0.133000,__\\n'\n"
	if err := os.WriteFile(script, []byte(content), 0700); err != nil {
		t.Fatal(err)
	}
	ffprobePath = script
	times, cadence, err := probeSourceTimelineFFprobe("unused", &ProbeResult{TimeBaseNum: 1, TimeBaseDen: 1000, FrameRateNum: 30000, FrameRateDen: 1001})
	if err != nil || len(times) != 2 || cadence.Kind != CadenceCFR || cadence.RateNum != 30000 || cadence.RateDen != 1001 {
		t.Fatalf("packet timeline %v %+v %v", times, cadence, err)
	}
	// Missing PTS makes the evidence incomplete, while the GOP list is retained.
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '0,0.000000,K_\\nN/A,0.033000,__\\n67,0.067000,K_\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	times, cadence, err = probeSourceTimelineFFprobe("unused", &ProbeResult{TimeBaseNum: 1, TimeBaseDen: 1000})
	if err != nil || len(times) != 2 || cadence.Kind != CadenceUnknown {
		t.Fatalf("incomplete packet timeline %v %+v %v", times, cadence, err)
	}
}

func TestConstantStartDeltaOutranksAverageTailHint(t *testing.T) {
	got := cadenceFromRuns([]runEntry{{999, 3003}, {1, 3004}}, nil, 90000,
		&ProbeResult{AvgFrameRateNum: 90000000, AvgFrameRateDen: 3003001})
	if got.Kind != CadenceCFR || got.RateNum != 30000 || got.RateDen != 1001 {
		t.Fatalf("constant start grid must retain exact rate: %+v", got)
	}
}

func TestSourceIndexCumulativeAllocationBudget(t *testing.T) {
	// Six samples, one stts row and one ctts row. Each run table charges
	// 8 raw +16 decoded bytes; all-intra sync charges24, keytimes48, PTS48.
	// The raw charges remain counted even when a GC could reclaim those bytes.
	data := cadenceFixture(cadenceBox("ctts", cadenceU32(0, 1, 6, 0)))
	path := filepath.Join(t.TempDir(), "source.mp4")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name   string
		bytes  int64
		wantOK bool
	}{
		{"each table fits but tables together exceed", 60, false},
		{"keyframe times exceed remaining", 119, false},
		{"presentation array exceeds remaining", 167, false},
		{"all tables and derived arrays exactly fit", 168, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			times, cadence, err := readSourceIndexWithBudget(path, nil, indexScratchAllowance+tt.bytes)
			if tt.wantOK {
				if err != nil || len(times) != 6 || cadence.Kind != CadenceCFR {
					t.Fatalf("exact budget: %v %+v %v", times, cadence, err)
				}
				return
			}
			if !errors.Is(err, ErrNoMP4Index) || errors.Is(err, errMP4BoxAbsent) {
				t.Fatalf("budget must request fallback: %v", err)
			}
		})
	}
	// A separate call gets its own budget; prior failures cannot change policy.
	if _, _, err := readSourceIndex(path, nil); err != nil {
		t.Fatalf("default budget after failures: %v", err)
	}
}

func TestSourceIndexSyncAndRawAllocationsCharged(t *testing.T) {
	table := cadenceBox("stts", cadenceU32(0, 1, 6, 3000))
	b := &indexAllocationBudget{remaining: 23}
	if _, err := readRunTableWithBudget(bytes.NewReader(table), 0, int64(len(table)), "stts", b); !errors.Is(err, ErrNoMP4Index) {
		t.Fatalf("raw+decoded rows must both be charged: %v", err)
	}
	if b.remaining != 23 {
		t.Fatalf("failed charge changed budget: %d", b.remaining)
	}
	sync := cadenceBox("stss", cadenceU32(0, 2, 1, 5))
	b = &indexAllocationBudget{remaining: 15}
	if _, err := readSyncSamplesWithBudget(bytes.NewReader(sync), 0, int64(len(sync)), 6, b); !errors.Is(err, ErrNoMP4Index) {
		t.Fatalf("raw+decoded sync must both be charged: %v", err)
	}
	b = &indexAllocationBudget{remaining: 23}
	if _, err := readSyncSamplesWithBudget(bytes.NewReader(nil), 0, 0, 6, b); !errors.Is(err, ErrNoMP4Index) {
		t.Fatalf("synthesized sync must be charged: %v", err)
	}
}
