import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link, useOutletContext } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet } from '../api';
import { moduleTerm } from '../utils/moduleLabel';
import useFitHeight from '../hooks/useFitHeight';
import SortMenu from '../components/SortMenu';
import VsPager from '../components/VsPager';

const MAX_POSTER_RETRIES = 10;

// Maps a coded 403/404 body onto the scoped "gone" pane state. Reads ONLY
// data?.code — never the bare status — so a Cloudflare WAF 403 (HTML body,
// data==null) returns null and falls through to the caller's existing handling.
function goneFromCode(data) {
  if (data?.code === 'COURSE_NOT_FOUND') return 'notfound';
  if (data?.code === 'COURSE_FORBIDDEN' || data?.code === 'PERMISSION_DENIED') return 'forbidden';
  return null;
}

// mm:ss, or h:mm:ss past an hour.
function formatDuration(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function formatFileSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function fileMeta(filename) {
  const ext = (filename.split('.').pop() || '').toUpperCase();
  const cls = { PDF: 'fico-pdf', DOC: 'fico-doc', DOCX: 'fico-doc', ZIP: 'fico-zip', CSV: 'fico-csv' }[ext] || 'fico-gen';
  return { ext: ext || 'FILE', cls };
}

const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M9 13h6" /><path d="M9 17h4" />
  </svg>
);
const PlayIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;
const ChevronR = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;
const EyeIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>;
const DownloadIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>;

const SORT_FIELDS = [['default', 'Default'], ['date', 'Date'], ['name', 'Name']];

// Rough initial row-height estimates for the first paint only — useFitHeight
// measures the REAL row height (.vs-cv-row: video ≈ poster 56 + pad + border;
// material ≈ two text lines 42 + pad + border, taller than the file icon).
const ROW_EST_VIDEO = 82;
const ROW_EST_MATERIAL = 69;

