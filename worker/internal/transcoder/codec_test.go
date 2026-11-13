package transcoder

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func codecTestBox(tag string, payload ...[]byte) []byte {
	b := make([]byte, 8)
	copy(b[4:], tag)
	for _, p := range payload {
		b = append(b, p...)
	}
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	return b
}
func codecTestTrack(handler string, entries []byte, count uint32) []byte {
	h := make([]byte, 12)
	copy(h[8:], handler)
	sd := make([]byte, 8)
	binary.BigEndian.PutUint32(sd[4:], count)
	return codecTestBox("trak", codecTestBox("mdia", codecTestBox("hdlr", h), codecTestBox("minf", codecTestBox("stbl", codecTestBox("stsd", sd, entries)))))
}
func codecTestEntry(tag string, config []byte) []byte {
	return codecTestBox(tag, make([]byte, 78), codecTestBox("avcC", config))
}
func codecTestConfig(profile, compat, level byte) []byte {
	return []byte{1, profile, compat, level, 0xff, 0xe1, 0, 4, 0x67, profile, compat, level, 1, 0, 2, 0x68, 0}
}
func TestProbeCodecStringExactInit(t *testing.T) {
	for _, tc := range []struct {
		name, tag, want string
		p, c, l         byte
	}{
		{"1440p", "avc1", "avc1.640033", 100, 0, 51},
		{"1080p", "avc1", "avc1.64002A", 100, 0, 42},
		{"720p constraints", "avc1", "avc1.4D4020", 77, 64, 32},
		{"High10", "avc1", "avc1.6E1029", 110, 16, 41},
		{"baseline all flags", "avc1", "avc1.42E01F", 66, 224, 31},
		{"AVC3", "avc3", "avc3.640028", 100, 0, 40},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := codecTestBox("moov", codecTestTrack("soun", nil, 0), codecTestTrack("vide", codecTestEntry(tc.tag, codecTestConfig(tc.p, tc.c, tc.l)), 1), codecTestBox("mvex"))
			path := filepath.Join(t.TempDir(), "init.mp4")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			got, err := ProbeCodecString(path)
			if err != nil || got != tc.want {
				t.Fatalf("got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
func TestInitCodecRejectsAmbiguousOrMalformed(t *testing.T) {
	cfg := codecTestConfig(100, 0, 40)
	entry := codecTestEntry("avc1", cfg)
	track := codecTestTrack("vide", entry, 1)
	badVersion := append([]byte(nil), cfg...)
	badVersion[0] = 2
	badLength := append([]byte(nil), cfg...)
	badLength[6] = 0xff
	for name, data := range map[string][]byte{
		"missing moov":       codecTestBox("free", []byte("avcC")),
		"missing video":      codecTestBox("moov", codecTestTrack("soun", nil, 0)),
		"two video tracks":   codecTestBox("moov", track, track),
		"two moov":           append(codecTestBox("moov", track), codecTestBox("moov", track)...),
		"two entries":        codecTestBox("moov", codecTestTrack("vide", append(append([]byte(nil), entry...), entry...), 2)),
		"count mismatch":     codecTestBox("moov", codecTestTrack("vide", append(append([]byte(nil), entry...), entry...), 1)),
		"missing avcC":       codecTestBox("moov", codecTestTrack("vide", codecTestBox("avc1", make([]byte, 78)), 1)),
		"short avcC":         codecTestBox("moov", codecTestTrack("vide", codecTestEntry("avc1", cfg[:3]), 1)),
		"bad version":        codecTestBox("moov", codecTestTrack("vide", codecTestEntry("avc1", badVersion), 1)),
		"bad SPS length":     codecTestBox("moov", codecTestTrack("vide", codecTestEntry("avc1", badLength), 1)),
		"short visual entry": codecTestBox("moov", codecTestTrack("vide", codecTestBox("avc1", make([]byte, 77)), 1)),
		"HEVC unsupported":   codecTestBox("moov", codecTestTrack("vide", codecTestEntry("hvc1", cfg), 1)),
		"truncated sibling":  codecTestBox("moov", track, []byte{0}),
		"duplicate avcC":     codecTestBox("moov", codecTestTrack("vide", codecTestBox("avc1", make([]byte, 78), codecTestBox("avcC", cfg), codecTestBox("avcC", cfg)), 1)),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := readInitCodec(bytes.NewReader(data), int64(len(data)))
			if err == nil || got != "" {
				t.Fatalf("got %q, %v; wanted error", got, err)
			}
		})
	}
}
func TestCodecBoxSizeBounds(t *testing.T) {
	for name, data := range map[string][]byte{
		"oversized32":                  {0xff, 0xff, 0xff, 0xff, 'f', 'r', 'e', 'e'},
		"oversized64":                  {0, 0, 0, 1, 'f', 'r', 'e', 'e', 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		"extended smaller than header": {0, 0, 0, 1, 'f', 'r', 'e', 'e', 0, 0, 0, 0, 0, 0, 0, 8},
		"truncated extended":           {0, 0, 0, 1, 'f', 'r', 'e', 'e'},
		"truncated header":             {0, 0, 0},
	} {
		t.Run(name, func(t *testing.T) {
			if err := walkBoxes(bytes.NewReader(data), 0, int64(len(data)), func(string, int64, int64) (bool, error) { t.Fatal("invalid box reached callback"); return false, nil }); err == nil {
				t.Fatal("expected error")
			}
		})
	}
	for _, data := range [][]byte{
		{0, 0, 0, 1, 'f', 'r', 'e', 'e', 0, 0, 0, 0, 0, 0, 0, 16},
		{0, 0, 0, 0, 'f', 'r', 'e', 'e'},
	} {
		calls := 0
		err := walkBoxes(bytes.NewReader(data), 0, int64(len(data)), func(_ string, s, e int64) (bool, error) {
			calls++
			if s != e {
				t.Fatal("expected empty payload")
			}
			return false, nil
		})
		if err != nil || calls != 1 {
			t.Fatalf("calls=%d error=%v", calls, err)
		}
	}
}

func TestCodecMetadataToleratesUnusedBitsAndSiblingBoxes(t *testing.T) {
	cfg := codecTestConfig(77, 64, 32)
	cfg[4] = 3
	cfg[5] = 1 // Noncanonical reserved bits do not alter the triple.
	entry := codecTestBox("avc1", make([]byte, 78), codecTestBox("avcC", cfg), codecTestBox("btrt", make([]byte, 12)), codecTestBox("pasp", []byte{0, 0, 0, 1, 0, 0, 0, 1}), codecTestBox("colr", []byte{'n', 'c', 'l', 'x', 0, 1, 0, 1, 0, 1, 0}))
	data := codecTestBox("moov", codecTestTrack("vide", entry, 1))
	got, err := readInitCodec(bytes.NewReader(data), int64(len(data)))
	if err != nil || got != "avc1.4D4020" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestCodecMetadataAVC3InBandParameterSets(t *testing.T) {
	data := codecTestBox("moov", codecTestTrack("vide", codecTestEntry("avc3", []byte{1, 100, 0, 40, 255, 224, 0}), 1))
	got, err := readInitCodec(bytes.NewReader(data), int64(len(data)))
	if err != nil || got != "avc3.640028" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestCodecMetadataErrorClassification(t *testing.T) {
	data := []byte{255, 255, 255, 255, 'm', 'o', 'o', 'v'}
	_, _, err := findBox(bytes.NewReader(data), 0, int64(len(data)), "moov")
	if !errors.Is(err, ErrNoMP4Index) {
		t.Fatalf("malformed walker error = %v", err)
	}
	path := filepath.Join(t.TempDir(), "init.mp4")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = ProbeCodecString(path)
	if !errors.Is(err, ErrInvalidCodecMetadata) || errors.Is(err, ErrNoMP4Index) {
		t.Fatalf("codec metadata error = %v", err)
	}
	_, err = ProbeCodecString(filepath.Join(t.TempDir(), "missing.mp4"))
	if !errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrInvalidCodecMetadata) {
		t.Fatalf("missing file error = %v", err)
	}
}

func TestCodecMetadataRejectsNonzeroSTSDHeader(t *testing.T) {
	for _, header := range [][]byte{{1, 0, 0, 0, 0, 0, 0, 1}, {0, 0, 0, 1, 0, 0, 0, 1}} {
		data := codecTestBox("moov", codecTestBox("trak", codecTestBox("mdia", codecTestBox("hdlr", []byte{0, 0, 0, 0, 0, 0, 0, 0, 'v', 'i', 'd', 'e'}), codecTestBox("minf", codecTestBox("stbl", codecTestBox("stsd", header, codecTestEntry("avc1", codecTestConfig(100, 0, 40))))))))
		if got, err := readInitCodec(bytes.NewReader(data), int64(len(data))); err == nil || got != "" {
			t.Fatalf("got %q, %v", got, err)
		}
	}
}
