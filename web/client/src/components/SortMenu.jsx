import { useState, useEffect, useRef } from 'react';

const SortGlyph = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l4-4 4 4" /><path d="M7 4v16" /><path d="M21 16l-4 4-4-4" /><path d="M17 20V4" /></svg>;
const ArrowUp = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></svg>;
const ArrowDown = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M6 13l6 6 6-6" /></svg>;
const CheckIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l4 4 10-11" /></svg>;

// Compact sort control that lives in the pager row (next to the item count).
// A configurable field list (`fields`) + Ascending / Descending, in a popover
// that opens UPWARD (the pager sits near the bottom of the content area).
//   fields   Array<[value, label]>, e.g. [['default','Default']] or
//            [['default','Default'],['date','Date'],['name','Name']].
//   sort     { field, dir } — dir is 'asc' | 'desc'.
//   onChange (nextSort) => void — called with the full next { field, dir }.
export default function SortMenu({ fields, sort, onChange }) {
  const { field, dir } = sort;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const fieldLabel = (fields.find(([k]) => k === field) || fields[0])[1];
  return (
    <div className="vs-sort" ref={ref}>
      <button type="button" className={'vs-sort-btn' + (open ? ' open' : '')} onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open}>
        <SortGlyph />
        <span className="vs-sort-cur">{fieldLabel}</span>
        <span className="vs-sort-dir">{dir === 'desc' ? <ArrowDown /> : <ArrowUp />}</span>
      </button>
      {open && (
        <div className="vs-sort-menu" role="menu">
          <div className="vs-sort-sec">Sort by</div>
          {fields.map(([k, lbl]) => (
            <button type="button" key={k} className={'vs-sort-opt' + (field === k ? ' on' : '')} onClick={() => onChange({ field: k, dir })}>
              <span>{lbl}</span>{field === k && <CheckIcon />}
            </button>
          ))}
          <div className="vs-sort-div" />
          <div className="vs-sort-sec">Order</div>
          {[['asc', 'Ascending'], ['desc', 'Descending']].map(([k, lbl]) => (
            <button type="button" key={k} className={'vs-sort-opt' + (dir === k ? ' on' : '')} onClick={() => onChange({ field, dir: k })}>
              <span>{lbl}</span>{dir === k && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
