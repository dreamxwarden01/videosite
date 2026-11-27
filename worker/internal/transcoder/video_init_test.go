package transcoder

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestProbeVideoInitPreservesStoredDimensions(t *testing.T) {
	for _, tc := range []struct {
		name, tag     string
		width, height uint16
	}{
		{"remux 722", "avc1", 1280, 722},
		{"wide 564", "avc1", 1280, 564},
		{"scaled 720", "avc1", 1276, 720},
		{"odd dimensions", "avc3", 1279, 721},
		{"small positive", "avc1", 1, 1},
		{"uint16 maximum", "avc1", 65535, 65535},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := codecTestBox(tc.tag, codecTestVisual(tc.width, tc.height), codecTestBox("avcC", codecTestConfig(100, 0, 40)))
			data := codecTestBox("moov", codecTestTrack("soun", nil, 0), codecTestTrack("vide", entry, 1), codecTestBox("mvex"))
			path := filepath.Join(t.TempDir(), "init.mp4")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			got, err := ProbeVideoInit(path)
			want := VideoInitMetadata{Codec: tc.tag + ".640028", Width: int(tc.width), Height: int(tc.height)}
			if err != nil || got != want {
				t.Fatalf("got %+v, %v; want %+v", got, err, want)
			}
		})
	}
}

func TestProbeVideoInitRejectsInvalidDimensions(t *testing.T) {
	for _, dims := range [][2]uint16{{0, 720}, {1280, 0}, {0, 0}} {
		entry := codecTestBox("avc1", codecTestVisual(dims[0], dims[1]), codecTestBox("avcC", codecTestConfig(100, 0, 40)))
		data := codecTestBox("moov", codecTestTrack("vide", entry, 1))
		path := filepath.Join(t.TempDir(), "init.mp4")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		got, err := ProbeVideoInit(path)
		if !errors.Is(err, ErrInvalidCodecMetadata) || got != (VideoInitMetadata{}) {
			t.Fatalf("dimensions %v: got %+v, %v; expected classified error and no partial result", dims, got, err)
		}
	}
}

func TestVideoInitUsesSampleEntryDimensionsWithExtendedHeader(t *testing.T) {
	payload := append(codecTestVisual(1280, 722), codecTestBox("avcC", codecTestConfig(100, 0, 40))...)
	// Pixel aspect metadata is separate from encoded width and height.
	payload = append(payload, codecTestBox("pasp", []byte{0, 0, 0, 4, 0, 0, 0, 3})...)
	entry := make([]byte, 16)
	binary.BigEndian.PutUint32(entry, 1)
	copy(entry[4:8], "avc1")
	binary.BigEndian.PutUint64(entry[8:16], uint64(len(entry)+len(payload)))
	entry = append(entry, payload...)
	data := codecTestBox("moov", codecTestTrack("vide", entry, 1))
	got, err := readInitVideoMetadata(bytes.NewReader(data), int64(len(data)))
	if err != nil || got != (VideoInitMetadata{Codec: "avc1.640028", Width: 1280, Height: 722}) {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestVideoInitNeverReturnsMetadataFromAmbiguousTrack(t *testing.T) {
	entry := codecTestEntry("avc1", codecTestConfig(100, 0, 40))
	track := codecTestTrack("vide", entry, 1)
	for name, data := range map[string][]byte{
		"two videos":              codecTestBox("moov", track, track),
		"two sample entries":      codecTestBox("moov", codecTestTrack("vide", append(append([]byte(nil), entry...), entry...), 2)),
		"truncated visual header": codecTestBox("moov", codecTestTrack("vide", codecTestBox("avc1", codecTestVisual(1280, 722)[:27]), 1)),
		"missing video":           codecTestBox("moov", codecTestTrack("soun", nil, 0)),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := readInitVideoMetadata(bytes.NewReader(data), int64(len(data)))
			if err == nil || got != (VideoInitMetadata{}) {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
}
