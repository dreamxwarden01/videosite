package ui

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"videosite-worker/internal/util"

	"golang.org/x/term"
)

// ANSI escape sequences used to keep a sticky bar region pinned at the bottom
// of the terminal with the user's typing line just above it.
//
// Core trick — DECSTBM (`ESC[t;br`): set a scrolling region of rows t..b. Any
// newline that reaches the bottom of that region scrolls within it without
// disturbing the rows outside. We reserve the bottom K rows for K bars, so
// log lines and user typing scroll within rows 1..(h-K) while the bar rows
// stay put and are repainted in place.
//
// Cursor discipline — the "entry line" is the bottom row of the scroll
// region (row h-K). When bars first appear we scroll existing content up K
// lines to make room, then explicitly move the cursor to (h-K, 1). From
// there the cursor lives inside the scroll region and the usual
// DECSC / DECRC dance around each bar repaint keeps it undisturbed during
// progress updates.
const (
	escSaveCursor    = "\x1b7"     // DECSC — save cursor position
	escRestoreCursor = "\x1b8"     // DECRC — restore cursor position
	escClearLine     = "\x1b[2K"   // EL   — clear entire line
	escClearBelow    = "\x1b[0J"   // ED   — clear from cursor to end of screen
	escHideCursor    = "\x1b[?25l" // DECTCEM off
	escShowCursor    = "\x1b[?25h" // DECTCEM on
	escResetScroll   = "\x1b[r"    // DECSTBM reset — full-screen scrolling
)

// ttyBar is one pinned bar's state. stage is updated by UpdateStage, pct by
// UpdateStageProgress, both from job goroutines. Render reads them under the
// same atomics.
type ttyBar struct {
	jobID    string
	priority int64        // stable ascending lease order (bar sort key)
	stage    atomic.Value // string — current stage label
	pct      atomic.Int32 // 0..100 local pct within current stage
}

// ttyManager owns the bottom-pinned sticky region. Every write to stdout
// goes through writeMu so log lines and bar repaints never interleave.
type ttyManager struct {
	out   *os.File
	outFd int

	writeMu sync.Mutex // serializes all writes to m.out
	barsMu  sync.Mutex // protects bars map (held only briefly for snapshots)
	bars    map[string]*ttyBar
	seq     atomic.Int64

	refreshCh chan struct{} // coalesced render nudge
	stopCh    chan struct{}
	wg        sync.WaitGroup
	closed    atomic.Bool

	// lastK is the number of bar rows pinned on the previous render. Used to
	// detect enter-region / exit-region / count-change transitions so we can
	// scroll content up (grow), clear orphan rows (shrink), and reposition
	// the cursor at the new entry line.
	//
	// Atomic because Logf / Write read it (to decide whether to re-assert
	// DECSTBM before writing) from non-render goroutines, while render
	// updates it. Torn reads would cause assertRegion to emit the wrong
	// scrollBot row.
	lastK atomic.Int32
	// lastH, lastW track the terminal dimensions at the previous render.
	// On resize either the old bar positions (height change) or the old
	// bar widths (which, combined with terminal reflow, can leave wrap
	// tails in unexpected rows) become stale; we clear them and force a
	// fresh ENTER on the next tick.
	lastH atomic.Int32
	lastW atomic.Int32

	// dirty is bumped by every state-changing call (StartJob, UpdateStage,
	// UpdateStageProgress, FinishJob). render() compares it to its private
	// lastDirty and skips the entire repaint when nothing changed AND the
	// terminal hasn't resized AND the bar count is stable. Idle ticks (the
	// 4Hz keep-alive) thus produce zero bytes on the wire, eliminating the
	// "the bar area twitches every quarter-second on conhost" class of
	// flicker. Resize and lastK transitions are always allowed through
	// (their handling in render() doesn't depend on dirty).
	dirty atomic.Int64
}

