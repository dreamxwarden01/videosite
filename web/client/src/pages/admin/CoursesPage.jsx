import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSite } from '../../context/SiteContext';
import { useToast } from '../../context/ToastContext';
import { apiGet } from '../../api';
import useFitHeight from '../../hooks/useFitHeight';
import VsPager from '../../components/VsPager';
import SortMenu from '../../components/SortMenu';
import AddCourseModal from '../../components/AddCourseModal';

// 'admin:'-prefixed so page/sort memory can never collide with the student
// CourseView's `course:…` / `sort:…` sessionStorage keys.
const PAGE_KEY = 'admin:courses:page';
const SORT_KEY = 'admin:courses:sort';
// .vs-cv-fico icon tile (36) is shorter than the two text lines (~42), + row
// padding 26 + a between-row border ≈ 69 — same shape as CourseView materials.
const ROW_EST = 69;

const BookIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);
const ChevronR = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;

export default function CoursesPage() {
  const { user } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [courses, setCourses] = useState(null); // null = loading
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

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

  const { cardRef, pageSize, rowH } = useFitHeight({ key: 'courses', rowEst: ROW_EST });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // One admin endpoint: each row already carries video_count + material_count
    // (no client-side join) and is NOT is_active-gated, so inactive courses show.
    apiGet('/api/admin/courses')
      .then(({ ok, data }) => {
        if (!alive) return;
        setCourses(ok && data?.courses ? data.courses : []);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        showToast('Failed to load courses.');
        setCourses([]);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [showToast]);

  useEffect(() => {
    if (siteName) document.title = `Courses - ${siteName}`;
  }, [siteName]);

  // "Default" order: course_code ASC then course_id ASC; the direction toggle
  // flips BOTH keys.
  const sortedCourses = useMemo(() => {
    if (!courses) return courses;
    const s = sort.dir === 'desc' ? -1 : 1;
    return courses.slice().sort((a, b) =>
      ((a.course_code || '').localeCompare(b.course_code || '') || (a.course_id - b.course_id)) * s);
  }, [courses, sort]);

  const p = user?.permissions || {};
  // manageCourse is the gate of the admin courses page (matches GET /admin/courses).
  const canCourseAdmin = !!p.manageCourse;
  if (!canCourseAdmin) {
    return <div className="vs-cv-empty">You don’t have access to courses.</div>;
  }

  const total = sortedCourses?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp so a remembered page that's now out of range (fewer courses, or a
  // taller viewport → bigger page size) shows the last page, not a blank card.
  const curPage = Math.min(Math.max(page, 1), pages);
  const slice = sortedCourses ? sortedCourses.slice((curPage - 1) * pageSize, curPage * pageSize) : [];
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
          <h1 className="vs-cv-title">Courses</h1>
          <p className="vs-cv-sub">
            {loading ? <span className="vs-cv-skel vs-cv-sub-skel" /> : `${total} ${total === 1 ? 'course' : 'courses'}`}
          </p>
        </div>
        {p.addCourse && (
          <div className="vs-head-action" style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <button className="vs-btn vs-btn-primary" onClick={() => setShowAdd(true)}>Add a course</button>
          </div>
        )}
      </div>

      {/* Fixed height (not min-height) so the pager sits at the same spot on a
          full page and a short last page; rowH + 1px budgets the between-row
          border. Before the first measurement (rowH 0) the skeleton sizes
          naturally. Skeleton rows are the same height as real rows (#185). */}
      <div className="vs-cv-card" ref={cardRef} style={rowH > 0 ? { height: pageSize * (rowH + 1) } : undefined}>
        {showSkeleton ? (
          Array.from({ length: skelCount }).map((_, i) => (
            <div className="vs-cv-row" key={i}>
              <span className="vs-cv-fico fico-gen" />
              <div className="vs-cv-rmn">
                <div className="vs-cv-skel" style={{ width: 160 + ((i * 37) % 90) }} />
                <div className="vs-cv-skel" style={{ width: 100 + ((i * 23) % 60), marginTop: 7 }} />
              </div>
            </div>
          ))
        ) : total === 0 ? (
          <div className="vs-cv-empty">No courses yet.</div>
        ) : (
          slice.map(c => {
            const videos = Number(c.video_count) || 0;
            const files = Number(c.material_count) || 0;
            return (
              <Link key={c.course_id} to={`/admin/courses/${c.course_id}`} className="vs-cv-row clk">
                <span className="vs-cv-fico fico-doc"><BookIcon /></span>
                <div className="vs-cv-rmn">
                  <p className="vs-cv-rt" title={c.course_name || c.course_code}>{c.course_name || c.course_code}</p>
                  <p className="vs-cv-rs">
                    <span className="vs-wk">{c.course_code}</span>
                    <span>{videos} {videos === 1 ? 'video' : 'videos'}</span>
                    <span className="vs-cv-dot">·</span><span>{files} {files === 1 ? 'file' : 'files'}</span>
                  </p>
                </div>
                {Number(c.is_active) === 0 && <span className="vs-cv-stb vs-cv-stb-n">Inactive</span>}
                <span className="vs-cv-chev"><ChevronR /></span>
              </Link>
            );
          })
        )}
      </div>

      {!showSkeleton && total > 0 && (
        <VsPager
          page={curPage} pages={pages} total={total} from={from} to={to} unit="courses" onPage={setPage}
          sortControl={<SortMenu fields={[['default', 'Default']]} sort={sort} onChange={changeSort} />}
        />
      )}

      {showAdd && (
        <AddCourseModal
          onClose={() => setShowAdd(false)}
          onCreated={(courseId) => navigate(`/admin/courses/${courseId}`)}
        />
      )}
    </>
  );
}
