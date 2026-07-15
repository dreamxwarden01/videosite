import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, useOutletContext, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSite } from '../../context/SiteContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import { apiGet, apiPost, apiDelete } from '../../api';
import { moduleTerm } from '../../utils/moduleLabel';
import useFitHeight from '../../hooks/useFitHeight';
import SortMenu from '../../components/SortMenu';
import VsPager from '../../components/VsPager';
import UploadVideoModal from '../../components/UploadVideoModal';
import UploadMaterialsModal from '../../components/UploadMaterialsModal';
import EditVideoModal from '../../components/EditVideoModal';
import EditMaterialModal from '../../components/EditMaterialModal';
import CourseEditModal from '../../components/CourseEditModal';
import PlaybackStatsModal from '../../components/PlaybackStatsModal';

const MAX_POSTER_RETRIES = 10;

// First-paint row-height estimates only (real rows are measured after mount).
// Derived from style.css: a video row's 16:9 100px poster is 100·9/16 ≈ 56px
// tall plus the row's 13px×2 padding ≈ 82; a material row's two text lines
// (~43px) plus padding ≈ 69 — the text is taller than the 36px icon tile.
const ROW_EST_VIDEO = 82;
const ROW_EST_MATERIAL = 69;

// Admin lists expose only the "Default" field; both panes default to DESCENDING.
const ADMIN_SORT_FIELDS = [['default', 'Default']];
// Must match the ?limit= clamp in routes/api/admin.js.
const MAX_PAGE_SIZE = 60;

// Maps a coded 403/404 body onto the scoped "gone" pane state. Reads ONLY
// data?.code — never the bare status — so a Cloudflare WAF 403 (HTML body,
// data==null) returns null and falls through to the caller's existing handling.
function goneFromCode(data) {
  if (data?.code === 'COURSE_NOT_FOUND') return 'notfound';
  if (data?.code === 'COURSE_FORBIDDEN' || data?.code === 'PERMISSION_DENIED') return 'forbidden';
  return null;
}

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
function ficoClass(filename) {
  const ext = (filename.split('.').pop() || '').toUpperCase();
  return { PDF: 'fico-pdf', DOC: 'fico-doc', DOCX: 'fico-doc', ZIP: 'fico-zip', CSV: 'fico-csv' }[ext] || 'fico-gen';
}

// Silent-refetch reconcilers. The server re-mints posterToken on EVERY request
// (tokenService.generateFileToken embeds Date.now()), so its VALUE always
// differs even when the row is otherwise identical — a naive compare would call
// every row dirty every poll tick and hand every <img> a fresh src, silently
// reloading the posters. posterToken is therefore compared by PRESENCE only;
// unchanged rows KEEP their previous object (old token, byte-identical src), and
// when every row is unchanged and the length matches the PREVIOUS array is
// returned so the setter gets an Object.is-equal value and React bails.
const POSTER_PRESENCE_ONLY = new Set(['posterToken']);
function rowsEqual(a, b, presenceOnly) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (presenceOnly && presenceOnly.has(k)) { if (!!a[k] !== !!b[k]) return false; }
    else if (a[k] !== b[k]) return false;
  }
  return true;
}
function mergeRows(prev, next, presenceOnly) {
  if (!Array.isArray(prev) || prev.length !== next.length) return next;
  let changed = false;
  const merged = next.map((row, i) => {
    if (rowsEqual(prev[i], row, presenceOnly)) return prev[i];
    changed = true;
    return row;
  });
  return changed ? merged : prev;
}
function mergeCourse(prev, next) {
  if (prev && prev.id === next.id && prev.code === next.code
    && prev.name === next.name && prev.moduleLabel === next.moduleLabel) return prev;
  return next;
}

const ChevronL = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>;
const PlayIcon = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>;
const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /><path d="M9 13h6" /><path d="M9 17h4" />
  </svg>
);
const PencilIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
const StatsBarIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></svg>;
const EditIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
const TrashIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>;
const RetryIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>;
const CleanIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21l6-6" /><path d="M14 4l6 6" /><path d="m9 15 6-11 5 5-11 6-3-3z" /></svg>;

