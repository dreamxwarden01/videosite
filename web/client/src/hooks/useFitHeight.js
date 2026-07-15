import { useState, useEffect, useLayoutEffect, useRef } from 'react';

// Fit-to-height paging, lifted from CourseView. We measure only the AVAILABLE
// height (window − card top − `reserved`, once + on resize) against a REAL
// measured `.vs-cv-row`, and derive pageSize from avail/rowH. Deriving it
// (rather than storing it) means a `key` switch recomputes pageSize with the
// new rowH in the SAME render — no stale intermediate value that fires a
// second fetch.
//
// The caller supplies:
//   key      opaque string identifying the current list variant. When it
//            changes, the settle restarts (was CourseView's `tab`/`forTab`).
//   rowEst   rough initial row-height estimate, used only for the first paint
//            before a real row is measured (was ROW_EST_VIDEO/ROW_EST_MATERIAL).
//   reserved space below the card to leave for the pager strip + margins.
//
// Returns { cardRef, ready, stable, pageSize, rowH, fitReady }:
//   cardRef   attach to the list card (its `.vs-cv-row`s are measured).
//   ready     a first real measurement has landed.
//   stable    the two-phase settle has agreed twice (fetch-ready).
//   pageSize  rows that fit; clamped to [3, 40].
//   rowH      the measured row height (0 before the first measure).
//   fitReady  ready && the settled measurement matches the current key & stable
//             — the flag the caller should gate its server fetch on.
export default function useFitHeight({ key, rowEst, reserved = 88 }) {
  const cardRef = useRef(null);
  const [fit, setFit] = useState(() => ({
    ready: false, forKey: null, rowH: 0, stable: false, tries: 0,
    pageSize: Math.max(3, Math.min(40, Math.floor((window.innerHeight - 240) / rowEst))),
  }));
  const measure = () => {
    const card = cardRef.current;
    if (!card) return;
    const row = card.querySelector('.vs-cv-row');
    const rowH = row ? row.getBoundingClientRect().height : 0;
    if (!rowH) return;
    const avail = window.innerHeight - card.getBoundingClientRect().top - reserved;
    const pageSize = Math.max(3, Math.min(40, Math.floor(avail / rowH)));
    // Two-phase settle: a measurement only becomes `stable` (fetch-ready) once
    // two consecutive measures agree. The skeleton→real render can shift the
    // measured pageSize by a row, so settling first means the server fetch
    // fires ONCE with the final pageSize instead of skeleton-size then
    // real-size (the limit=6-then-7 double request). Returning the SAME `f`
    // reference when nothing changed avoids a re-render loop.
    setFit((f) => {
      // Once a value exists for this key, KEEP it through ±1 pageSize + sub-pixel
      // rowH jitter. On mobile the dynamic viewport (URL bar) nudges `avail` and
      // flips pageSize by ±1 between measures; re-deriving pageSize on every
      // flicker re-fires the caller's server fetch, and a fetch cancelled
      // mid-flight never clears its `loading` — so the skeleton sticks (seen on
      // Chrome Android / Safari, fine on desktop). Keeping the settled pageSize
      // stops the churn; only a real change (orientation, >1 row) re-settles.
      const close = f.forKey === key && f.ready
        && Math.abs(f.pageSize - pageSize) <= 1 && Math.abs(f.rowH - rowH) < 1.5;
      if (close) return f.stable ? f : { ...f, stable: true, tries: 0 };
      // A larger change re-settles; cap the settle so a wilder oscillation still
      // can't hang fitReady forever.
      const tries = (f.forKey === key ? f.tries : 0) + 1;
      return { ready: true, forKey: key, pageSize, rowH, stable: tries >= 3, tries };
    });
  };
  // Re-measure after each render ONLY until settled for this key. Once stable, a
  // render must NOT re-measure: an unstable rowH from a layout reflow (the
  // sub-460px stuck-skeleton — the row wraps/changes height near that breakpoint)
  // would otherwise churn pageSize on every render and re-fire the caller's fetch
  // into a cancel loop that never clears `loading`. A window resize (orientation /
  // crossing the breakpoint) still re-settles via the listener below.
  useLayoutEffect(() => {
    if (fit.forKey === key && fit.stable) return;
    measure();
  });
  useEffect(() => {
    let t;
    const onResize = () => { clearTimeout(t); t = setTimeout(measure, 120); };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitReady = fit.ready && fit.forKey === key && fit.stable;
  return { cardRef, ready: fit.ready, stable: fit.stable, pageSize: fit.pageSize, rowH: fit.rowH, fitReady };
}
