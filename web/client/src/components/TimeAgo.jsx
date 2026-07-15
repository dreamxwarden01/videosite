import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import { relTime, exactTime } from '../utils/timeFormat';

// A relative "… ago" label whose exact local timestamp shows in a custom
// tooltip — the native title= tooltip has a ~1s show delay, too slow here.
// The tip is fixed-positioned (escapes the modal's overflow clip), placed above
// the anchor and flipped below / clamped horizontally when it would leave the
// viewport. Works on touch: tap toggles it, a tap anywhere else dismisses it.
export default function TimeAgo({ iso }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const tipRef = useRef(null);

  const place = useCallback(() => {
    const a = anchorRef.current, t = tipRef.current;
    if (!a || !t) return;
    const ar = a.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const M = 8, GAP = 6;
    // Centre horizontally on the anchor, then clamp inside the viewport.
    let left = ar.left + ar.width / 2 - tr.width / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - tr.width - M));
    // Prefer above; flip below if it would clip the top; clamp to the bottom.
    let top = ar.top - tr.height - GAP;
    if (top < M) top = ar.bottom + GAP;
    top = Math.max(M, Math.min(top, window.innerHeight - tr.height - M));
    setPos({ left, top });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const reflow = () => place();
    // A tap/click outside the anchor dismisses (touch-friendly).
    const onDown = (e) => { if (anchorRef.current && !anchorRef.current.contains(e.target)) setOpen(false); };
    window.addEventListener('scroll', reflow, true);
    window.addEventListener('resize', reflow);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', reflow, true);
      window.removeEventListener('resize', reflow);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, place]);

  if (!iso) return null;

  return (
    <>
      <span
        ref={anchorRef}
        className="vs-ps-time"
        tabIndex={0}
        role="button"
        aria-label={exactTime(iso)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >{relTime(iso)}</span>
      {open && (
        <div ref={tipRef} className="vs-tip" role="tooltip"
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
          {exactTime(iso)}
        </div>
      )}
    </>
  );
}