// newTTY enables VT on Windows, starts the render loop. out is typically
// os.Stdout.
//
// Returns an error when enableVT fails (very old Windows conhost without
// ENABLE_VIRTUAL_TERMINAL_PROCESSING support, or an SSH session through a
// client that doesn't propagate VT). Callers are expected to fall back to
// plain-line mode rather than launch a TTY manager that would paint raw
// escape sequences as visible garbage. On Unix enableVT is a no-op and
// always returns nil, so this never errs there.
func newTTY(out *os.File) (*ttyManager, error) {
	if err := enableVT(out.Fd()); err != nil {
		return nil, err
	}
	m := &ttyManager{
		out:       out,
		outFd:     int(out.Fd()),
		bars:      make(map[string]*ttyBar),
		refreshCh: make(chan struct{}, 1),
		stopCh:    make(chan struct{}),
	}
	m.wg.Add(1)
	go m.renderLoop()
	return m, nil
}

// requestRender coalesces up to one pending render request. Called from
// every job-facing mutation so state-change-visible events paint without
// waiting for the next periodic tick.
func (m *ttyManager) requestRender() {
	if m.closed.Load() {
		return
	}
	select {
	case m.refreshCh <- struct{}{}:
	default:
	}
}

// renderLoop ticks at 4Hz and also wakes on any requestRender nudge.
//
// lastDirty is the value of m.dirty observed at the previous *non-skipped*
// render. We pass it into render() so it can fast-skip when nothing has
// changed since then. Keeping it in this loop's stack rather than as
// another atomic on the manager makes the data ownership obvious — only
// the render goroutine reads or writes it.
func (m *ttyManager) renderLoop() {
	defer m.wg.Done()
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	var lastDirty int64
	for {
		select {
		case <-m.stopCh:
			return
		case <-t.C:
			lastDirty = m.render(lastDirty)
		case <-m.refreshCh:
			lastDirty = m.render(lastDirty)
		}
	}
}