export default function CoursePage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { user, refresh: refreshMe } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const { courses: sidebarCourses, refreshCourses } = useOutletContext() ?? {};

  const perms = user?.permissions || {};
  const canUploadVideo = !!perms.uploadVideo;
  const canChangeVideo = !!perms.changeVideo;
  const canDeleteVideo = !!perms.deleteVideo;
  const canUploadAtt = !!perms.uploadAttachments;
  const canDeleteAtt = !!perms.deleteAttachments;
  const canChangeCourse = !!perms.changeCourse;
  // Playback-stats modal: view needs manageCourse + viewPlaybackStat (server
  // also requires the admin's own course access via requireCourseAccess).
  const canViewStats = !!perms.viewPlaybackStat && !!perms.manageCourse;

  // manageCourse is the gate of the whole admin courses page (matches the
  // Sidebar nav + GET /admin/courses). canSeeVideos still mirrors the server
  // videos GET (uploadVideo|changeVideo); the materials LIST is visible to
  // anyone on the page — accessAttachments now only gates view/download, which
  // the admin materials surface never exposes (rows are edit/delete only).
  const canSeeVideos = canUploadVideo || canChangeVideo;
  const canCourseAdmin = !!perms.manageCourse;
  const canSeeMaterials = canCourseAdmin;

  // Active tab defaults to the FIRST PERMITTED tab (not a hard 'videos'), and a
  // ?tab= only wins when it names a tab this admin may actually see — so a
  // materials-only admin never resolves to 'videos' and never fires its GET.
  const requestedTab = searchParams.get('tab');
  const firstTab = canSeeVideos ? 'videos' : (canSeeMaterials ? 'materials' : null);
  let tab = firstTab;
  if (requestedTab === 'materials' && canSeeMaterials) tab = 'materials';
  else if (requestedTab === 'videos' && canSeeVideos) tab = 'videos';
  const isVideos = tab === 'videos';
  const isMaterials = tab === 'materials';
  const hasTab = isVideos || isMaterials;

  // Fit-to-height paging. One hook keyed on the active tab (like CourseView),
  // with the per-pane rowEst switched for the first paint only.
  const { cardRef, ready, pageSize: fitPageSize, rowH, fitReady } = useFitHeight({
    key: tab,
    rowEst: isVideos ? ROW_EST_VIDEO : ROW_EST_MATERIAL,
  });
  // The videos endpoint clamps ?limit= to MAX_PAGE_SIZE. Clamp here too, or on a
  // tall enough viewport the server would return 60 rows while the page math
  // still offset by the unclamped size, silently skipping rows 61..pageSize.
  const pageSize = Math.min(fitPageSize, MAX_PAGE_SIZE);

  // Page + sort memory per (course, tab). Restored from sessionStorage on mount
  // and reset DURING RENDER when the course/tab changes — NOT in an effect (an
  // effect reset lands after the fetch effect already fired with the previous
  // course's page). Keys are 'admin:'-prefixed so they never collide with the
  // student CourseView's keys for the same course. Both panes default to DESC.
  const memKey = `admin:course:${courseId}:${tab}`;
  const sortMemKey = `admin:sort:${courseId}:${tab}`;
  const readPage = (k) => { const v = parseInt(sessionStorage.getItem(k), 10); return v > 0 ? v : 1; };
  const readSort = (k) => {
    const d = (sessionStorage.getItem(k) || '').split(':')[1];
    return { field: 'default', dir: d === 'asc' ? 'asc' : 'desc' };
  };
  const [page, setPage] = useState(() => readPage(memKey));
  const [sort, setSort] = useState(() => readSort(sortMemKey));
  const [prevKey, setPrevKey] = useState(memKey);
  if (memKey !== prevKey) {
    setPrevKey(memKey);
    setPage(readPage(memKey));
    setSort(readSort(sortMemKey));
  }
  useEffect(() => { sessionStorage.setItem(memKey, String(page)); }, [memKey, page]);
  useEffect(() => { sessionStorage.setItem(sortMemKey, `${sort.field}:${sort.dir}`); }, [sortMemKey, sort]);
  // SortMenu only reports the new {field,dir}; the page reset lives here.
  const changeSort = (next) => { setSort(next); setPage(1); };

  // Course meta (name / code / module label) — set from whichever pane loads;
  // stale-guarded by id so a switch never shows the previous course's name.
  const [course, setCourse] = useState(null);

  // Scoped "this course is gone/forbidden" pane. goneRef mirrors it so the coded
  // handlers fire setGone/refreshCourses/refreshMe at most once per course
  // WITHOUT putting `gone` in any fetch effect / callback deps — that would let
  // refreshMe's setUser re-fire them (the 403→refreshMe→refetch→403 loop) and
  // churn loadVideosSilent's identity. The ref is read synchronously, so
  // repeated poll/late responses (via a stale closure) stay no-ops.
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

  // --- videos (server-paginated + server-sorted) ---
  const [videos, setVideos] = useState([]);
  const [vTotal, setVTotal] = useState(0);
  const [vLoadedCourse, setVLoadedCourse] = useState(null);
  const [r2PublicDomain, setR2PublicDomain] = useState('');
  const [vLoading, setVLoading] = useState(true);
  const posterUrlsRef = useRef({});
  const [posterFailed, setPosterFailed] = useState({});
  const [posterLoaded, setPosterLoaded] = useState({});
  const [posterRetries, setPosterRetries] = useState({});

  // --- materials (fetched once per course, sorted + sliced client-side) ---
  const [materials, setMaterials] = useState(null);
  const [mLoadedCourse, setMLoadedCourse] = useState(null);
  const [mLoading, setMLoading] = useState(true);
  const matForRef = useRef(null);
  // Drop the materials cache when the course changes so stale files don't flash.
  useEffect(() => { setMaterials(null); matForRef.current = null; }, [courseId]);

  const [showUploadVideo, setShowUploadVideo] = useState(false);
  const [showUploadMaterials, setShowUploadMaterials] = useState(false);
  const [editingVideo, setEditingVideo] = useState(null);
  const [editingMaterial, setEditingMaterial] = useState(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const goTab = (t) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'materials') next.set('tab', 'materials'); else next.delete('tab');
      return next;
    });
  };

  // The silent refetches below are fired by the poll and by mutation callbacks,
  // so unlike the primary loads they have no effect-scoped `alive` flag. A request
  // issued for course A / page 1 / dir asc can land after the user switched away;
  // this ref lets a late response recognise itself as stale and drop its result.
  const currentRef = useRef({ courseId, page, dir: sort.dir, limit: pageSize });
  currentRef.current = { courseId, page, dir: sort.dir, limit: pageSize };

  // Silent video refetch — no skeleton flash. Used by the poll and after mutations.
  const loadVideosSilent = useCallback(async () => {
    const req = { courseId, page, dir: sort.dir, limit: pageSize };
    const { data, ok } = await apiGet(`/api/admin/courses/${courseId}/videos?page=${page}&limit=${pageSize}&dir=${sort.dir}`);
    // Drop a stale (superseded) response BEFORE acting on it, so a late
    // forbidden from a course the user already left never blanks the new page.
    const cur = currentRef.current;
    if (cur.courseId !== req.courseId || cur.page !== req.page || cur.dir !== req.dir || cur.limit !== req.limit) return;
    if (markGone(data)) return;
    if (!ok || !data) return;
    setVideos((prev) => mergeRows(prev, data.videos || [], POSTER_PRESENCE_ONLY));
    setVTotal(data.total || 0);
    setR2PublicDomain(data.r2PublicDomain || '');
    setCourse((prev) => mergeCourse(prev, { id: courseId, code: data.course.course_code, name: data.course.course_name, moduleLabel: data.course.module_label }));
    setVLoadedCourse(courseId);
  }, [courseId, page, pageSize, sort.dir]);

  // Primary video load (skeleton) on course / page / sort / fit change — but only
  // once the fit has SETTLED (fitReady), so the estimate→measured pageSize never
  // double-fetches. The server clamps the page; curPage clamps display below.
  // isVideos already encodes canSeeVideos (tab only resolves to 'videos' when the
  // admin may see it), so this never fires the 403-ing GET for a materials admin.
  useEffect(() => {
    if (!isVideos || !fitReady) return undefined;
    let alive = true;
    setVLoading(true);
    apiGet(`/api/admin/courses/${courseId}/videos?page=${page}&limit=${pageSize}&dir=${sort.dir}`)
      .then(({ data, ok }) => {
        if (!alive) return;
        // Coded course-gone/forbidden → scoped pane, then stop. Only on
        // data?.code; a WAF 403 (data==null) falls through to the else-toast.
        if (markGone(data)) { setVLoading(false); return; }
        if (ok && data) {
          setVideos(data.videos || []);
          setVTotal(data.total || 0);
          setR2PublicDomain(data.r2PublicDomain || '');
          setCourse({ id: courseId, code: data.course.course_code, name: data.course.course_name, moduleLabel: data.course.module_label });
          setVLoadedCourse(courseId);
        } else {
          showToast(data?.error || 'Failed to load videos.');
        }
        setVLoading(false);
      })
      .catch(() => { if (alive) { showToast('Failed to load videos.'); setVLoading(false); } });
    return () => { alive = false; };
  }, [isVideos, fitReady, courseId, page, pageSize, sort.dir, showToast]);

  // Silent materials refetch — used after an upload / edit (forced; bypasses the
  // once-per-course guard so a mutation always re-reads the list).
  const reloadMaterials = useCallback(async () => {
    const reqCourse = courseId;
    const { data, ok } = await apiGet(`/api/admin/courses/${courseId}/materials`);
    if (currentRef.current.courseId !== reqCourse) return;
    if (markGone(data)) return;
    if (!ok || !data) return;
    setMaterials((prev) => mergeRows(prev, data.materials || []));
    setCourse((prev) => mergeCourse(prev, { id: courseId, code: data.courseCode, name: data.courseName, moduleLabel: data.moduleLabel }));
    setMLoadedCourse(courseId);
  }, [courseId]);

  // Materials: fetched exactly once per course (the ref guards re-fetch on a
  // videos↔materials toggle). Gated on plain `ready` — the whole list comes back
  // in one request, so it doesn't wait on the settled pageSize the way videos do.
  // Guarded on isMaterials (not !isVideos), so a no-viewable-tab admin never
  // fires the materials GET either.
  useEffect(() => {
    if (!isMaterials || !ready || matForRef.current === courseId) return undefined;
    matForRef.current = courseId;
    let alive = true;
    setMLoading(true);
    apiGet(`/api/admin/courses/${courseId}/materials`)
      .then(({ data, ok }) => {
        if (!alive) return;
        if (markGone(data)) { setMLoading(false); return; }
        if (ok && data) {
          setMaterials(data.materials || []);
          setCourse({ id: courseId, code: data.courseCode, name: data.courseName, moduleLabel: data.moduleLabel });
          setMLoadedCourse(courseId);
        } else {
          setMaterials([]);
          showToast(data?.error || 'Failed to load materials.');
        }
        setMLoading(false);
      })
      .catch(() => { if (alive) { setMaterials([]); showToast('Failed to load materials.'); setMLoading(false); } });
    return () => { alive = false; };
  }, [isMaterials, ready, courseId, showToast]);

  // 2s poll while any visible video is still processing.
  const pollRef = useRef(loadVideosSilent);
  pollRef.current = loadVideosSilent;
  useEffect(() => {
    if (!isVideos) return undefined;
    const busy = videos.some((v) => v.status !== 'finished' && v.status !== 'error');
    if (!busy) return undefined;
    const timer = setInterval(() => pollRef.current(), 2000);
    return () => clearInterval(timer);
  }, [isVideos, videos]);

  const loadedCourse = course && String(course.id) === String(courseId) ? course : null;
  const sidebarCourse = Array.isArray(sidebarCourses) ? sidebarCourses.find((c) => String(c.course_id) === String(courseId)) : null;
  // Match CourseView: the code prefixes the count ONLY when the course has BOTH a
  // name and a code (the name is the title, the code is context). When only the
  // code exists it IS the title, with no prefix.
  const headCode = loadedCourse?.code || sidebarCourse?.course_code || '';
  const headName = loadedCourse?.name || sidebarCourse?.course_name || '';
  const headTitle = headName || headCode || 'Course';
  const moduleLabel = loadedCourse?.moduleLabel ?? sidebarCourse?.module_label ?? null;
  const modTerm = moduleTerm(moduleLabel);

  useEffect(() => {
    if (siteName) document.title = `${headTitle} - ${siteName}`;
  }, [siteName, headTitle]);

  // Materials come back whole, so their sort is applied here (client-side); videos
  // arrive already sorted by the server. Default key order mirrors the student
  // list: module_number → created_at → id, direction applied, NULL module last.
  const sortedMaterials = useMemo(() => {
    if (!materials) return materials;
    const s = sort.dir === 'desc' ? -1 : 1;
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
    return materials.slice().sort((a, b) => byModule(a, b) || byDate(a, b) || byId(a, b));
  }, [materials, sort.dir]);

  const vCountReady = vLoadedCourse === courseId;
  const mCountReady = mLoadedCourse === courseId;
  const countReady = isVideos ? vCountReady : mCountReady;
  const total = isVideos ? vTotal : (sortedMaterials?.length ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp to the valid range for display/slice so a remembered page that's now
  // out of range shows the LAST page instead of a blank card. Raw `page` is left
  // untouched (used only for the fetch URL, persistence, and refs); videos are
  // also clamped server-side.
  const curPage = Math.min(Math.max(page, 1), pages);
  // Skeleton shows purely while DATA loads — NOT gated on fitReady (that flips
  // rows skeleton↔real as the measurement settles, and since material skeleton
  // and real rows differ in height that oscillation never converges → React #185).
  const showSkeleton = isVideos ? (vLoading || !vCountReady) : (mLoading || !mCountReady);
  const skelCount = Math.min(pageSize, 8);
  const matSlice = !isVideos && sortedMaterials ? sortedMaterials.slice((curPage - 1) * pageSize, curPage * pageSize) : [];

  const handleRetry = async (video) => {
    if (!await confirm({ title: 'Re-queue for transcoding?', message: 'This video will be transcoded again from its source file.', confirmLabel: 'Re-queue', danger: false })) return;
    const { ok, data } = await apiPost(`/api/videos/${video.video_id}/retry`);
    if (ok) { showToast('Video re-queued for processing.', 'success'); loadVideosSilent(); }
    else showToast(data?.error || 'Retry failed.');
  };

  const handleCleanSource = async (video) => {
    if (!await confirm({ title: 'Delete source file?', message: 'The original source file will be removed from R2. This can\'t be undone.', confirmLabel: 'Delete', danger: true })) return;
    const { ok, data } = await apiPost(`/api/videos/${video.video_id}/clean-source`);
    if (ok) { showToast('Source file cleaned.', 'success'); loadVideosSilent(); }
    else showToast(data?.error || 'Clean failed.');
  };

  const handleDeleteVideo = async (video) => {
    if (!await confirm({ title: 'Delete video?', message: 'This permanently deletes the video and its transcoded renditions. This can\'t be undone.', confirmLabel: 'Delete', danger: true })) return;
    const { ok, data } = await apiPost(`/api/videos/${video.video_id}/delete`);
    if (!ok) { showToast(data?.error || 'Failed to delete video.'); return; }
    showToast('Video deleted.', 'success');
    // Clamp: removing the last row on a non-first page steps back a page.
    if (videos.length === 1 && curPage > 1) setPage(curPage - 1);
    else loadVideosSilent();
  };

  const handleDeleteMaterial = async (m) => {
    if (!await confirm({ title: 'Delete file?', message: 'This permanently deletes the material file. This can\'t be undone.', confirmLabel: 'Delete', danger: true })) return;
    const { ok, data } = await apiDelete(`/api/materials/${m.material_id}`);
    if (!ok) { showToast(data?.error || 'Failed to delete file.'); return; }
    showToast('File deleted.', 'success');
    const next = (materials || []).filter((x) => x.material_id !== m.material_id);
    setMaterials(next);
    const nPages = Math.max(1, Math.ceil(next.length / pageSize));
    if (page > nPages) setPage(nPages);
  };

  if (!canCourseAdmin) {
    return <div className="vs-cv-empty">You don’t have access to Courses.</div>;
  }

  // Scoped error pane — replaces the content in place (no redirect; the URL
  // stays). Sits above the skeleton/list branch, which would otherwise spin
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
        <Link className="vs-btn vs-btn-primary" to="/admin/courses">Back to courses</Link>
      </div>
    );
  }

  const renderPoster = (video) => {
    // The poster URL carries a per-request HMAC token (generateFileToken embeds
    // Date.now()), so every refetch yields a different `?verify=` string. The
    // poster itself only changes when the video does, so cache the URL against
    // the video's identity rather than rebuilding it from whatever token last
    // arrived — otherwise the 2s processing poll re-downloads every thumbnail.
    // The key freezes while a video is processing: a re-transcode bumps
    // updated_at on every progress tick, and the old poster is still the one on
    // screen. Once it finishes, the fresh updated_at pulls the new poster in.
    const pkey = `${video.has_poster ? 1 : 0}|${video.status === 'finished' ? (video.updated_at || '') : 'proc'}`;
    // Load/fail/retry state hangs off the same key, so a regenerated poster
    // starts clean instead of inheriting the previous image's flags.
    const pid = `${video.video_id}|${pkey}`;

    const hasPoster = video.posterToken && r2PublicDomain && !posterFailed[pid];
    if (!hasPoster) return <div className="vs-cv-play"><PlayIcon /></div>;

    const cached = posterUrlsRef.current[video.video_id];
    let baseSrc;
    if (cached && cached.key === pkey) {
      baseSrc = cached.src;
    } else {
      baseSrc = `https://${r2PublicDomain}/posters/${courseId}/${video.video_id}.jpg?verify=${video.posterToken}`;
      posterUrlsRef.current[video.video_id] = { key: pkey, src: baseSrc };
    }

    const retries = posterRetries[pid] || 0;
    const src = retries > 0 ? `${baseSrc}&r=${retries}` : baseSrc;
    const loaded = !!posterLoaded[pid];
    return (
      <div className={`vs-cv-thumb${loaded ? '' : ' loading'}`}>
        <img
          src={src} alt="" loading="lazy" style={{ opacity: loaded ? 1 : 0 }}
          onLoad={() => setPosterLoaded((p) => ({ ...p, [pid]: true }))}
          onError={() => {
            if (retries >= MAX_POSTER_RETRIES) { setPosterFailed((p) => ({ ...p, [pid]: true })); return; }
            const delay = 500 + retries * 500;
            setTimeout(() => setPosterRetries((p) => ({ ...p, [pid]: (p[pid] || 0) + 1 })), delay);
          }}
        />
      </div>
    );
  };

  const renderVideoRow = (video) => {
    const finished = video.status === 'finished';
    const failed = video.status === 'error';
    let pill = null;
    if (failed) pill = <span className="vs-cv-stb vs-cv-stb-f">Failed</span>;
    else if (!finished) pill = <span className="vs-cv-stb vs-cv-stb-p">Processing{video.processing_progress ? ` ${video.processing_progress}%` : ''}</span>;
    return (
      <div key={video.video_id} className={'vs-cv-row' + (finished ? '' : ' proc')}>
        {renderPoster(video)}
        <div className="vs-cv-rmn">
          <p className="vs-cv-rt" title={video.title}>{video.title}</p>
          <p className="vs-cv-rs">
            {video.module_number != null && <span className="vs-wk">{modTerm} {video.module_number}</span>}
            {video.lecture_date && <span>{video.lecture_date.slice(0, 10)}</span>}
            {video.lecture_date && video.duration_seconds > 0 && <span className="vs-cv-dot">·</span>}
            {video.duration_seconds > 0 && <span>{formatDuration(video.duration_seconds)}</span>}
          </p>
        </div>
        {pill}
        <div className="vs-cv-acts">
          {failed && canChangeVideo && (
            <button className="vs-ico-btn" title="Retry" onClick={() => handleRetry(video)}><RetryIcon /></button>
          )}
          {canChangeVideo && (
            <button className="vs-ico-btn" title="Edit" onClick={() => setEditingVideo(video)}><EditIcon /></button>
          )}
          {canChangeVideo && finished && video.has_source && (
            <button className="vs-ico-btn" title="Clean source file" onClick={() => handleCleanSource(video)}><CleanIcon /></button>
          )}
          {canDeleteVideo && (
            <button className="vs-ico-btn dg" title="Delete" onClick={() => handleDeleteVideo(video)}><TrashIcon /></button>
          )}
        </div>
      </div>
    );
  };

  const renderMaterialRow = (m) => (
    <div key={m.material_id} className="vs-cv-row">
      <span className={`vs-cv-fico ${ficoClass(m.filename)}`}><FileIcon /></span>
      <div className="vs-cv-rmn">
        <p className="vs-cv-rt" title={m.filename}>{m.filename}</p>
        <p className="vs-cv-rs">
          {m.module_number != null && <span className="vs-wk">{modTerm} {m.module_number}</span>}
          {m.file_size > 0 && <span>{formatFileSize(m.file_size)}</span>}
        </p>
      </div>
      <div className="vs-cv-acts">
        {canUploadAtt && (
          <button className="vs-ico-btn" title="Edit" onClick={() => setEditingMaterial(m)}><EditIcon /></button>
        )}
        {canDeleteAtt && (
          <button className="vs-ico-btn dg" title="Delete" onClick={() => handleDeleteMaterial(m)}><TrashIcon /></button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <button className="vs-back" onClick={() => navigate('/admin/courses')}><ChevronL />Courses</button>

      <div className="vs-cv-head">
        <div style={{ minWidth: 0 }}>
          <div className="vs-titlerow">
            <h1 className="vs-cv-title" title={headTitle}>{headTitle}</h1>
            {canChangeCourse && (
              <button className="vs-title-edit" aria-label="Edit course" onClick={() => setShowEdit(true)}><PencilIcon /></button>
            )}
            {canViewStats && (
              <button className="vs-title-edit" aria-label="Playback stats" title="Playback stats" onClick={() => setShowStats(true)}><StatsBarIcon /></button>
            )}
          </div>
          <p className="vs-cv-sub">
            {hasTab ? (
              <>
                {headName && headCode ? `${headCode} · ` : ''}
                {countReady
                  ? (isVideos ? `${total} ${total === 1 ? 'video' : 'videos'}` : `${total} ${total === 1 ? 'file' : 'files'}`)
                  : <span className="vs-cv-skel vs-cv-sub-skel" />}
              </>
            ) : (headName && headCode ? headCode : '')}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {canSeeVideos && canSeeMaterials && (
            <div className="vs-seg">
              <button className={'vs-seg-btn' + (isVideos ? ' on' : '')} onClick={() => goTab('videos')} aria-label="Videos"><PlayIcon /><span className="vs-seg-lbl">Videos</span></button>
              <button className={'vs-seg-btn' + (isMaterials ? ' on' : '')} onClick={() => goTab('materials')} aria-label="Materials"><FileIcon /><span className="vs-seg-lbl">Materials</span></button>
            </div>
          )}
          {isVideos && canUploadVideo && <button className="vs-btn vs-btn-primary" onClick={() => setShowUploadVideo(true)}>Upload</button>}
          {isMaterials && canUploadAtt && <button className="vs-btn vs-btn-primary" onClick={() => setShowUploadMaterials(true)}>Upload</button>}
        </div>
      </div>

      {/* Fixed height (not min-height) so the card — and therefore the pager below
          it — sits at the SAME spot on a full page and a short last page. rowH + 1
          per row budgets the between-row border; before the first measurement
          (rowH 0) the skeleton sizes naturally. */}
      <div className="vs-cv-card" ref={cardRef} style={rowH > 0 ? { height: pageSize * (rowH + 1) } : undefined}>
        {!hasTab ? (
          <div className="vs-cv-empty">You don’t have access to this course’s contents.</div>
        ) : showSkeleton ? (
          // Skeleton rows MUST be the same height as real rows, or useFitHeight
          // measures a shorter rowH on the skeleton (which it settles+freezes on)
          // and derives one row too many — the materials n+1 (a video row's poster
          // tile dominates its height so videos match either way; a material row's
          // height comes from the .vs-cv-rmn text, which the old flat bars
          // under-measured). Mirror the real row's exact box: same fico/poster +
          // the .vs-cv-rt / .vs-cv-rs <p> line boxes with the shimmer bar inline.
          Array.from({ length: skelCount }).map((_, i) => (
            <div className="vs-cv-row" key={i}>
              {isVideos ? <div className="vs-cv-thumb loading" /> : <span className="vs-cv-fico fico-gen" />}
              <div className="vs-cv-rmn">
                <p className="vs-cv-rt"><span className="vs-skln" style={{ width: 150 + ((i * 37) % 90) }}>&nbsp;</span></p>
                <p className="vs-cv-rs"><span className="vs-skln" style={{ width: 90 + ((i * 23) % 60) }}>&nbsp;</span></p>
              </div>
            </div>
          ))
        ) : total === 0 ? (
          <div className="vs-cv-empty">{isVideos ? 'No videos in this course yet.' : 'No materials in this course yet.'}</div>
        ) : isVideos ? (
          videos.map(renderVideoRow)
        ) : (
          matSlice.map(renderMaterialRow)
        )}
      </div>

      {hasTab && !showSkeleton && total > 0 && (
        <VsPager
          page={curPage} pages={pages} total={total}
          from={(curPage - 1) * pageSize + 1} to={Math.min(curPage * pageSize, total)}
          unit={isVideos ? 'videos' : 'files'} onPage={setPage}
          sortControl={<SortMenu fields={ADMIN_SORT_FIELDS} sort={sort} onChange={changeSort} />}
        />
      )}

      {showUploadVideo && (
        <UploadVideoModal
          courseId={courseId}
          moduleLabel={moduleLabel}
          courseCode={headCode}
          onClose={() => setShowUploadVideo(false)}
          onUploaded={() => { setShowUploadVideo(false); loadVideosSilent(); }}
        />
      )}
      {showUploadMaterials && (
        <UploadMaterialsModal
          courseId={courseId}
          moduleLabel={moduleLabel}
          onClose={() => setShowUploadMaterials(false)}
          onUploaded={() => { setShowUploadMaterials(false); reloadMaterials(); }}
        />
      )}
      {editingVideo && (
        <EditVideoModal
          video={editingVideo}
          moduleLabel={moduleLabel}
          canReplace={canUploadVideo}
          onClose={() => setEditingVideo(null)}
          onSaved={() => { setEditingVideo(null); loadVideosSilent(); }}
          onRefresh={loadVideosSilent}
        />
      )}
      {editingMaterial && (
        <EditMaterialModal
          material={editingMaterial}
          moduleLabel={moduleLabel}
          onClose={() => setEditingMaterial(null)}
          onSaved={() => { setEditingMaterial(null); reloadMaterials(); }}
        />
      )}
      {showEdit && (
        <CourseEditModal
          courseId={courseId}
          onClose={() => setShowEdit(false)}
          onCourseChanged={(patch) => {
            setCourse({
              id: courseId,
              code: patch.course_code,
              name: patch.course_name,
              moduleLabel: patch.module_label,
            });
            // Reconcile with the server; (B) means an unchanged video list won't
            // re-render, while a module_label change updates the badges.
            if (isVideos) loadVideosSilent();
            else if (isMaterials) reloadMaterials();
          }}
          onDeleted={() => navigate('/admin/courses')}
        />
      )}
      {showStats && (
        <PlaybackStatsModal
          courseId={courseId}
          courseCode={headCode || headTitle}
          courseName={headName}
          canReset={canChangeCourse}
          onClose={() => setShowStats(false)}
        />
      )}
    </>
  );
}
