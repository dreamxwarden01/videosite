import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The floating save bar. Two modes:
 *   - Bare (no `items`): Discard + Save only — the course-edit modal and the
 *     user-edit permissions pane use this.
 *   - Tagged (`items` = [{ label, tone? }]): the account-portal SaveBar behaviour
 *     ported over — a staged-change count + as many tags as fit, the rest folded
 *     into "+N more…", clickable to pop the folded list above the bar. `tone`
 *     ('add' | 'remove') colours the chip (enrollment); omit for a neutral chip.
 *
 * Sticky inside its padded, bounded-height scroll parent (.vs-split-pane). The
 * pop-list is a SIBLING of the bar (not a child) so the bar's backdrop-filter
 * doesn't become the list's backdrop root and break its frost.
 */
export default function VsSaveBar({ visible, busy, onSave, onDiscard, saveLabel = 'Save changes', items, invalid, invalidNote }) {
  const list = items || [];
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [fit, setFit] = useState(null);
  const [popMax, setPopMax] = useState(null);
  const pendRef = useRef(null);
  const railRef = useRef(null);
  const wrapRef = useRef(null);
  const discardRef = useRef(null);

  useLayoutEffect(() => {
    const el = pendRef.current;
    const rail = railRef.current;
    if (!el || !rail) return undefined;
    const GAP = 7; // .vs-sb-pending gap
    const compute = () => {
      const avail = el.clientWidth;
      const kids = [...rail.children];
      if (!kids.length) return;
      const moreW = kids[kids.length - 1].offsetWidth;
      const tagW = kids.slice(0, -1).map((k) => k.offsetWidth);
      let used = 0;
      let n = 0;
      for (let i = 0; i < tagW.length; i++) {
        const w = tagW[i] + (i ? GAP : 0);
        const reserve = i < tagW.length - 1 ? GAP + moreW : 0;
        if (used + w + reserve > avail) break;
        used += w;
        n++;
      }
      setFit(n);
      if (wrapRef.current && discardRef.current) {
        setPopMax(Math.max(0,
          discardRef.current.getBoundingClientRect().left - wrapRef.current.getBoundingClientRect().left - 10));
      }
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [list]);

  const fitN = fit ?? Math.min(list.length, 2);
  const folded = list.length ? (fitN > 0 ? list.slice(fitN) : list.slice(1)) : [];

  useEffect(() => {
    if (open && !folded.length) { setOpen(false); setClosing(false); }
  }, [open, folded.length]);

  const toggle = () => {
    if (closing) return;
    if (!open) { setOpen(true); return; }
    setClosing(true);
    setTimeout(() => { setOpen(false); setClosing(false); }, 150);
  };

  if (!visible) return null;

  const tagCls = (it) => 'vs-sb-tag' + (it.tone ? ' ' + it.tone : '');
  const tagText = (it) => (it.tone === 'add' ? '+ ' : it.tone === 'remove' ? '− ' : '') + it.label;
  const Tag = (it, i) => <span key={i} className={tagCls(it)}>{tagText(it)}</span>;

  return (
    <div className="vs-savebar-wrap" ref={wrapRef}>
      {list.length > 0 && open && folded.length > 0 && (
        <div className={'vs-sb-pop' + (closing ? ' out' : '')} style={popMax != null ? { maxWidth: popMax } : undefined}>
          {folded.map(Tag)}
        </div>
      )}
      <div className={'vs-savebar' + (invalid ? ' vs-savebar-invalid' : '')}>
        {invalid && <span className="vs-sb-invalidnote">{invalidNote || 'Resolve the highlighted permissions to save.'}</span>}
        {list.length > 0 && (
          <div
            className={'vs-sb-left' + (folded.length ? ' clk' : '')}
            title={folded.length ? (open ? 'Hide the other changes' : 'Show the other changes') : undefined}
            onClick={() => folded.length && toggle()}
          >
            <span className="vs-sb-count">{list.length}</span>
            <div className="vs-sb-pending" ref={pendRef}>
              {fitN > 0 ? (
                <>
                  {list.slice(0, fitN).map(Tag)}
                  {folded.length > 0 && <span className="vs-sb-more">+{folded.length} more…</span>}
                </>
              ) : (
                <>
                  <span className={tagCls(list[0]) + ' vs-sb-fadetag'}>{tagText(list[0])}</span>
                  {folded.length > 0 && <span className="vs-sb-more vs-sb-overmore">+{folded.length} more…</span>}
                </>
              )}
              <div className="vs-sb-rail" ref={railRef} aria-hidden="true">
                {list.map(Tag)}
                <span className="vs-sb-more">+{Math.max(list.length - 1, 1)} more…</span>
              </div>
            </div>
          </div>
        )}
        <button type="button" className="vs-btn" ref={discardRef} onClick={onDiscard} disabled={busy}>Discard</button>
        <button type="button" className="vs-btn vs-btn-primary" onClick={onSave} disabled={busy || invalid}>
          {busy ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}