export default function CourseView({ tab }) {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { siteName } = useSite();
  const { user, refresh: refreshMe } = useAuth();
  const { showToast } = useToast();
  const { courses, refreshCourses } = useOutletContext() ?? {};
  const canPlay = !!user?.permissions?.allowPlayback;
  const canMaterials = !!user?.permissions?.accessAttachments;
  const isVideos = tab !== 'materials';

  // Scoped "this course is gone/forbidden" pane. goneRef mirrors it so the coded
  // handlers fire setGone/refreshCourses/refreshMe at most once per course
  // WITHOUT putting `gone` in any fetch effect's deps — that would let
  // refreshMe's setUser re-fire them (the 403→refreshMe→refetch→403 loop). The
  // ref is read synchronously, so repeated late/poll responses stay no-ops.
  const [gone, setGone] = useState(null); // null | 'notfound' | 'forbidden'
  const goneRef = useRef(null);
  useEffect(() => { setGone(null); goneRef.current = null; }, [courseId]);
  const markGone = (data) => {
    const g = goneFromCode(data);
    if (!g) return false;
    if (!goneRef.current) {
      goneRef.current = g;
      setGone(g);
      refreshCourses?.();
      if (g === 'forbidden') refreshMe?.();
    }
    return true;
  };

  const { cardRef, ready, pageSize, rowH, fitReady } = useFitHeight({ key: tab, rowEst: tab === 'materials' ? ROW_EST_MATERIAL : ROW_EST_VIDEO });

  // Page + sort memory per (course, tab). Restored from sessionStorage on mount
  // (useState init) and reset DURING RENDER when the course/tab changes — NOT in
  // an effect. Doing it in an effect ran after the fetch effect fired with the
  // previous course's page (a stale-page double request) and after the persist
  // effect wrote that stale page under the NEW course's key (the "pagination
  // carried between courses" bug). An in-render reset lands before both.
  const memKey = `course:${courseId}:${tab}`;
  const sortMemKey = `sort:${courseId}:${tab}`;
  const readPage = (k) => { const v = parseInt(sessionStorage.getItem(k), 10); return v > 0 ? v : 1; };
  const readSort = (k) => {
    const [f, d] = (sessionStorage.getItem(k) || '').split(':');
    return { field: ['default', 'date', 'name'].includes(f) ? f : 'default', dir: d === 'desc' ? 'desc' : 'asc' };
  };
  const [page, setPage] = useState(() => readPage(memKey));
  const [sortField, setSortField] = useState(() => readSort(sortMemKey).field);
  const [sortDir, setSortDir] = useState(() => readSort(sortMemKey).dir);
  const [prevKey, setPrevKey] = useState(memKey);
  if (memKey !== prevKey) {
    setPrevKey(memKey);
    setPage(readPage(memKey));
    const s = readSort(sortMemKey);
    setSortField(s.field);
    setSortDir(s.dir);
  }
  useEffect(() => { sessionStorage.setItem(memKey, String(page)); }, [memKey, page]);
  useEffect(() => { sessionStorage.setItem(sortMemKey, `${sortField}:${sortDir}`); }, [sortMemKey, sortField, sortDir]);
  const changeSort = ({ field, dir }) => { setSortField(field); setSortDir(dir); setPage(1); };

  // --- header (course code/name) from the sidebar's course list, so it shows
  // instantly without waiting on the fetch ---
  const sidebarCourse = Array.isArray(courses) ? courses.find((c) => String(c.course_id) === courseId) : null;
  const [course, setCourse] = useState(null);
  // Ignore a stale `course` left from the previous course's fetch (its course_id
  // won't match) so the header shows the NEW course's name immediately from the
  // sidebar, instead of the old title flickering in and shifting the layout.
  const curCourse = course && String(course.course_id) === courseId ? course : null;
  const headCode = curCourse?.course_code || sidebarCourse?.course_code;
  const headName = curCourse?.course_name || sidebarCourse?.course_name;
  // The per-item numbering term for this course ("Week"/"Chapter"/… → "Module").
  const modTerm = moduleTerm(curCourse?.module_label ?? sidebarCourse?.module_label);

  // --- videos (server-paginated) ---
  const [videos, setVideos] = useState([]);
  const [vTotal, setVTotal] = useState(0);
  // Which course the current vTotal/videos belong to — so the header count and
  // list don't flash the PREVIOUS course's data in the window between a course
  // switch and the new fetch landing.
  const [vLoadedCourse, setVLoadedCourse] = useState(null);
  // Transient load failure (a 5xx, or a Cloudflare WAF block with data==null —
  // distinct from a coded course-gone). Without this the video skeleton spins
  // forever, since countReady only flips on a successful load. `retry` re-fires
  // the primary load from the error pane's button.
  const [vError, setVError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { setVError(false); }, [courseId]);
  const [r2PublicDomain, setR2PublicDomain] = useState('');
  const [vLoading, setVLoading] = useState(true);
  const posterUrlsRef = useRef({});
  const [posterFailed, setPosterFailed] = useState({});
  const [posterLoaded, setPosterLoaded] = useState({});
  const [posterRetries, setPosterRetries] = useState({});

  // --- materials (fetched once per course, sliced client-side for the pager) ---
  const [materials, setMaterials] = useState(null);
  const [mLoadedCourse, setMLoadedCourse] = useState(null); // course the materials belong to
  const matForRef = useRef(null);
  // Drop the materials cache when the course changes so stale files don't flash.
  useEffect(() => { setMaterials(null); matForRef.current = null; }, [courseId]);

  // Videos: refetch when course / page / fit changes — but only once the fit is
  // known (ready) and only on the videos tab, so materials paging never fires a
  // video request and the estimate→measured pageSize never double-fetches.
  useEffect(() => {
    if (!isVideos || !fitReady) return undefined;
    let alive = true;
    setVLoading(true);
    apiGet(`/api/courses/${courseId}?page=${page}&limit=${pageSize}&sort=${sortField}&dir=${sortDir}`)
      .then(({ data, ok }) => {
        if (!alive) return;
        // Coded course-gone/forbidden → scoped pane, then stop. Only on
        // data?.code; a WAF 403 (data==null) falls through to the ok-branch/no-op.
        if (markGone(data)) { setVLoading(false); return; }
        if (ok && data) {
          setVError(false);
          setCourse(data.course);
          setVideos(data.videos || []);
          setVTotal(data.pagination?.total ?? 0);
          setR2PublicDomain(data.r2PublicDomain || '');
          setVLoadedCourse(courseId);
        } else {
          setVError(true);
          showToast(data?.error || 'Failed to load videos.');
        }
        setVLoading(false);
      })
      .catch(() => { if (alive) { setVError(true); showToast('Failed to load videos.'); setVLoading(false); } });
    return () => { alive = false; };
  }, [isVideos, fitReady, courseId, page, pageSize, sortField, sortDir, retry, showToast]);

  // Materials: fetched exactly once per course (the ref guards re-fetch on a
  // videos↔materials toggle; pageSize/page never trigger it).
  useEffect(() => {
    if (isVideos || !ready || matForRef.current === courseId) return undefined;
    matForRef.current = courseId;
    let alive = true;
    apiGet(`/api/materials/courses/${courseId}`)
      .then(({ data, ok }) => {
        if (!alive) return;
        if (markGone(data)) return;
        setMaterials(ok && data ? (data.materials || []) : []);
        setMLoadedCourse(courseId);
        if (ok && data?.courseCode) setCourse((c) => c || { course_code: data.courseCode, course_name: data.courseName });
      })
      .catch(() => { if (alive) { setMaterials([]); showToast('Failed to load materials.'); } });
    return () => { alive = false; };
  }, [isVideos, ready, courseId, showToast]);

  useEffect(() => { if (siteName && (headName || headCode)) document.title = `${headName || headCode} - ${siteName}`; }, [siteName, headName, headCode]);

  // auto-refresh (silent, in place) while any visible video is still processing
  const pageRef = useRef(page); pageRef.current = page;
  const psRef = useRef(pageSize); psRef.current = pageSize;
  useEffect(() => {
    if (!isVideos || gone) return undefined;
    const busy = videos.some((v) => v.status !== 'finished' && v.status !== 'error');
    if (!busy) return undefined;
    const timer = setInterval(() => {
      apiGet(`/api/courses/${courseId}?page=${pageRef.current}&limit=${psRef.current}&sort=${sortField}&dir=${sortDir}`)
        .then(({ data, ok }) => {
          // A course deactivated mid-processing shows the gone pane on the next
          // poll tick rather than waiting for a page/tab change.
          if (markGone(data)) return;
          if (ok && data) {
            setVideos(data.videos || []);
            setVTotal(data.pagination?.total ?? 0);
            setR2PublicDomain(data.r2PublicDomain || '');
          }
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [isVideos, gone, videos, courseId, sortField, sortDir]);

  const renderPoster = (video) => {
    const hasPoster = video.posterToken && r2PublicDomain && !posterFailed[video.video_id];
    if (!hasPoster) return <div className="vs-cv-play"><PlayIcon /></div>;
    let baseSrc = posterUrlsRef.current[video.video_id];
    if (!baseSrc) {
      baseSrc = `https://${r2PublicDomain}/posters/${courseId}/${video.video_id}.jpg?verify=${video.posterToken}`;
      posterUrlsRef.current[video.video_id] = baseSrc;
    }
    const retries = posterRetries[video.video_id] || 0;
    const src = retries > 0 ? `${baseSrc}&r=${retries}` : baseSrc;
    const loaded = !!posterLoaded[video.video_id];
    return (
      <div className={`vs-cv-thumb${loaded ? '' : ' loading'}`}>
        <img
          src={src} alt="" loading="lazy" style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setPosterLoaded((p) => ({ ...p, [video.video_id]: true }))}
          onError={() => {
            if (retries >= MAX_POSTER_RETRIES) { setPosterFailed((p) => ({ ...p, [video.video_id]: true })); return; }
            const delay = 500 + retries * 500;
            setTimeout(() => setPosterRetries((p) => ({ ...p, [video.video_id]: (p[video.video_id] || 0) + 1 })), delay);
          }}
        />
      </div>
    );
  };

  const openMaterial = async (materialId, mode) => {
    try {
      const url = mode === 'view' ? `/api/materials/${materialId}/view` : `/api/materials/${materialId}/download`;
      const { data, ok } = await apiGet(url);
      if (ok && data?.downloadUrl) { window.open(data.downloadUrl, '_blank'); return; }
      // View/download access (accessAttachments) may have been revoked — a coded
      // 403. Refresh perms so the View/Download buttons drop away, and say so.
      if (data?.code === 'PERMISSION_DENIED') { refreshMe?.(); showToast('You no longer have access to download materials.'); return; }
      showToast(data?.error || 'Couldn’t get the file link.');
    } catch { showToast(mode === 'view' ? 'Couldn’t open the file.' : 'Download failed.'); }
  };

  // Materials are fetched whole, so their sort is applied here (client-side);
  // videos come back already sorted by the server. NULL module number sinks last.
  const sortedMaterials = useMemo(() => {
    if (!materials) return materials;
    const s = sortDir === 'desc' ? -1 : 1;
    const mn = (m) => { const n = parseInt(m.module_number, 10); return Number.isNaN(n) ? null : n; };
    const byModule = (a, b) => {
      const wa = mn(a), wb = mn(b);
      if (wa == null && wb == null) return 0;
      if (wa == null) return 1;
      if (wb == null) return -1;
      return (wa - wb) * s;
    };
    const byDate = (a, b) => (((a.created_at || '') < (b.created_at || '') ? -1 : (a.created_at || '') > (b.created_at || '') ? 1 : 0)) * s;
    const byId = (a, b) => (a.material_id - b.material_id) * s;
    const byName = (a, b) => (a.filename || '').localeCompare(b.filename || '') * s;
    const cmp = sortField === 'name'
      ? (a, b) => byName(a, b) || byModule(a, b) || byDate(a, b) || byId(a, b)
      : sortField === 'date'
        ? (a, b) => byDate(a, b) || byModule(a, b) || byId(a, b)
        : (a, b) => byModule(a, b) || byDate(a, b) || byId(a, b);
    return materials.slice().sort(cmp);
  }, [materials, sortField, sortDir]);

  const total = isVideos ? vTotal : (sortedMaterials?.length ?? 0);
  // Whether the count/data is confirmed for the CURRENT course (not the stale
  // previous one still sitting in state right after a course switch).
  const countReady = isVideos ? vLoadedCourse === courseId : mLoadedCourse === courseId;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp to the valid range for display/slice so a remembered page that's now
  // out of range (page size grew between visits → fewer pages) shows the LAST
  // page instead of a blank card with a missing page button. `page` itself is
  // left untouched (non-destructive); videos are also clamped server-side.
  const curPage = Math.min(Math.max(page, 1), pages);
  // Skeleton shows purely while DATA loads — NOT gated on fitReady. Gating on
  // fitReady flipped rows skeleton↔real as the measurement settled, and because
  // material skeleton (icon-height) and real (text-height) rows differ, that
  // oscillation never converged → infinite re-render (React #185). The server
  // fetch is still settle-gated (fitReady) in its effect; the visual isn't.
  // Skeleton while loading OR while the loaded data is still the previous
  // course's (a course switch) — so neither the list nor the count flashes stale
  // data. Not gated on fitReady (that caused the #185 measurement loop).
  const showSkeleton = isVideos ? (vLoading || !countReady) : !countReady;
  const skelCount = Math.min(pageSize, 8);
  const matSlice = !isVideos && sortedMaterials ? sortedMaterials.slice((curPage - 1) * pageSize, curPage * pageSize) : [];

  const goTab = (t) => navigate(t === 'materials' ? `/course/${courseId}/materials` : `/course/${courseId}`);

  // Scoped error pane — replaces the content in place (no redirect; the URL
  // stays). Sits ABOVE the skeleton/list branch, which would otherwise spin
  // forever because countReady never flips once the course is gone.
  if (gone) {
    return (
      <div className="vs-cv-gone">
        <div className="vs-cv-gone-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" />
          </svg>
        </div>
        <h2>{gone === 'forbidden' ? 'You no longer have access to this course' : 'This course is no longer available'}</h2>
        <p>{gone === 'forbidden'
          ? 'Your access may have changed. It has been removed from your list.'
          : 'It may have been removed. It has been removed from your list.'}</p>
        <Link className="vs-btn vs-btn-primary" to="/">Back to courses</Link>
      </div>
    );
  }

  // Transient load failure with nothing yet shown for this course (a 5xx / WAF
  // block). Distinct from `gone`: the course likely still exists, so offer a
  // retry rather than "no longer available".
  if (isVideos && vError && vLoadedCourse !== courseId) {
    return (
      <div className="vs-cv-gone">
        <div className="vs-cv-gone-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
          </svg>
        </div>
        <h2>Couldn’t load this course</h2>
        <p>Something went wrong reaching the server. Check your connection and try again.</p>
        <button className="vs-btn vs-btn-primary" onClick={() => { setVError(false); setRetry((r) => r + 1); }}>Try again</button>
      </div>
    );
  }

  const VideoRow = (video) => {
    const clickable = video.status === 'finished' && canPlay;
    const meta = (
      <p className="vs-cv-rs">
        {video.module_number != null && <span className="vs-wk">{modTerm} {video.module_number}</span>}
        {video.lecture_date && <span>{video.lecture_date.slice(0, 10)}</span>}
        {video.lecture_date && video.duration_seconds > 0 && <span className="vs-cv-dot">·</span>}
        {video.duration_seconds > 0 && <span>{formatDuration(video.duration_seconds)}</span>}
      </p>
    );
    let tail;
    if (video.status === 'finished') tail = clickable ? <span className="vs-cv-chev"><ChevronR /></span> : null;
    else if (video.status === 'error') tail = <span className="vs-cv-stb vs-cv-stb-f">Failed</span>;
    else tail = <span className="vs-cv-stb vs-cv-stb-p">Processing{video.processing_progress ? ` ${video.processing_progress}%` : ''}</span>;
    const inner = (<>{renderPoster(video)}<div className="vs-cv-rmn"><p className="vs-cv-rt">{video.title}</p>{meta}</div>{tail}</>);
    return clickable ? (
      <Link key={video.video_id} to={`/course/${courseId}/watch/${video.video_id}`} className="vs-cv-row clk">{inner}</Link>
    ) : (
      <div key={video.video_id} className={'vs-cv-row' + (video.status === 'finished' ? '' : ' proc')}>{inner}</div>
    );
  };

  const MaterialRow = (m) => {
    const { ext, cls } = fileMeta(m.filename);
    const isPdf = ext === 'PDF' || m.content_type === 'application/pdf';
    return (
      <div key={m.material_id} className="vs-cv-row">
        <span className={`vs-cv-fico ${cls}`}><FileIcon /></span>
        <div className="vs-cv-rmn">
          <p className="vs-cv-rt">{m.filename}</p>
          <p className="vs-cv-rs">
            {m.module_number != null && <span className="vs-wk">{modTerm} {m.module_number}</span>}
            <span>{ext}</span>
            {m.file_size > 0 && <><span className="vs-cv-dot">·</span><span>{formatFileSize(m.file_size)}</span></>}
          </p>
        </div>
        <div className="vs-cv-acts">
          {canMaterials && isPdf && <button className="vs-cv-view" onClick={() => openMaterial(m.material_id, 'view')}><EyeIcon />View</button>}
          {canMaterials && <button className="vs-cv-dl" aria-label="Download" onClick={() => openMaterial(m.material_id)}><DownloadIcon /></button>}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="vs-cv-head">
        <div style={{ minWidth: 0 }}>
          <h1 className="vs-cv-title" title={headName || headCode || 'Course'}>{headName || headCode || 'Course'}</h1>
          <p className="vs-cv-sub">
            {headName && headCode ? `${headCode} · ` : ''}
            {countReady
              ? (isVideos ? `${total} ${total === 1 ? 'video' : 'videos'}` : `${total} ${total === 1 ? 'file' : 'files'}`)
              : <span className="vs-cv-skel vs-cv-sub-skel" />}
          </p>
        </div>
        <div className="vs-seg">
          <button className={'vs-seg-btn' + (isVideos ? ' on' : '')} onClick={() => goTab('videos')}><PlayIcon />Videos</button>
          <button className={'vs-seg-btn' + (!isVideos ? ' on' : '')} onClick={() => goTab('materials')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /></svg>
            Materials
          </button>
        </div>
      </div>

      {/* Fixed height (not min-height) so the card — and therefore the pager
          below it — sits at the SAME spot on a full page and a short last
          page. We budget rowH + 1px per row for the between-row border (the
          first row has none, so a full page never quite reaches this) and let
          the card's own overflow:hidden hold the height exactly. Before the
          first measurement (rowH 0) the skeleton sizes naturally. */}
      <div className="vs-cv-card" ref={cardRef} style={rowH > 0 ? { height: pageSize * (rowH + 1) } : undefined}>
        {showSkeleton ? (
          Array.from({ length: skelCount }).map((_, i) => (
            <div className="vs-cv-row" key={i}>
              {isVideos ? <div className="vs-cv-thumb loading" /> : <span className="vs-cv-fico fico-gen" />}
              <div className="vs-cv-rmn">
                <div className="vs-cv-skel" style={{ width: 150 + ((i * 37) % 90) }} />
                <div className="vs-cv-skel" style={{ width: 90 + ((i * 23) % 60), marginTop: 7 }} />
              </div>
            </div>
          ))
        ) : total === 0 ? (
          <div className="vs-cv-empty">{isVideos ? 'No videos in this course yet.' : 'No materials in this course yet.'}</div>
        ) : isVideos ? (
          videos.map(VideoRow)
        ) : (
          matSlice.map(MaterialRow)
        )}
      </div>

      {/* The pager stays MOUNTED whenever the current course's count is known
          (countReady) — so a same-course page switch (which only reloads the
          list, not the count) leaves the page + sort buttons in place instead of
          unmounting/remounting them (the "flashing" on paging). The wrapper
          reserves the row height so a course switch (count briefly unknown)
          doesn't shift the layout either. */}
      <div className="vs-cv-foot">
        {countReady && (
          <VsPager
            page={curPage}
            pages={pages}
            total={total}
            from={(curPage - 1) * pageSize + 1}
            to={Math.min(curPage * pageSize, total)}
            onPage={setPage}
            sortControl={<SortMenu fields={SORT_FIELDS} sort={{ field: sortField, dir: sortDir }} onChange={changeSort} />}
          />
        )}
      </div>
    </>
  );
}
