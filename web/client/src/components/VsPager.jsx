// Windowed page list: always 1 and `pages`, plus the current page and its
// two neighbours; gaps render an ellipsis. Copied verbatim from CourseView's
// inline pager so both surfaces window identically.
const pageNums = (page, pages) => {
  const s = new Set([1, pages, page, page - 1, page + 1]);
  return [...s].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
};

export default function VsPager({ page, pages, total, from, to, unit, onPage, sortControl }) {
  if (total === 0) return null;
  return (
    <div className="vs-pager">
      <span className="vs-pager-count">{from}–{to} of {total} {unit}</span>
      {sortControl}
      <div className="vs-pager-nav">
        <button className="vs-pbtn" disabled={page === 1} onClick={() => onPage(page - 1)}>‹ Prev</button>
        {pageNums(page, pages).map((n, i, arr) => (
          <span key={n}>
            {i > 0 && n - arr[i - 1] > 1 && <span className="vs-pdots">…</span>}
            <button className={'vs-pnum' + (n === page ? ' on' : '')} onClick={() => onPage(n)}>{n}</button>
          </span>
        ))}
        <button className="vs-pbtn" disabled={page === pages} onClick={() => onPage(page + 1)}>Next ›</button>
      </div>
    </div>
  );
}
