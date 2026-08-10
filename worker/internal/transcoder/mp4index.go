package transcoder

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

// ErrNoMP4Index reports that the source carries no usable ISO-BMFF sample
// index, so the caller must fall back to the ffprobe packet scan. Reasons
// include: a non-MP4 container, a fragmented MP4 (sample tables live in each
// moof, not in moov), a missing moov, or tables larger than indexTableCap.
//
// This is an expected outcome, not a failure — ReadKeyframeTimes is a fast
// path, and every caller has a working fallback.
var ErrNoMP4Index = errors.New("no usable mp4 sample index")

// indexTableCap bounds how many run-length entries we will hold from a single
// stts/ctts/stss table. The tables are already run-length encoded, so a clean
// CFR source needs one stts entry regardless of length; the cap only matters
// for pathological files. 8M entries is 64 MB of int32 pairs — far past
// anything real, and past it we fall back rather than risk the allocation.
const indexTableCap = 8 << 20

// ReadKeyframeTimes returns the presentation timestamps (seconds, relative to
// the start of the presentation) of every sync sample in the first video track
// of an MP4/MOV file.
//
// It reads only the moov index — stss (sync sample numbers), stts (decode
// deltas), ctts (composition offsets) and elst (edit list) — never the sample
// payload. On the lecture sources this project handles that is 2 KB - 4 MB of
// I/O and 5-75 ms, against 0.35-4.3 s for a full ffprobe packet scan of the
// same files, because a packet scan has to walk every sample's bytes.
//
// Returns ErrNoMP4Index when the file has no usable index; callers fall back
// to ProbeKeyframeTimesFFprobe.
//
// Correctness notes:
//   - ctts is applied, so the result is presentation time, not decode time.
//     Every source we see has B-frames (has_b_frames 2-4), where the two differ.
//   - Edit lists are honoured the way ffprobe's pts_time reports them: the
//     real edit's media_time is subtracted, and any leading empty edits
//     (media_time == -1, the usual way an encoder expresses start-up delay)
//     shift the presentation forward. Anything more elaborate than
//     "optional empty edits followed by one real edit" falls back rather than
//     guess at a timeline remap.
//   - A video track with no stss box means every sample is a sync sample
//     (all-intra source); we synthesise the full list rather than report none.
func ReadKeyframeTimes(path string) ([]float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open source for index read: %w", err)
	}
	defer f.Close()

	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, fmt.Errorf("stat source for index read: %w", err)
	}

	moovStart, moovEnd, err := findBox(f, 0, size, "moov")
	if err != nil {
		return nil, err
	}

	// A fragmented MP4 declares mvex in moov and leaves the sample tables
	// empty — the real timing lives in every moof/traf/trun. Detect it up
	// front so we fall back instead of returning an empty keyframe list.
	if _, _, err := findBox(f, moovStart, moovEnd, "mvex"); err == nil {
		return nil, fmt.Errorf("%w: fragmented mp4 (moov/mvex present)", ErrNoMP4Index)
	}

	// The movie timescale governs edit-list durations, which are expressed in
	// movie units while everything inside the track is in media units.
	movieTimescale, err := readMvhdTimescale(f, moovStart, moovEnd)
	if err != nil {
		return nil, err
	}

	traks, err := collectBoxes(f, moovStart, moovEnd, "trak")
	if err != nil {
		return nil, err
	}

	for _, trak := range traks {
		times, err := keyframeTimesFromTrak(f, trak[0], trak[1], movieTimescale)
		if err != nil {
			if errors.Is(err, ErrNoMP4Index) {
				continue // not the video track, or unusable — try the next trak
			}
			return nil, err
		}
		return times, nil
	}
	return nil, fmt.Errorf("%w: no video track with a sample table", ErrNoMP4Index)
}

