package transcoder

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"unsafe"
)

// ErrNoMP4Index reports that the source carries no usable ISO-BMFF sample
// index, so the caller must fall back to the ffprobe packet scan. Reasons
// include: a non-MP4 container, a fragmented MP4 (sample tables live in each
// moof, not in moov), a missing moov, or tables larger than indexTableCap.
//
// This is an expected outcome, not a failure — ReadKeyframeTimes is a fast
// path, and every caller has a working fallback.
var ErrNoMP4Index = errors.New("no usable mp4 sample index")

var errMP4NotVideo = fmt.Errorf("%w: not a video track", ErrNoMP4Index)

// errMP4BoxAbsent distinguishes optional absence from corruption while
// wrapping ErrNoMP4Index for existing fallback callers.
var errMP4BoxAbsent = fmt.Errorf("%w: box absent", ErrNoMP4Index)

// Individual count guards also bound cursor work. A shared byte budget below
// limits cumulative parser allocations across all tables and derived arrays.
const indexTableCap = 8 << 20
const indexAllocationCap int64 = 128 << 20
const indexScratchAllowance int64 = 16 << 10

type indexAllocationBudget struct{ remaining int64 }

func (b *indexAllocationBudget) charge(bytes int64) error {
	if bytes < 0 || bytes > b.remaining {
		return fmt.Errorf("%w: source index allocation budget exceeded", ErrNoMP4Index)
	}
	b.remaining -= bytes
	return nil
}

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
	times, _, err := readSourceIndex(path, nil)
	return times, err
}

func readSourceIndex(path string, hints *ProbeResult) ([]float64, CadenceInfo, error) {
	return readSourceIndexWithBudget(path, hints, indexAllocationCap)
}

// Byte cap injection is private and per call; tests never alter global policy.
// Charges are cumulative, including temporary raw tables that may await GC.
func readSourceIndexWithBudget(path string, hints *ProbeResult, maxBytes int64) ([]float64, CadenceInfo, error) {
	budget := &indexAllocationBudget{remaining: maxBytes}
	// Bounded headers, edit-list scratch and small cursor/closure overhead.
	if err := budget.charge(indexScratchAllowance); err != nil {
		return nil, CadenceInfo{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, CadenceInfo{}, fmt.Errorf("open source for index read: %w", err)
	}
	defer f.Close()

	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, CadenceInfo{}, fmt.Errorf("stat source for index read: %w", err)
	}

	moovStart, moovEnd, err := findBox(f, 0, size, "moov")
	if err != nil {
		return nil, CadenceInfo{}, err
	}

	// A fragmented MP4 declares mvex in moov and leaves the sample tables
	// empty — the real timing lives in every moof/traf/trun. Detect it up
	// front so we fall back instead of returning an empty keyframe list.
	if _, _, err := findBox(f, moovStart, moovEnd, "mvex"); err == nil {
		return nil, CadenceInfo{}, fmt.Errorf("%w: fragmented mp4 (moov/mvex present)", ErrNoMP4Index)
	} else if !errors.Is(err, errMP4BoxAbsent) {
		return nil, CadenceInfo{}, err
	}

	// The movie timescale governs edit-list durations, which are expressed in
	// movie units while everything inside the track is in media units.
	movieTimescale, err := readMvhdTimescale(f, moovStart, moovEnd)
	if err != nil {
		return nil, CadenceInfo{}, err
	}

	// Walk tracks without accumulating a second, unbounded metadata array.
	var times []float64
	var cadence CadenceInfo
	found := false
	err = walkBoxes(f, moovStart, moovEnd, func(typ string, start, end int64) (bool, error) {
		if typ != "trak" {
			return false, nil
		}
		var trackErr error
		times, cadence, trackErr = sourceIndexFromTrak(f, start, end, movieTimescale, hints, budget)
		if errors.Is(trackErr, errMP4NotVideo) {
			return false, nil
		}
		if trackErr != nil {
			return false, trackErr
		}
		found = true
		return true, nil
	})
	if err != nil {
		return nil, CadenceInfo{}, err
	}
	if !found {
		return nil, CadenceInfo{}, fmt.Errorf("%w: no video track with a sample table", ErrNoMP4Index)
	}
	return times, cadence, nil
}

