import { useEffect, useRef } from 'react';

export default function PlaybackDisabledBanner() {
  const spanRef = useRef(null);

  // CSS can't shrink a wrapping inline-block to the width of its longest
  // rendered line — it always fills the container once the copy exceeds
  // one line. Measure the rendered line widths via Range, then set the
  // span's width to the widest line so `text-align: center` on the parent
  // can actually center the block while lines stay left-aligned inside.
  useEffect(() => {
    const span = spanRef.current;
    if (!span) return;
    const fit = () => {
      span.style.width = '';
      const range = document.createRange();
      range.selectNodeContents(span);
      const rects = range.getClientRects();
      if (!rects.length) return;
      let max = 0;
      for (const r of rects) if (r.width > max) max = r.width;
      span.style.width = `${Math.ceil(max)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (span.parentElement) ro.observe(span.parentElement);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="playback-disabled-banner" role="alert">
      <svg
        className="playback-disabled-banner-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          d="M12 2L1.5 21h21L12 2z"
          fill="currentColor"
        />
        <rect x="11" y="9" width="2" height="6.5" rx="1" fill="#fff" />
        <rect x="11" y="17" width="2" height="2" rx="1" fill="#fff" />
      </svg>
      <div className="playback-disabled-banner-message">
        <span ref={spanRef}>Playback disabled on this account. Contact system administration if you require access.</span>
      </div>
    </div>
  );
}