// render is the core of the scroll-region state machine. Only called from
// the render loop (serialized) so `m.lastK` is read and written without
// further locking. Four transitions:
//
//	k == 0 && lastK > 0 : EXIT — reset scroll region, clear the bar rows,
//	                       park cursor at the entry line, show cursor.
//	                       Returns early; no common paint tail.
//	k > 0 && lastK == 0 : ENTER — scroll content up k lines, install
//	                       scroll region (1..h-k), park cursor at scrollBot.
//	k > lastK           : GROW — scroll old region by (k - lastK) lines,
//	                       install new region, park cursor at new scrollBot.
//	k < lastK           : SHRINK — clear orphaned bar rows that are no
//	                       longer pinned, install new region, park.
//	k == lastK          : STEADY — common paint tail only (save / DECSTBM /
//	                       wipe / paint / restore).
//
// All non-EXIT branches fall through to the common paint tail.
func (m *ttyManager) render(lastDirty int64) int64 {
	if m.closed.Load() {
		return lastDirty
	}

	w, h, err := term.GetSize(m.outFd)
	if err != nil || w <= 0 || h <= 0 {
		return lastDirty
	}

	// Resize detection. On legacy conhost (Windows PowerShell) resizing
	// the window resets DECSTBM to full-screen, so between our last
	// render and the next tick any log that fires writes into the "bar
	// area" and any terminal-side reflow drops old bar fragments into
	// the scroll region. assertRegion() (below) closes most of that gap
	// by re-asserting DECSTBM before every log write, but we still need
	// to clean up stale bar positions on resize — old absolute rows no
	// longer align with the new h, and old bar widths don't match the
	// new w.
	//
	// Width *grow* (oldW < w) is intentionally excluded from the heavy
	// resize-clear branch: the new bar is wider than the old one, so the
	// STEADY repaint path (ED of the bar area + re-emit) overwrites the
	// old text cleanly with no wrap fragments to mop up. The previous
	// iteration treated any width delta as resize, which caused a
	// cosmetic "the whole region jumps down a line" flicker every time
	// the user widened the terminal. Width *shrink* (oldW > w) still
	// triggers the clear branch because legacy conhost can leave wrap
	// fragments of the now-too-wide bar on rows above the bar area.
	oldH := int(m.lastH.Load())
	oldW := int(m.lastW.Load())
	m.lastH.Store(int32(h))
	m.lastW.Store(int32(w))
	lastK := int(m.lastK.Load())

	m.barsMu.Lock()
	bars := make([]*ttyBar, 0, len(m.bars))
	for _, b := range m.bars {
		bars = append(bars, b)
	}
	m.barsMu.Unlock()
	sort.SliceStable(bars, func(i, j int) bool {
		return bars[i].priority < bars[j].priority
	})
	k := len(bars)

	// Guardrail: tiny terminal. Drop to k=0 behaviour so the scroll region
	// doesn't collapse to nothing.
	if k > 0 && h <= k+1 {
		k = 0
		bars = nil
	}

	resized := (oldH != 0 && oldH != h) || (oldW != 0 && oldW > w)

	// Idle-tick fast skip. If no bar state has changed since our last
	// non-skipped render AND the bar count is identical AND the terminal
	// hasn't been resized, the on-screen result would be byte-for-byte
	// identical. Emitting it anyway is what produced the "bar area
	// twitches every quarter-second" class of flicker on legacy conhost
	// — even an identical repaint causes a visible flash because the
	// terminal isn't double-buffered.
	curDirty := m.dirty.Load()
	if !resized && k == lastK && curDirty == lastDirty {
		return curDirty
	}

	// Resize with active bars: clear the old bar positions plus the rows
	// above them (where width-shrink wrap fragments may sit), reset the
	// scroll region, and start fresh. Next tick takes the ENTER path with
	// clean state.
	//
	// Cleanup uses ED (`\x1b[0J`) from one row above the old bar area
	// down to the bottom of the screen rather than per-row EL of the
	// exact old bar positions. Two failure modes the per-row approach
	// missed: width-shrink reflow leaving wrap tails on rows above the
	// bars, and vertical-shrink leaving stale bar text in the new
	// visible area at rows we wouldn't have iterated (because oldH-lastK
	// no longer maps onto the new viewport). ED handles both in one go
	// because it ignores the scroll region and respects current cursor
	// position.
	if resized && lastK > 0 {
		var buf bytes.Buffer
		buf.WriteString(escHideCursor)
		buf.WriteString(escResetScroll)
		firstRow := oldH - lastK
		if firstRow < 1 {
			firstRow = 1
		}
		if firstRow > h {
			firstRow = h
		}
		fmt.Fprintf(&buf, "\x1b[%d;1H", firstRow)
		buf.WriteString(escClearBelow)
		buf.WriteString(escShowCursor)
		m.writeMu.Lock()
		_, _ = m.out.Write(buf.Bytes())
		m.writeMu.Unlock()
		m.lastK.Store(0)
		// Nudge the next render so we repaint promptly rather than
		// waiting for the next 250ms tick.
		select {
		case m.refreshCh <- struct{}{}:
		default:
		}
		return curDirty
	}

	// Fast path: nothing to draw and nothing reserved.
	if k == 0 && lastK == 0 {
		return curDirty
	}

	var buf bytes.Buffer
	buf.WriteString(escHideCursor)

	switch {
	case k == 0 && lastK > 0:
		// EXIT — release the scroll region, clear the rows we pinned,
		// park the cursor at the entry line so the next log line lands
		// on the row that was just above the bar area.
		buf.WriteString(escResetScroll)
		for i := 0; i < lastK; i++ {
			row := h - lastK + 1 + i
			fmt.Fprintf(&buf, "\x1b[%d;1H", row)
			buf.WriteString(escClearLine)
		}
		entryRow := h - lastK
		if entryRow < 1 {
			entryRow = 1
		}
		fmt.Fprintf(&buf, "\x1b[%d;1H", entryRow)
		buf.WriteString(escShowCursor)
		m.writeMu.Lock()
		_, _ = m.out.Write(buf.Bytes())
		m.writeMu.Unlock()
		m.lastK.Store(0)
		return curDirty
	case k > 0 && lastK == 0:
		// ENTER — first bars. Scroll the entire screen up by k lines so
		// rows h-k+1..h become the bar area, then install DECSTBM.
		fmt.Fprintf(&buf, "\x1b[%d;1H", h)
		for i := 0; i < k; i++ {
			buf.WriteByte('\n')
		}
		scrollBot := h - k
		fmt.Fprintf(&buf, "\x1b[1;%dr", scrollBot)
		fmt.Fprintf(&buf, "\x1b[%d;1H", scrollBot)
	case k > lastK:
		// GROW — extend the bar area. Scroll within the old region
		// (1..h-lastK) so the existing bars don't get pushed off-screen
		// or overwritten by the scroll.
		delta := k - lastK
		oldScrollBot := h - lastK
		fmt.Fprintf(&buf, "\x1b[%d;1H", oldScrollBot)
		for i := 0; i < delta; i++ {
			buf.WriteByte('\n')
		}
		scrollBot := h - k
		fmt.Fprintf(&buf, "\x1b[1;%dr", scrollBot)
		fmt.Fprintf(&buf, "\x1b[%d;1H", scrollBot)
	case k < lastK:
		// SHRINK — fewer bars than before. Clear the orphaned rows
		// (rows that were bars but are now inside the new scroll region)
		// then install the new region.
		scrollBot := h - k
		for row := h - lastK + 1; row <= scrollBot; row++ {
			fmt.Fprintf(&buf, "\x1b[%d;1H", row)
			buf.WriteString(escClearLine)
		}
		fmt.Fprintf(&buf, "\x1b[1;%dr", scrollBot)
		fmt.Fprintf(&buf, "\x1b[%d;1H", scrollBot)
	}

	// Common paint tail. Cursor was either left wherever a Logf parked it
	// (STEADY path) or moved to scrollBot by the switch above. Either way,
	// save → DECSTBM → paint → restore puts it back so the user's typing
	// column survives every progress tick.
	buf.WriteString(escSaveCursor)

	// Re-issue DECSTBM every render — cheap on the wire and handles
	// terminal-resize cases plus the legacy-conhost resize-clobbers-DECSTBM
	// quirk (assertRegion() on log writes covers the in-between).
	scrollBot := h - k
	fmt.Fprintf(&buf, "\x1b[1;%dr", scrollBot)

	// Wipe the bar area in one go and repaint. ED ignores the scroll
	// region so a single write clears every bar row plus any stale wrap
	// fragments that may sit below them.
	fmt.Fprintf(&buf, "\x1b[%d;1H", scrollBot+1)
	buf.WriteString(escClearBelow)

	for i, b := range bars {
		row := scrollBot + 1 + i
		fmt.Fprintf(&buf, "\x1b[%d;1H", row)
		buf.WriteString(b.render(w))
	}

	buf.WriteString(escRestoreCursor)
	buf.WriteString(escShowCursor)

	m.writeMu.Lock()
	_, _ = m.out.Write(buf.Bytes())
	m.writeMu.Unlock()

	m.lastK.Store(int32(k))
	return curDirty
}

