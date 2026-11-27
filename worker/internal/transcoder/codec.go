package transcoder

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// ErrInvalidCodecMetadata identifies unusable init metadata. It is distinct
// from the optional sample-index sentinel used by GOP scan fallbacks.
var ErrInvalidCodecMetadata = errors.New("invalid codec metadata")

// VideoInitMetadata describes the video sample entry in the produced init
// segment. Width and Height are the stored video dimensions, without applying
// a profile's scaling plan, pixel-aspect ratio or track display transform.
type VideoInitMetadata struct {
	Codec  string
	Width  int
	Height int
}

// ProbeVideoInit reads codec and dimensions together from the produced AVC
// sample entry. A missing, ambiguous or invalid entry is an error; callers
// must not replace it with planned dimensions when publishing manifests.
func ProbeVideoInit(path string) (VideoInitMetadata, error) {
	f, err := os.Open(path)
	if err != nil {
		return VideoInitMetadata{}, fmt.Errorf("open video init: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return VideoInitMetadata{}, fmt.Errorf("stat video init: %w", err)
	}
	metadata, err := readInitVideoMetadata(f, info.Size())
	if err != nil {
		return VideoInitMetadata{}, fmt.Errorf("%w: %v", ErrInvalidCodecMetadata, err)
	}
	return metadata, nil
}

// ProbeCodecString retains the codec-only interface using the same validated
// init metadata reader as manifest dimensions.
func ProbeCodecString(path string) (string, error) {
	metadata, err := ProbeVideoInit(path)
	return metadata.Codec, err
}

// codecBox requires one direct child and validates all sibling boundaries.
func codecBox(f io.ReadSeeker, start, end int64, name string) (int64, int64, error) {
	boxes, err := collectBoxes(f, start, end, name)
	if err != nil {
		return 0, 0, err
	}
	if len(boxes) != 1 {
		return 0, 0, fmt.Errorf("expected one %s box, found %d", name, len(boxes))
	}
	return boxes[0][0], boxes[0][1], nil
}

func readInitCodec(f io.ReadSeeker, size int64) (string, error) {
	metadata, err := readInitVideoMetadata(f, size)
	return metadata.Codec, err
}

func readInitVideoMetadata(f io.ReadSeeker, size int64) (VideoInitMetadata, error) {
	ms, me, err := codecBox(f, 0, size, "moov")
	if err != nil {
		return VideoInitMetadata{}, err
	}
	tracks, err := collectBoxes(f, ms, me, "trak")
	if err != nil {
		return VideoInitMetadata{}, err
	}
	var result VideoInitMetadata
	for _, track := range tracks {
		ds, de, err := codecBox(f, track[0], track[1], "mdia")
		if err != nil {
			return VideoInitMetadata{}, err
		}
		hs, he, err := codecBox(f, ds, de, "hdlr")
		if err != nil {
			return VideoInitMetadata{}, err
		}
		var handler [12]byte
		if he-hs < int64(len(handler)) {
			return VideoInitMetadata{}, fmt.Errorf("short hdlr")
		}
		if _, err := readAt(f, hs, handler[:]); err != nil {
			return VideoInitMetadata{}, err
		}
		if string(handler[8:12]) != "vide" {
			continue
		}
		if result.Codec != "" {
			return VideoInitMetadata{}, fmt.Errorf("multiple video tracks")
		}
		ss, se := ds, de
		for _, name := range []string{"minf", "stbl", "stsd"} {
			ss, se, err = codecBox(f, ss, se, name)
			if err != nil {
				return VideoInitMetadata{}, err
			}
		}
		var stsd [8]byte
		if se-ss < int64(len(stsd)) {
			return VideoInitMetadata{}, fmt.Errorf("short stsd")
		}
		if _, err := readAt(f, ss, stsd[:]); err != nil {
			return VideoInitMetadata{}, err
		}
		if binary.BigEndian.Uint32(stsd[:4]) != 0 || binary.BigEndian.Uint32(stsd[4:]) != 1 {
			return VideoInitMetadata{}, fmt.Errorf("unsupported stsd version/flags or sample description count")
		}
		count := 0
		err = walkBoxes(f, ss+8, se, func(tag string, es, ee int64) (bool, error) {
			count++
			if count != 1 {
				return false, fmt.Errorf("multiple sample entries")
			}
			if tag != "avc1" && tag != "avc3" {
				return false, fmt.Errorf("unsupported video sample entry %q", tag)
			}
			// VisualSampleEntry has 78 bytes after its box header.
			if ee-es < 78 {
				return false, fmt.Errorf("short AVC visual sample entry")
			}
			// Width and height are unsigned 16-bit fields at offsets 24/26
			// within VisualSampleEntry's payload, before the codec boxes.
			var dimensions [4]byte
			if _, err := readAt(f, es+24, dimensions[:]); err != nil {
				return false, err
			}
			width := int(binary.BigEndian.Uint16(dimensions[:2]))
			height := int(binary.BigEndian.Uint16(dimensions[2:]))
			if width == 0 || height == 0 {
				return false, fmt.Errorf("invalid video dimensions %dx%d", width, height)
			}
			cs, ce, err := codecBox(f, es+78, ee, "avcC")
			if err != nil {
				return false, err
			}
			var cfg [7]byte
			if ce-cs < int64(len(cfg)) {
				return false, fmt.Errorf("short avcC")
			}
			if _, err := readAt(f, cs, cfg[:]); err != nil {
				return false, err
			}
			if cfg[0] != 1 || cfg[1] == 0 || cfg[3] == 0 {
				return false, fmt.Errorf("invalid AVC configuration header")
			}
			if err := validateAVCParameterSets(f, cs, ce, cfg); err != nil {
				return false, err
			}
			result = VideoInitMetadata{
				Codec:  fmt.Sprintf("%s.%02X%02X%02X", tag, cfg[1], cfg[2], cfg[3]),
				Width:  width,
				Height: height,
			}
			return false, nil
		})
		if err != nil {
			return VideoInitMetadata{}, err
		}
		if count != 1 {
			return VideoInitMetadata{}, fmt.Errorf("missing video sample entry")
		}
	}
	if result.Codec == "" {
		return VideoInitMetadata{}, fmt.Errorf("no AVC video track")
	}
	return result, nil
}

// Validate record lengths without loading or scanning media payload. AVC3 can
// carry parameter sets in-band; zero parameter-set counts are therefore valid.
func validateAVCParameterSets(f io.ReadSeeker, start, end int64, cfg [7]byte) error {
	if cfg[4]&3 == 2 {
		return fmt.Errorf("invalid avcC NAL length size")
	}
	pos := start + 6
	readSets := func(count int) error {
		for i := 0; i < count; i++ {
			if end-pos < 2 {
				return fmt.Errorf("truncated avcC parameter length")
			}
			var length [2]byte
			if _, err := readAt(f, pos, length[:]); err != nil {
				return err
			}
			pos += 2
			n := int64(binary.BigEndian.Uint16(length[:]))
			if n == 0 || n > end-pos {
				return fmt.Errorf("truncated or empty avcC parameter set")
			}
			pos += n
		}
		return nil
	}
	if err := readSets(int(cfg[5] & 31)); err != nil {
		return err
	}
	if pos >= end {
		return fmt.Errorf("missing avcC PPS count")
	}
	var count [1]byte
	if _, err := readAt(f, pos, count[:]); err != nil {
		return err
	}
	pos++
	return readSets(int(count[0]))
}