// keyframeTimesFromTrak extracts sync-sample presentation times from one trak
// box, or ErrNoMP4Index if this trak is not a usable video track.
func keyframeTimesFromTrak(f io.ReadSeeker, start, end int64, movieTimescale uint32) ([]float64, error) {
	// hdlr tells us whether this is the video track. Checking it (rather than
	// "the first trak that happens to have an stss") keeps us correct on files
	// whose audio track precedes the video track.
	hs, he, err := findPath(f, start, end, "mdia", "hdlr")
	if err != nil {
		return nil, fmt.Errorf("%w: trak has no mdia/hdlr", ErrNoMP4Index)
	}
	// hdlr layout: version+flags (4), pre_defined (4), handler_type (4).
	buf := make([]byte, 12)
	if _, err := readAt(f, hs, buf); err != nil || he-hs < 12 {
		return nil, fmt.Errorf("%w: short hdlr", ErrNoMP4Index)
	}
	if string(buf[8:12]) != "vide" {
		return nil, fmt.Errorf("%w: not a video track", ErrNoMP4Index)
	}

	timescale, err := readMdhdTimescale(f, start, end)
	if err != nil {
		return nil, err
	}

	stblStart, stblEnd, err := findPath(f, start, end, "mdia", "minf", "stbl")
	if err != nil {
		return nil, fmt.Errorf("%w: trak has no stbl", ErrNoMP4Index)
	}

	stts, err := readRunTable(f, stblStart, stblEnd, "stts")
	if err != nil {
		return nil, err
	}
	if len(stts) == 0 {
		return nil, fmt.Errorf("%w: empty stts", ErrNoMP4Index)
	}

	totalSamples := int64(0)
	for _, run := range stts {
		totalSamples += int64(run.count)
	}

	sync, err := readSyncSamples(f, stblStart, stblEnd, totalSamples)
	if err != nil {
		return nil, err
	}
	if len(sync) == 0 {
		return nil, fmt.Errorf("%w: no sync samples listed", ErrNoMP4Index)
	}

	// ctts is optional: absent means every composition offset is zero.
	ctts, err := readRunTable(f, stblStart, stblEnd, "ctts")
	if err != nil && !errors.Is(err, ErrNoMP4Index) {
		return nil, err
	}

	editOffset, presentationDelay, err := readEditList(f, start, end, movieTimescale)
	if err != nil {
		return nil, err
	}

	return composeKeyframeTimes(stts, ctts, sync, editOffset, presentationDelay, timescale)
}

// composeKeyframeTimes walks the stts/ctts run tables once, in sample order,
// picking out the presentation time of each listed sync sample.
//
// Both tables are run-length encoded and describe EVERY sample in order, so
// the two cursors must be advanced by the same sample count in lockstep —
// including across the samples between two sync samples, which are skipped for
// output but still consume table entries. Advancing ctts only on the reported
// samples silently reads a stale composition offset and drifts by whole frames
// part-way through a long file.
//
// A single forward pass keeps memory flat: no table is expanded per-sample.
func composeKeyframeTimes(stts, ctts []runEntry, sync []uint32, editOffset int64, presentationDelay float64, timescale uint32) ([]float64, error) {
	if timescale == 0 {
		return nil, fmt.Errorf("%w: zero media timescale", ErrNoMP4Index)
	}

	out := make([]float64, 0, len(sync))
	sttsCur := newRunCursor(stts)
	cttsCur := newRunCursor(ctts)

	var (
		sample int64 = 1 // 1-based, matching stss numbering
		decode int64 = 0 // decode time of `sample`, in media timescale units
	)

	for _, want := range sync {
		target := int64(want)
		if target < sample {
			// stss must be monotonically increasing; anything else means a
			// malformed table we shouldn't try to interpret.
			return nil, fmt.Errorf("%w: non-monotonic stss", ErrNoMP4Index)
		}
		if skip := target - sample; skip > 0 {
			decode += sttsCur.skip(skip)
			cttsCur.skip(skip)
			sample = target
		}

		// Presentation time = decode time + composition offset, shifted by the
		// edit list so the result matches ffprobe's pts_time.
		out = append(out, float64(decode+cttsCur.peek()-editOffset)/float64(timescale)+presentationDelay)

		decode += sttsCur.skip(1)
		cttsCur.skip(1)
		sample++
	}
	return out, nil
}

// runCursor walks a run-length table (stts or ctts) one sample at a time
// without expanding it. A zero-length table is valid and yields 0 forever,
// which is exactly the semantics of an absent ctts box.
type runCursor struct {
	runs []runEntry
	idx  int
	left int64
}