// assertRegion returns a byte prefix that re-asserts DECSTBM (save cursor →
// set scroll region → restore cursor) if bars are currently pinned.
// Intended to be prepended to every log write.
//
// Rationale: legacy Windows conhost (the console host used by PowerShell
// 5.1 and cmd.exe on older builds) silently resets DECSTBM to full-screen
// whenever the terminal is resized. Between that reset and our next render
// tick (up to 250ms), any log line that fires would land outside the scroll
// region — i.e. directly into what the user perceives as the bar area. The
// symptom was bar fragments jumbled in with log text after a resize.
//
// By prepending this save/DECSTBM/restore dance to every log write we close
// the gap: even mid-resize, the log lands in the correct region. The
// restore-cursor keeps the user's typing cursor (and column) undisturbed.
//
// Returns nil when no bars are pinned, when the terminal size can't be
// read, or when the computed scroll bottom is invalid — the caller should
// write raw in that case.
func (m *ttyManager) assertRegion() []byte {
	lastK := int(m.lastK.Load())
	if lastK == 0 {
		return nil
	}
	_, h, err := term.GetSize(m.outFd)
	if err != nil || h <= 0 {
		return nil
	}
	scrollBot := h - lastK
	if scrollBot < 1 {
		return nil
	}
	var buf bytes.Buffer
	buf.WriteString(escSaveCursor)
	fmt.Fprintf(&buf, "\x1b[1;%dr", scrollBot)
	buf.WriteString(escRestoreCursor)
	return buf.Bytes()
}