// keyframeTimesFromTrak extracts sync-sample presentation times from one trak
// box, or ErrNoMP4Index if this trak is not a usable video track.
func keyframeTimesFromTrak(f io.ReadSeeker, start, end int64, movieTimescale uint32) ([]float64, error) {
	times, _, err := sourceIndexFromTrak(f, start, end, movieTimescale, nil, &indexAllocationBudget{remaining: indexAllocationCap - indexScratchAllowance})
	return times, err
}

func sourceIndexFromTrak(f io.ReadSeeker, start, end int64, movieTimescale uint32, hints *ProbeResult, budget *indexAllocationBudget) ([]float64, CadenceInfo, error) {
	// hdlr tells us whether this is the video track. Checking it (rather than
	// "the first trak that happens to have an stss") keeps us correct on files
	// whose audio track precedes the video track.
	hs, he, err := findPath(f, start, end, "mdia", "hdlr")
	if err != nil {
		return nil, CadenceInfo{}, fmt.Errorf("%w: trak has no mdia/hdlr", ErrNoMP4Index)
	}
	// hdlr layout: version+flags (4), pre_defined (4), handler_type (4).
	buf := make([]byte, 12)
	if _, err := readAt(f, hs, buf); err != nil || he-hs < 12 {
		return nil, CadenceInfo{}, fmt.Errorf("%w: short hdlr", ErrNoMP4Index)
	}
	if string(buf[8:12]) != "vide" {
		return nil, CadenceInfo{}, errMP4NotVideo
	}

	timescale, err := readMdhdTimescale(f, start, end)
	if err != nil {
		return nil, CadenceInfo{}, err
	}

	stblStart, stblEnd, err := findPath(f, start, end, "mdia", "minf", "stbl")
	if err != nil {
		return nil, CadenceInfo{}, fmt.Errorf("%w: trak has no stbl", ErrNoMP4Index)
	}

	stts, err := readRunTableWithBudget(f, stblStart, stblEnd, "stts", budget)
	if err != nil {
		return nil, CadenceInfo{}, err
	}
	if len(stts) == 0 {
		return nil, CadenceInfo{}, fmt.Errorf("%w: empty stts", ErrNoMP4Index)
	}

	totalSamples := int64(0)
	var decodeTicks int64
	for _, run := range stts {
		totalSamples += int64(run.count)
		step := int64(run.count) * run.value
		if step < 0 || decodeTicks > (1<<63-1)-step {
			return nil, CadenceInfo{}, fmt.Errorf("%w: stts timeline overflow", ErrNoMP4Index)
		}
		decodeTicks += step
	}

	sync, err := readSyncSamplesWithBudget(f, stblStart, stblEnd, totalSamples, budget)
	if err != nil {
		return nil, CadenceInfo{}, err
	}
	if len(sync) == 0 {
		return nil, CadenceInfo{}, fmt.Errorf("%w: no sync samples listed", ErrNoMP4Index)
	}

	// ctts is optional: absent means every composition offset is zero.
	ctts, err := readRunTableWithBudget(f, stblStart, stblEnd, "ctts", budget)
	if err != nil && !errors.Is(err, errMP4BoxAbsent) {
		return nil, CadenceInfo{}, err
	}

	if len(ctts) > 0 {
		var n int64
		for _, run := range ctts {
			n += int64(run.count)
		}
		if n != totalSamples {
			return nil, CadenceInfo{}, fmt.Errorf("%w: ctts sample count mismatch", ErrNoMP4Index)
		}
	}

	editOffset, presentationDelay, err := readEditList(f, start, end, movieTimescale)
	if err != nil {
		return nil, CadenceInfo{}, err
	}

	if err := budget.charge(int64(len(sync)) * 8); err != nil {
		return nil, CadenceInfo{}, err
	}
	// cadenceFromRuns expands only reordered timelines within its work cap.
	if len(ctts) > 0 && timescale > 0 && totalSamples >= 3 && totalSamples <= cadenceFrameCap {
		if err := budget.charge(totalSamples * 8); err != nil {
			return nil, CadenceInfo{}, err
		}
	}
	times, err := composeKeyframeTimes(stts, ctts, sync, editOffset, presentationDelay, timescale)
	if err != nil {
		return nil, CadenceInfo{}, err
	}
	return times, cadenceFromRuns(stts, ctts, timescale, hints), nil
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
		out = append(out, (float64(decode)+float64(cttsCur.peek())-float64(editOffset))/float64(timescale)+presentationDelay)

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
// ctts). int64 preserves unsigned stts and signed ctts-v1 values.
type runEntry struct {
	count uint32
	value int64
}

// readRunTable reads an stts or ctts box into run entries. Returns
// errMP4BoxAbsent only if absent; malformed and oversized boxes return
// ErrNoMP4Index without the absent sentinel.
func readRunTable(f io.ReadSeeker, start, end int64, name string) ([]runEntry, error) {
	return readRunTableWithBudget(f, start, end, name, &indexAllocationBudget{remaining: indexAllocationCap})
}

func readRunTableWithBudget(f io.ReadSeeker, start, end int64, name string, budget *indexAllocationBudget) ([]runEntry, error) {
	bs, be, err := findBox(f, start, end, name)
	if err != nil {
		return nil, err
	}
	if be-bs < 8 {
		return nil, fmt.Errorf("%w: short %s header", ErrNoMP4Index, name)
	}
	header := make([]byte, 8) // version+flags, entry_count
	if _, err := readAt(f, bs, header); err != nil {
		return nil, fmt.Errorf("%w: short %s header", ErrNoMP4Index, name)
	}
	if header[0] != 0 && !(name == "ctts" && header[0] == 1) {
		return nil, fmt.Errorf("%w: unsupported %s version", ErrNoMP4Index, name)
	}
	count := binary.BigEndian.Uint32(header[4:8])
	if count == 0 {
		if name == "ctts" {
			return nil, fmt.Errorf("%w: empty ctts", ErrNoMP4Index)
		}
		return nil, nil
	}
	if int64(count) > indexTableCap || int64(count)*8 > be-bs-8 {
		return nil, fmt.Errorf("%w: %s entry_count %d out of range", ErrNoMP4Index, name, count)
	}
	if err := budget.charge(int64(count) * (8 + int64(unsafe.Sizeof(runEntry{})))); err != nil {
		return nil, err
	}
	raw := make([]byte, int(count)*8)
	if _, err := readAt(f, bs+8, raw); err != nil {
		return nil, fmt.Errorf("%w: short %s table", ErrNoMP4Index, name)
	}
	out := make([]runEntry, count)
	for i := range out {
		out[i] = runEntry{
			count: binary.BigEndian.Uint32(raw[i*8 : i*8+4]),
			value: int64(binary.BigEndian.Uint32(raw[i*8+4 : i*8+8])),
		}
		if out[i].count == 0 || (name == "stts" && out[i].value == 0) {
			return nil, fmt.Errorf("%w: invalid %s run", ErrNoMP4Index, name)
		}
		// Version zero is unsigned in ISO BMFF, but some muxers store negative
		// offsets and FFmpeg interprets its high bit as signed. Do not guess which
		// convention this source intended: let the actual ffprobe decoder decide.
		if name == "ctts" && header[0] == 0 && out[i].value > 0x7fffffff {
			return nil, fmt.Errorf("%w: ambiguous high-bit ctts version 0 offset", ErrNoMP4Index)
		}
		if name == "ctts" && header[0] == 1 {
			out[i].value = int64(int32(uint32(out[i].value)))
		}
		// FFmpeg may discard a CTTS table containing extreme offsets. Defer
		// those files as well, so the native index never applies ignored timing.
		if name == "ctts" && (out[i].value > 1<<28 || out[i].value < -(1<<28)) {
			return nil, fmt.Errorf("%w: implausible ctts offset", ErrNoMP4Index)
		}
	}
	return out, nil
}

// readSyncSamples reads stss. A missing stss means every sample is a sync
// sample (all-intra); we materialise that list from totalSamples so callers
// get a uniform answer either way.
func readSyncSamples(f io.ReadSeeker, start, end int64, totalSamples int64) ([]uint32, error) {
	return readSyncSamplesWithBudget(f, start, end, totalSamples, &indexAllocationBudget{remaining: indexAllocationCap})
}

func readSyncSamplesWithBudget(f io.ReadSeeker, start, end int64, totalSamples int64, budget *indexAllocationBudget) ([]uint32, error) {
	bs, be, err := findBox(f, start, end, "stss")
	if err != nil {
		if !errors.Is(err, errMP4BoxAbsent) {
			return nil, err
		}
		if totalSamples <= 0 || totalSamples > indexTableCap {
			return nil, fmt.Errorf("%w: no stss and %d samples", ErrNoMP4Index, totalSamples)
		}
		if err := budget.charge(totalSamples * 4); err != nil {
			return nil, err
		}
		all := make([]uint32, totalSamples)
		for i := range all {
			all[i] = uint32(i + 1)
		}
		return all, nil
	}
	if be-bs < 8 {
		return nil, fmt.Errorf("%w: short stss header", ErrNoMP4Index)
	}
	header := make([]byte, 8)
	if _, err := readAt(f, bs, header); err != nil {
		return nil, fmt.Errorf("%w: short stss header", ErrNoMP4Index)
	}
	if header[0] != 0 {
		return nil, fmt.Errorf("%w: unsupported stss version", ErrNoMP4Index)
	}
	count := binary.BigEndian.Uint32(header[4:8])
	if count == 0 {
		return nil, nil
	}
	if int64(count) > indexTableCap || int64(count)*4 > be-bs-8 {
		return nil, fmt.Errorf("%w: stss entry_count %d out of range", ErrNoMP4Index, count)
	}
	if err := budget.charge(int64(count) * 8); err != nil {
		return nil, err
	}
	raw := make([]byte, int(count)*4)
	if _, err := readAt(f, bs+8, raw); err != nil {
		return nil, fmt.Errorf("%w: short stss table", ErrNoMP4Index)
	}
	out := make([]uint32, count)
	for i := range out {
		out[i] = binary.BigEndian.Uint32(raw[i*4 : i*4+4])
		if out[i] == 0 || int64(out[i]) > totalSamples || (i > 0 && out[i] <= out[i-1]) {
			return nil, fmt.Errorf("%w: invalid stss sample", ErrNoMP4Index)
		}
	}
	return out, nil
}

// readMdhdTimescale pulls the media timescale from mdia/mdhd. All sample
// times in stts/ctts are expressed in these units.
func readMdhdTimescale(f io.ReadSeeker, start, end int64) (uint32, error) {
	bs, be, err := findPath(f, start, end, "mdia", "mdhd")
	if err != nil {
		return 0, fmt.Errorf("%w: trak has no mdhd", ErrNoMP4Index)
	}
	if be-bs < 4 {
		return 0, fmt.Errorf("%w: short timescale header", ErrNoMP4Index)
	}
	head := make([]byte, 4)
	if _, err := readAt(f, bs, head); err != nil {
		return 0, fmt.Errorf("%w: short mdhd", ErrNoMP4Index)
	}
	if head[0] > 1 {
		return 0, fmt.Errorf("%w: unsupported timescale version", ErrNoMP4Index)
	}
	// v0: creation(4) modification(4) timescale(4); v1 widens the two times to 8.
	offset := int64(12)
	if head[0] == 1 {
		offset = 20
	}
	if be-bs < offset+4 {
		return 0, fmt.Errorf("%w: short timescale", ErrNoMP4Index)
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
	bs, be, err := findBox(f, moovStart, moovEnd, "mvhd")
	if err != nil {
		return 0, fmt.Errorf("%w: moov has no mvhd", ErrNoMP4Index)
	}
	if be-bs < 4 {
		return 0, fmt.Errorf("%w: short timescale header", ErrNoMP4Index)
	}
	head := make([]byte, 4)
	if _, err := readAt(f, bs, head); err != nil {
		return 0, fmt.Errorf("%w: short mvhd", ErrNoMP4Index)
	}
	if head[0] > 1 {
		return 0, fmt.Errorf("%w: unsupported timescale version", ErrNoMP4Index)
	}
	// v0: creation(4) modification(4) timescale(4); v1 widens the two times to 8.
	offset := int64(12)
	if head[0] == 1 {
		offset = 20
	}
	if be-bs < offset+4 {
		return 0, fmt.Errorf("%w: short timescale", ErrNoMP4Index)
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
		if !errors.Is(err, errMP4BoxAbsent) {
			return 0, 0, err
		}
		return 0, 0, nil // no edit list is the common case
	}
	if be-bs < 8 {
		return 0, 0, fmt.Errorf("%w: short elst header", ErrNoMP4Index)
	}
	header := make([]byte, 8)
	if _, err := readAt(f, bs, header); err != nil {
		return 0, 0, fmt.Errorf("%w: short elst", ErrNoMP4Index)
	}
	version := header[0]
	if version > 1 {
		return 0, 0, fmt.Errorf("%w: unsupported elst version", ErrNoMP4Index)
	}
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
		rateOffset := int64(8)
		if version == 1 {
			rateOffset = 16
		}
		if binary.BigEndian.Uint32(e[rateOffset:rateOffset+4]) != 0x00010000 {
			return 0, 0, fmt.Errorf("%w: unsupported edit media rate", ErrNoMP4Index)
		}
		if mt < -1 {
			return 0, 0, fmt.Errorf("%w: invalid edit media time", ErrNoMP4Index)
		}
		if mt < 0 {
			if seenReal {
				return 0, 0, fmt.Errorf("%w: empty edit after a real edit", ErrNoMP4Index)
			}
			if dur < 0 || emptyTicks > (1<<63-1)-dur {
				return 0, 0, fmt.Errorf("%w: edit duration overflow", ErrNoMP4Index)
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
	if !seenReal {
		return 0, 0, fmt.Errorf("%w: edit list contains no real edit", ErrNoMP4Index)
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
	if start < 0 || end < start {
		return fmt.Errorf("%w: invalid box range", ErrNoMP4Index)
	}
	pos := start
	for pos < end {
		if end-pos < 8 {
			return fmt.Errorf("%w: truncated box header", ErrNoMP4Index)
		}
		var header [8]byte
		if _, err := readAt(f, pos, header[:]); err != nil {
			return fmt.Errorf("%w: read box header: %v", ErrNoMP4Index, err)
		}
		size := uint64(binary.BigEndian.Uint32(header[0:4]))
		typ := string(header[4:8])
		headerSize := int64(8)
		if size == 1 {
			if end-pos < 16 {
				return fmt.Errorf("%w: truncated extended box header", ErrNoMP4Index)
			}
			var ext [8]byte
			if _, err := readAt(f, pos+8, ext[:]); err != nil {
				return fmt.Errorf("%w: read extended box header: %v", ErrNoMP4Index, err)
			}
			size = binary.BigEndian.Uint64(ext[:])
			headerSize = 16
		} else if size == 0 {
			size = uint64(end - pos)
		}
		if size < uint64(headerSize) || size > uint64(end-pos) {
			return fmt.Errorf("%w: invalid box size", ErrNoMP4Index)
		}
		boxEnd := pos + int64(size) // size is bounded by end-pos above.
		stop, err := fn(typ, pos+headerSize, boxEnd)
		if err != nil {
			return err
		}
		if stop {
			return nil
		}
		pos = boxEnd
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
		return 0, 0, fmt.Errorf("%w: box %q not found", errMP4BoxAbsent, name)
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