func newRunCursor(runs []runEntry) *runCursor {
	c := &runCursor{runs: runs}
	if len(runs) > 0 {
		c.left = int64(runs[0].count)
	}
	return c
}

// seat advances past any exhausted runs so the cursor sits on a run with
// samples remaining, if one exists.
func (c *runCursor) seat() {
	for c.left == 0 && c.idx+1 < len(c.runs) {
		c.idx++
		c.left = int64(c.runs[c.idx].count)
	}
}

// peek returns the value applying to the current sample without consuming it.
func (c *runCursor) peek() int64 {
	c.seat()
	if c.left == 0 {
		return 0
	}
	return int64(c.runs[c.idx].value)
}

// skip consumes n samples and returns the sum of their values — the decode
// time advanced, for an stts cursor. Runs out silently at the end of the
// table so a short table can't produce an out-of-range panic.
func (c *runCursor) skip(n int64) int64 {
	var total int64
	for n > 0 {
		c.seat()
		if c.left == 0 {
			break
		}
		step := n
		if step > c.left {
			step = c.left
		}
		total += step * int64(c.runs[c.idx].value)
		c.left -= step
		n -= step
	}
	return total
}

// runEntry is one run-length row of an stts or ctts table: `count` consecutive
// samples sharing `value` (a decode delta for stts, a composition offset for
// ctts). ctts v1 offsets are signed, hence int32.
type runEntry struct {
	count uint32
	value int32
}

// readRunTable reads an stts or ctts box into run entries. Returns
// ErrNoMP4Index if the box is absent (legitimate for ctts) or too large.
func readRunTable(f io.ReadSeeker, start, end int64, name string) ([]runEntry, error) {
	bs, be, err := findBox(f, start, end, name)
	if err != nil {
		return nil, err
	}
	header := make([]byte, 8) // version+flags, entry_count
	if _, err := readAt(f, bs, header); err != nil {
		return nil, fmt.Errorf("%w: short %s header", ErrNoMP4Index, name)
	}
	count := binary.BigEndian.Uint32(header[4:8])
	if count == 0 {
		return nil, nil
	}
	if int64(count) > indexTableCap || int64(count)*8 > be-bs-8 {
		return nil, fmt.Errorf("%w: %s entry_count %d out of range", ErrNoMP4Index, name, count)
	}
	raw := make([]byte, int(count)*8)
	if _, err := readAt(f, bs+8, raw); err != nil {
		return nil, fmt.Errorf("%w: short %s table", ErrNoMP4Index, name)
	}
	out := make([]runEntry, count)
	for i := range out {
		out[i] = runEntry{
			count: binary.BigEndian.Uint32(raw[i*8 : i*8+4]),
			value: int32(binary.BigEndian.Uint32(raw[i*8+4 : i*8+8])),
		}
	}
	return out, nil
}

// readSyncSamples reads stss. A missing stss means every sample is a sync
// sample (all-intra); we materialise that list from totalSamples so callers
// get a uniform answer either way.
func readSyncSamples(f io.ReadSeeker, start, end int64, totalSamples int64) ([]uint32, error) {
	bs, be, err := findBox(f, start, end, "stss")
	if err != nil {
		if totalSamples <= 0 || totalSamples > indexTableCap {
			return nil, fmt.Errorf("%w: no stss and %d samples", ErrNoMP4Index, totalSamples)
		}
		all := make([]uint32, totalSamples)
		for i := range all {
			all[i] = uint32(i + 1)
		}
		return all, nil
	}
	header := make([]byte, 8)
	if _, err := readAt(f, bs, header); err != nil {
		return nil, fmt.Errorf("%w: short stss header", ErrNoMP4Index)
	}
	count := binary.BigEndian.Uint32(header[4:8])
	if count == 0 {
		return nil, nil
	}
	if int64(count) > indexTableCap || int64(count)*4 > be-bs-8 {
		return nil, fmt.Errorf("%w: stss entry_count %d out of range", ErrNoMP4Index, count)
	}
	raw := make([]byte, int(count)*4)
	if _, err := readAt(f, bs+8, raw); err != nil {
		return nil, fmt.Errorf("%w: short stss table", ErrNoMP4Index)
	}
	out := make([]uint32, count)
	for i := range out {
		out[i] = binary.BigEndian.Uint32(raw[i*4 : i*4+4])
	}
	return out, nil
}