// render formats a single bar row. Format:
//
//	[<jobID>] <stage> <NNN>% [████████░░░░░░░░…]
//
// The bar filler stretches to fill whatever width is left after the prefix.
// `%3d%%` right-aligns the percent so single / double / triple digits don't
// move the bar's left bracket horizontally.
//
// IMPORTANT: we paint `width - 1` columns, never `width`. Writing a char in
// the last column of a row puts most terminals (Windows Terminal included)
// into a "pending wrap" state: the cursor is visually still on that row,
// but the next printable character — or in some cases a subsequent cursor
// move — advances to the next line. During a multi-bar paint, that pending
// state can shove bar N+1 down one row, and at the bottom of the screen it
// can trigger a viewport scroll that moves the whole bar region up by one.
// The symptom was long, skinny ghost-bars accumulating below the real
// bars when the terminal was resized narrower. Leaving a one-column buffer
// eliminates the whole class of wrap side effects.
func (b *ttyBar) render(width int) string {
	safe := width - 1
	if safe < 1 {
		return ""
	}
	stage, _ := b.stage.Load().(string)
	pct := int(b.pct.Load())
	if pct < 0 {
		pct = 0
	} else if pct > 100 {
		pct = 100
	}
	prefix := fmt.Sprintf("[%s] %s %3d%% ", b.jobID, stage, pct)
	if len(prefix) >= safe {
		return prefix[:safe]
	}
	barSpace := safe - len(prefix)
	if barSpace < 3 {
		return prefix + strings.Repeat(" ", barSpace)
	}
	fillWidth := barSpace - 2 // reserve `[` and `]`
	filled := pct * fillWidth / 100
	if filled > fillWidth {
		filled = fillWidth
	}
	var sb strings.Builder
	// 4 bytes per block char worst-case (UTF-8) + prefix ASCII + brackets.
	sb.Grow(len(prefix) + 2 + fillWidth*4)
	sb.WriteString(prefix)
	sb.WriteByte('[')
	for i := 0; i < filled; i++ {
		sb.WriteString("█")
	}
	for i := filled; i < fillWidth; i++ {
		sb.WriteString("░")
	}
	sb.WriteByte(']')
	return sb.String()
}

// StartJob registers a new bar. leasedAt is stored but not currently
// consumed — ordering is handled by seq (monotonically increasing per call,
// which matches real lease order).
func (m *ttyManager) StartJob(jobID string, leasedAt time.Time, profiles []string, normOn bool) {
	if m.closed.Load() {
		return
	}
	m.barsMu.Lock()
	if _, exists := m.bars[jobID]; exists {
		m.barsMu.Unlock()
		return
	}
	seq := m.seq.Add(1)
	b := &ttyBar{jobID: jobID, priority: seq}
	b.stage.Store("queued")
	m.bars[jobID] = b
	m.barsMu.Unlock()
	m.dirty.Add(1)

	m.Logf("%s", formatLeaseLog(jobID, profiles, normOn))
	m.requestRender()
	_ = leasedAt
}

// UpdateStage swaps the bar label and resets the local pct to 0. Also logs
// the transition with the global pct so the audit trail records it.
func (m *ttyManager) UpdateStage(jobID, stage string, globalPct int) {
	if m.closed.Load() {
		return
	}
	m.barsMu.Lock()
	b, ok := m.bars[jobID]
	m.barsMu.Unlock()
	if !ok {
		return
	}
	b.stage.Store(stage)
	b.pct.Store(0)
	m.dirty.Add(1)

	m.Logf("[%s] → %s (global: %d%%)", jobID, stage, globalPct)
	m.requestRender()
}

// LogStageBoundary emits the same audit line as UpdateStage but leaves the
// bar untouched. See ui.Manager docs.
func (m *ttyManager) LogStageBoundary(jobID, stage string, globalPct int) {
	if m.closed.Load() {
		return
	}
	m.Logf("[%s] → %s (global: %d%%)", jobID, stage, globalPct)
}

// UpdateStageProgress stores the new pct. No log line, no guaranteed
// immediate repaint — called at ffmpeg-frame / R2-part granularity and
// picked up by the next render tick (at most 250ms away).
func (m *ttyManager) UpdateStageProgress(jobID string, localPct int) {
	if m.closed.Load() {
		return
	}
	if localPct < 0 {
		localPct = 0
	} else if localPct > 100 {
		localPct = 100
	}
	m.barsMu.Lock()
	b, ok := m.bars[jobID]
	m.barsMu.Unlock()
	if !ok {
		return
	}
	b.pct.Store(int32(localPct))
	m.dirty.Add(1)
}

