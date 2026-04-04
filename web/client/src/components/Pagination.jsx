import { useState } from 'react';

const LIMIT_OPTIONS = [10, 20, 50];

const ChevronLeft = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
    <path d="M10 12L6 8l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const ChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export default function Pagination({ page, totalPages, total, limit, onPageChange, onLimitChange, itemLabel }) {
  const [gotoValue, setGotoValue] = useState('');

  if (total === 0) return null;

  const label = itemLabel || 'item';
  const handleGoto = () => {
    const num = parseInt(gotoValue, 10);
    if (num >= 1 && num <= totalPages && num !== page) {
      onPageChange(num);
    }
    setGotoValue('');
  };

  // Build page numbers with ellipsis — same logic as old EJS
  const pages = [];
  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    let start = Math.max(2, page - 1);
    let end = Math.min(totalPages - 1, page + 1);
    while (end - start < 2 && (start > 2 || end < totalPages - 1)) {
      if (start > 2) start--;
      if (end - start < 2 && end < totalPages - 1) end++;
    }
    if (start > 2) pages.push('...');
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages - 1) pages.push('...');
    pages.push(totalPages);
  }

  return (
    <div className="pagination-bar">
      <span className="pagination-total">{total} {label}{total !== 1 ? 's' : ''}</span>

      <select
        className="pagination-limit"
        value={limit}
        onChange={(e) => onLimitChange(Number(e.target.value))}
      >
        {LIMIT_OPTIONS.map(opt => (
          <option key={opt} value={opt}>{opt} / page</option>
        ))}
      </select>

      <div className="pagination-pages">
        {page > 1 ? (
          <a href="#" className="pagination-btn pagination-arrow" onClick={(e) => { e.preventDefault(); onPageChange(page - 1); }}><ChevronLeft /></a>
        ) : (
          <span className="pagination-btn pagination-arrow disabled"><ChevronLeft /></span>
        )}

        {pages.map((p, i) => (
          p === '...' ? (
            <span key={`ellipsis-${i}`} className="pagination-ellipsis">&hellip;</span>
          ) : p === page ? (
            <span key={p} className="pagination-btn active">{p}</span>
          ) : (
            <a key={p} href="#" className="pagination-btn pagination-num" onClick={(e) => { e.preventDefault(); onPageChange(p); }}>{p}</a>
          )
        ))}

        {page < totalPages ? (
          <a href="#" className="pagination-btn pagination-arrow" onClick={(e) => { e.preventDefault(); onPageChange(page + 1); }}><ChevronRight /></a>
        ) : (
          <span className="pagination-btn pagination-arrow disabled"><ChevronRight /></span>
        )}
      </div>

      <div className="pagination-goto-wrap">
        <span>Go to</span>
        <input
          type="text"
          className="pagination-goto"
          value={gotoValue}
          onChange={(e) => setGotoValue(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && handleGoto()}
          onBlur={handleGoto}
          placeholder={String(page)}
        />
        <span>page</span>
      </div>
    </div>
  );
}