// readMdhdTimescale pulls the media timescale from mdia/mdhd. All sample
// times in stts/ctts are expressed in these units.
func readMdhdTimescale(f io.ReadSeeker, start, end int64) (uint32, error) {
	bs, _, err := findPath(f, start, end, "mdia", "mdhd")
	if err != nil {
		return 0, fmt.Errorf("%w: trak has no mdhd", ErrNoMP4Index)
	}
	head := make([]byte, 4)
	if _, err := readAt(f, bs, head); err != nil {
		return 0, fmt.Errorf("%w: short mdhd", ErrNoMP4Index)
	}
	// v0: creation(4) modification(4) timescale(4); v1 widens the two times to 8.
	offset := int64(12)
	if head[0] == 1 {
		offset = 20
	}
	ts := make([]byte, 4)
	if _, err := readAt(f, bs+offset, ts); err != nil {
		return 0, fmt.Errorf("%w: short mdhd timescale", ErrNoMP4Index)
	}
	return binary.BigEndian.Uint32(ts), nil
}

// readMvhdTimescale returns the movie timescale from moov/mvhd. Edit-list
// segment durations are expressed in these units, unlike everything inside a
// track, which uses the media timescale from mdhd.
func readMvhdTimescale(f io.ReadSeeker, moovStart, moovEnd int64) (uint32, error) {
	bs, _, err := findBox(f, moovStart, moovEnd, "mvhd")
	if err != nil {
		return 0, fmt.Errorf("%w: moov has no mvhd", ErrNoMP4Index)
	}
	head := make([]byte, 4)
	if _, err := readAt(f, bs, head); err != nil {
		return 0, fmt.Errorf("%w: short mvhd", ErrNoMP4Index)
	}
	// v0: creation(4) modification(4) timescale(4); v1 widens the two times to 8.
	offset := int64(12)
	if head[0] == 1 {
		offset = 20
	}
	ts := make([]byte, 4)
	if _, err := readAt(f, bs+offset, ts); err != nil {
		return 0, fmt.Errorf("%w: short mvhd timescale", ErrNoMP4Index)
	}
	return binary.BigEndian.Uint32(ts), nil
}

// readEditList interprets a track's edit list, returning the media_time to
// subtract (in media timescale units) and any presentation delay contributed
// by leading empty edits (in seconds).
//
// The shape we accept is the one encoders actually emit: zero or more empty
// edits (media_time == -1, expressing start-up delay — a 2-entry list like
// [{23, -1}, {10730534, 12000}] is what FFmpeg writes for a B-frame stream),
// followed by exactly one real edit. Anything else is a genuine timeline
// remap, and we report ErrNoMP4Index so the caller runs the ffprobe scan
// rather than trusting a guess.
func readEditList(f io.ReadSeeker, start, end int64, movieTimescale uint32) (mediaTime int64, delaySec float64, err error) {
	bs, be, err := findPath(f, start, end, "edts", "elst")
	if err != nil {
		return 0, 0, nil // no edit list is the common case
	}
	header := make([]byte, 8)
	if _, err := readAt(f, bs, header); err != nil {
		return 0, 0, fmt.Errorf("%w: short elst", ErrNoMP4Index)
	}
	version := header[0]
	count := int64(binary.BigEndian.Uint32(header[4:8]))
	if count == 0 {
		return 0, 0, nil
	}

	// v0 entries are segment_duration(4) media_time(4) media_rate(4);
	// v1 widens the first two to 8 bytes each.
	stride := int64(12)
	if version == 1 {
		stride = 20
	}
	if count > 64 || bs+8+count*stride > be {
		return 0, 0, fmt.Errorf("%w: elst entry_count %d out of range", ErrNoMP4Index, count)
	}
	raw := make([]byte, count*stride)
	if _, err := readAt(f, bs+8, raw); err != nil {
		return 0, 0, fmt.Errorf("%w: short elst table", ErrNoMP4Index)
	}

	var emptyTicks int64
	seenReal := false
	for i := int64(0); i < count; i++ {
		e := raw[i*stride:]
		var dur, mt int64
		if version == 1 {
			dur = int64(binary.BigEndian.Uint64(e[0:8]))
			mt = int64(binary.BigEndian.Uint64(e[8:16]))
		} else {
			dur = int64(binary.BigEndian.Uint32(e[0:4]))
			mt = int64(int32(binary.BigEndian.Uint32(e[4:8])))
		}
		if mt < 0 {
			if seenReal {
				return 0, 0, fmt.Errorf("%w: empty edit after a real edit", ErrNoMP4Index)
			}
			emptyTicks += dur
			continue
		}
		if seenReal {
			return 0, 0, fmt.Errorf("%w: multiple real edit entries (%d)", ErrNoMP4Index, count)
		}
		mediaTime = mt
		seenReal = true
	}
	if emptyTicks > 0 {
		if movieTimescale == 0 {
			return 0, 0, fmt.Errorf("%w: empty edit with zero movie timescale", ErrNoMP4Index)
		}
		delaySec = float64(emptyTicks) / float64(movieTimescale)
	}
	return mediaTime, delaySec, nil
}