// FinishJob drops the bar and emits a final log line. The render loop
// will pick up the reduced bar count on its next tick (which is also
// nudged here via requestRender).
func (m *ttyManager) FinishJob(jobID string, reason string) {
	m.barsMu.Lock()
	_, ok := m.bars[jobID]
	if ok {
		delete(m.bars, jobID)
	}
	m.barsMu.Unlock()
	if ok {
		m.dirty.Add(1)
	}

	m.Logf("[%s] %s", jobID, reason)
	m.requestRender()
}

// Logf writes one timestamped log line. Output lands wherever the cursor is
// — which, thanks to the scroll region + cursor discipline in render, is
// always inside 1..(h-K) — so log lines scroll through the upper region
// without touching bars.
//
// assertRegion() is prepended so a resize-induced DECSTBM reset (common on
// legacy Windows conhost) doesn't cause this log line to land in the bar
// area between renders.
//
// After Close the render loop is gone; writes fall through to the raw file.
func (m *ttyManager) Logf(format string, args ...interface{}) {
	line := util.Ts() + " " + fmt.Sprintf(format, args...) + "\n"
	prefix := m.assertRegion()
	m.writeMu.Lock()
	if prefix != nil {
		_, _ = m.out.Write(prefix)
	}
	_, _ = io.WriteString(m.out, line)
	m.writeMu.Unlock()
}

// Write is the io.Writer interface for slog.Handler routing. Each call is
// treated as one or more already-formatted log lines. A trailing newline is
// added if missing so the next write doesn't glue onto this one.
//
// Same assertRegion prefix as Logf — the slog handler doesn't know anything
// about bars, so we protect it here.
func (m *ttyManager) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	prefix := m.assertRegion()
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	if prefix != nil {
		_, _ = m.out.Write(prefix)
	}
	if p[len(p)-1] != '\n' {
		n, err := m.out.Write(p)
		if err != nil {
			return n, err
		}
		_, _ = m.out.Write([]byte{'\n'})
		return n, nil
	}
	return m.out.Write(p)
}

// Close stops the render loop and leaves the terminal in a sane state for
// whatever prints next (normally a shell prompt).
//
// Two cases:
//
//  1. lastK > 0 — bars are still pinned at the moment of Close. Reset the
//     scroll region to full-screen, clear every bar row, park the cursor
//     on the row just above where the bar area was. Shell prompt drops
//     directly below the last log line.
//
//  2. lastK == 0 — no bars currently pinned; full-screen is already the
//     state. Just re-show the cursor in case a render had it hidden.
//     Emitting `\x1b[r` here would home the cursor to (1,1) as a DECSTBM
//     side effect — bouncing the shell prompt up to the top of the
//     screen and overwriting worker output. So we do nothing else.
func (m *ttyManager) Close() {
	if !m.closed.CompareAndSwap(false, true) {
		return
	}
	close(m.stopCh)
	m.wg.Wait()

	lastK := int(m.lastK.Load())
	var buf bytes.Buffer
	if lastK > 0 {
		if _, h, err := term.GetSize(m.outFd); err == nil && h > 0 {
			buf.WriteString(escResetScroll) // homes cursor to (1,1); we reposition below
			for i := 0; i < lastK; i++ {
				row := h - lastK + 1 + i
				fmt.Fprintf(&buf, "\x1b[%d;1H", row)
				buf.WriteString(escClearLine)
			}
			entryRow := h - lastK
			if entryRow < 1 {
				entryRow = 1
			}
			fmt.Fprintf(&buf, "\x1b[%d;1H", entryRow)
		}
	}
	buf.WriteString(escShowCursor)

	m.writeMu.Lock()
	_, _ = m.out.Write(buf.Bytes())
	m.writeMu.Unlock()
}

// Compile-time assertion: ttyManager satisfies Manager.
var _ Manager = (*ttyManager)(nil)

