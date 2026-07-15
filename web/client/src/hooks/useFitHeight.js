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
    ready: false, forKey: null, rowH: 0, stable: false,
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
      const same = f.forKey === key && f.pageSize === pageSize && Math.abs(f.rowH - rowH) < 0.6;
      if (same) return f.stable ? f : { ...f, stable: true };
      return { ready: true, forKey: key, pageSize, rowH, stable: false };
    });
  };
  useLayoutEffect(measure); // after every render; the guard prevents a state loop
  useEffect(() => {
    let t;
    const onResize = () => { clearTimeout(t); t = setTimeout(measure, 120); };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const fitReady = fit.ready && fit.forKey === key && fit.stable;
  return { cardRef, ready: fit.ready, stable: fit.stable, pageSize: fit.pageSize, rowH: fit.rowH, fitReady };
}