// --- ISO-BMFF box walking -------------------------------------------------

// walkBoxes calls fn for each box directly inside [start, end). fn receives the
// box type and the payload range (header already skipped). Returning true from
// fn stops the walk.
func walkBoxes(f io.ReadSeeker, start, end int64, fn func(typ string, payloadStart, payloadEnd int64) (bool, error)) error {
	pos := start
	for pos+8 <= end {
		header := make([]byte, 8)
		if _, err := readAt(f, pos, header); err != nil {
			return nil // truncated tail — treat as end of container
		}
		size := int64(binary.BigEndian.Uint32(header[0:4]))
		typ := string(header[4:8])
		payload := pos + 8

		switch {
		case size == 1:
			ext := make([]byte, 8)
			if _, err := readAt(f, pos+8, ext); err != nil {
				return nil
			}
			size = int64(binary.BigEndian.Uint64(ext))
			payload = pos + 16
		case size == 0:
			size = end - pos // extends to the end of the container
		}
		if size < 8 || pos+size > end {
			return nil // malformed or truncated — stop rather than misread
		}

		stop, err := fn(typ, payload, pos+size)
		if err != nil {
			return err
		}
		if stop {
			return nil
		}
		pos += size
	}
	return nil
}

// findBox returns the payload range of the first direct child box of the given
// type, or ErrNoMP4Index if absent.
func findBox(f io.ReadSeeker, start, end int64, name string) (int64, int64, error) {
	var fs, fe int64
	found := false
	err := walkBoxes(f, start, end, func(typ string, ps, pe int64) (bool, error) {
		if typ == name {
			fs, fe, found = ps, pe, true
			return true, nil
		}
		return false, nil
	})
	if err != nil {
		return 0, 0, err
	}
	if !found {
		return 0, 0, fmt.Errorf("%w: box %q not found", ErrNoMP4Index, name)
	}
	return fs, fe, nil
}

// findPath walks a chain of nested box types, e.g. ("mdia", "minf", "stbl").
func findPath(f io.ReadSeeker, start, end int64, path ...string) (int64, int64, error) {
	s, e := start, end
	for _, name := range path {
		var err error
		s, e, err = findBox(f, s, e, name)
		if err != nil {
			return 0, 0, err
		}
	}
	return s, e, nil
}

// collectBoxes returns the payload ranges of every direct child box of the
// given type.
func collectBoxes(f io.ReadSeeker, start, end int64, name string) ([][2]int64, error) {
	var out [][2]int64
	err := walkBoxes(f, start, end, func(typ string, ps, pe int64) (bool, error) {
		if typ == name {
			out = append(out, [2]int64{ps, pe})
		}
		return false, nil
	})
	return out, err
}

// readAt seeks and fills buf completely. The index boxes are small and read
// sequentially, so a plain Seek+ReadFull is both simplest and fast enough.
func readAt(f io.ReadSeeker, off int64, buf []byte) (int, error) {
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return 0, err
	}
	return io.ReadFull(f, buf)
}
