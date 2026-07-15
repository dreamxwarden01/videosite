import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSite } from '../../context/SiteContext';
import { useToast } from '../../context/ToastContext';
import { apiGet } from '../../api';
import useFitHeight from '../../hooks/useFitHeight';
import VsPager from '../../components/VsPager';
import SortMenu from '../../components/SortMenu';
import Avatar from '../../components/Avatar';

// 'admin:'-prefixed flat keys, matching CoursesPage's page/sort memory.
const PAGE_KEY = 'admin:users:page';
const SORT_KEY = 'admin:users:sort';
// A 34px avatar is shorter than the two text lines (~42) + row padding 26 +
// a between-row border ≈ 56 — the account portal users-list row shape.
const ROW_EST = 56;
// Must match the ?limit= clamp in routes/api/admin.js.
const MAX_PAGE_SIZE = 60;
// Single field; asc/desc flips the whole default order (permission level,
// display name, uuid — see listUsers).
const SORT_FIELDS = [['default', 'Default']];

const ChevronR = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;
const SearchIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
const XIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;

export default function UsersPage() {
  const { user } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const [page, setPage] = useState(() => {
    const v = parseInt(sessionStorage.getItem(PAGE_KEY), 10);
    return v > 0 ? v : 1;
  });
  const [sort, setSort] = useState(() => {
    const [, d] = (sessionStorage.getItem(SORT_KEY) || '').split(':');
    return { field: 'default', dir: d === 'desc' ? 'desc' : 'asc' };
  });
  useEffect(() => { sessionStorage.setItem(PAGE_KEY, String(page)); }, [page]);
  useEffect(() => { sessionStorage.setItem(SORT_KEY, `${sort.field}:${sort.dir}`); }, [sort]);
  // SortMenu only reports the new {field,dir}; the page reset lives here.
  const changeSort = (next) => { setSort(next); setPage(1); };

  // Server-side search (the list is server-paginated — a client filter would
  // only see the current page). NOT persisted: a remembered term + remembered
  // page is a confusing restore. Typing resets to page 1.
  const [query, setQuery] = useState('');
  const onSearch = (v) => { setQuery(v); setPage(1); };

  // Fit-to-height paging. Clamp to the route's ?limit= ceiling, or a tall
  // viewport would ask for more than the server returns and the page math would
  // silently skip rows past MAX_PAGE_SIZE.
  const { cardRef, pageSize: fitPageSize, rowH, fitReady } = useFitHeight({ key: 'users', rowEst: ROW_EST });
  const pageSize = Math.min(fitPageSize, MAX_PAGE_SIZE);

  const canManage = !!user?.permissions?.manageUser;

  useEffect(() => {
    if (siteName) document.title = `User Management - ${siteName}`;
  }, [siteName]);

  // Primary load on page / sort / fit change — only once the fit has SETTLED
  // (fitReady), so the estimate→measured pageSize never double-fetches. The
  // list is SERVER-paginated (server clamps the page + returns total/totalPages).
  useEffect(() => {
    if (!canManage || !fitReady) return undefined;
    let alive = true;
    const run = () => {
      setLoading(true);
      const q = query.trim();
      apiGet(`/api/admin/users?page=${page}&limit=${pageSize}&dir=${sort.dir}` + (q ? `&q=${encodeURIComponent(q)}` : ''))
        .then(({ data, ok }) => {
          if (!alive) return;
          if (ok && data) {
            setUsers(data.users || []);
            setTotal(data.total || 0);
            setTotalPages(data.totalPages || 1);
            setLoaded(true);
          } else {
            showToast(data?.error || 'Failed to load users.');
          }
          setLoading(false);
        })
        .catch(() => { if (alive) { showToast('Failed to load users.'); setLoading(false); } });
    };
    // Debounce a search keystroke (which resets to page 1); page/sort/fit
    // changes load immediately.
    const delay = query.trim() && page === 1 ? 250 : 0;
    const t = setTimeout(run, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [canManage, fitReady, page, pageSize, sort.dir, query, showToast]);

  if (!canManage) {
    return <div className="vs-cv-empty">Permission denied.</div>;
  }

  const pages = Math.max(1, totalPages);
  // Clamp for display so a remembered page that's now out of range shows the
  // last page, not a blank card. Raw `page` drives the fetch URL + persistence;
  // the server clamps the returned rows to the same last page.
  const curPage = Math.min(Math.max(page, 1), pages);
  const from = (curPage - 1) * pageSize + 1;
  const to = Math.min(curPage * pageSize, total);
  // Skeleton is purely data-gated (never fitReady) — gating it on the fit
  // measurement oscillates skeleton↔real and never converges (React #185).
  const showSkeleton = loading;
  const skelCount = Math.min(pageSize, 8);

  return (
    <>
      <div className="vs-cv-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="vs-cv-title">Users</h1>
          <p className="vs-cv-sub">
            {loaded ? `${total} ${total === 1 ? 'user' : 'users'}` : <span className="vs-cv-skel vs-cv-sub-skel" />}
          </p>
        </div>
      </div>

      <div className="vs-search">
        <span className="vs-search-ico"><SearchIcon /></span>
        <input
          className="vs-input"
          type="text"
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search by name, username, or email"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button type="button" className="vs-search-clear" onClick={() => onSearch('')} aria-label="Clear search"><XIcon /></button>
        )}
      </div>

      {/* Fixed height (not min-height) so the pager sits at the same spot on a
          full page and a short last page; rowH + 1px budgets the between-row
          border. Before the first measurement (rowH 0) the skeleton sizes
          naturally. Skeleton rows are the same height as real rows (#185). */}
      <div className="vs-cv-card" ref={cardRef} style={rowH > 0 ? { height: pageSize * (rowH + 1) } : undefined}>
        {showSkeleton ? (
          // Skeleton rows MUST be the same height as real rows, or useFitHeight
          // measures a different rowH on the skeleton↔real swap, flips pageSize,
          // and (pageSize being a fetch dep) refetches forever — the limit=8↔9
          // loop. Mirror the real row's exact box model: same avatar + the same
          // .vs-cv-rt / .vs-cv-rs <p> line boxes, with the shimmer bar inline.
          Array.from({ length: skelCount }).map((_, i) => (
            <div className="vs-cv-row" key={i}>
              <div className="vs-cv-av" />
              <div className="vs-cv-rmn">
                <p className="vs-cv-rt"><span className="vs-skln" style={{ width: 140 + ((i * 37) % 90) }}>{' '}</span></p>
                <p className="vs-cv-rs"><span className="vs-skln" style={{ width: 90 + ((i * 23) % 60) }}>{' '}</span></p>
              </div>
            </div>
          ))
        ) : total === 0 ? (
          <div className="vs-cv-empty">{query.trim() ? 'No users match your search.' : 'No users found.'}</div>
        ) : (
          users.map(u => {
            const editable = u.permission_level > user.permission_level; // STRICTLY lower priv
            const me = u.user_id === user.user_id;
            return (
              <div
                key={u.user_id}
                className={'vs-cv-row' + (editable ? ' clk' : '')}
                onClick={editable ? () => navigate(`/admin/users/${u.user_id}/edit`) : undefined}
              >
                <Avatar user={u} name={u.display_name || u.username} className="vs-cv-av" />
                <div className="vs-cv-rmn">
                  <p className="vs-cv-rt">{u.display_name || u.username}{me && <span className="vs-you">you</span>}</p>
                  <p className="vs-cv-rs">
                    <span>{u.username}</span>
                    <span className="vs-cv-dot">·</span>
                    <span>{u.role_name || 'no role'}</span>
                  </p>
                </div>
                {editable && <span className="vs-cv-chev"><ChevronR /></span>}
              </div>
            );
          })
        )}
      </div>

      {!showSkeleton && total > 0 && (
        <VsPager
          page={curPage} pages={pages} total={total} from={from} to={to} unit="users" onPage={setPage}
          sortControl={<SortMenu fields={SORT_FIELDS} sort={sort} onChange={changeSort} />}
        />
      )}
    </>
  );
}
