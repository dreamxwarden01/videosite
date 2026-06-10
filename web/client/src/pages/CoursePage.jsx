import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet } from '../api';
import Pagination from '../components/Pagination';

// Poster reload budget. The img re-fires onError on any non-2xx and on
// network-level failures, with no status visibility. We retry blindly
// up to this many times before giving up on the poster and falling
// through to the play-icon glyph.
const MAX_POSTER_RETRIES = 10;

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Skeleton row used during both initial load and pagination switch.
// Carries .video-item so it shares the real row's flex layout, padding,
// and bottom border — the skeleton lines up pixel-for-pixel with what
// replaces it. The inner meta line reuses .video-meta to inherit the
// same flex gap/wrap behavior, so the week-badge / date / duration
// placeholders sit on a row the same way the real spans do.
function SkeletonRow() {
  return (
    <div className="video-item skeleton-row">
      <div className="skeleton skeleton-poster" style={{ width: 100, aspectRatio: '16 / 9', flexShrink: 0 }} />
      <div className="video-info">
        <div className="skeleton skeleton-video-title" />
        <div className="video-meta">
          <div className="skeleton skeleton-meta-badge" />
          <div className="skeleton skeleton-meta-date" />
          <div className="skeleton skeleton-meta-duration" />
        </div>
      </div>
      <div className="video-actions">
        <div className="skeleton skeleton-status-pill" />
      </div>
    </div>
  );
}

export default function CoursePage() {
  const { courseId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  // Truthy check: /api/me only ships granted permissions, so a denied
  // permission is `undefined`, never `false`.
  const canPlay = !!user?.permissions?.allowPlayback;

  // One-shot restore: read from sessionStorage on mount (returning from watch page), then clear
  const storageKey = `course:${courseId}:list`;
  const [savedState] = useState(() => {
    try {
      const val = JSON.parse(sessionStorage.getItem(storageKey));
      sessionStorage.removeItem(storageKey);
      return val;
    } catch { return null; }
  });

  const urlPage = searchParams.get('page');
  const urlLimit = searchParams.get('limit');
  // URL params take priority; savedState is fallback only on initial mount with no params
  const page = parseInt(urlPage) || (savedState?.page ?? 1);
  const limit = [10, 20, 50].includes(parseInt(urlLimit)) ? parseInt(urlLimit) : (savedState?.limit ?? 10);

  const [course, setCourse] = useState(null);
  const [videos, setVideos] = useState([]);
  const [r2PublicDomain, setR2PublicDomain] = useState('');
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 10 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Track which video posters 404'd / errored so we can swap to the play-icon
  // without keeping a broken <img> in the DOM. Keyed by video_id.
  const [posterFailed, setPosterFailed] = useState({});
  // Track which posters have finished loading. Keyed by video_id. The
  // wrapper carries `.loading` (shimmer bg) until the entry flips true,
  // at which point the bg snaps to dark and the img fades in.
  const [posterLoaded, setPosterLoaded] = useState({});
  // Cache of poster URLs by video_id. Each /api/courses fetch mints a
  // fresh posterToken — without this cache the auto-refresh (every 5 s
  // while a sibling video is processing) would change img.src on every
  // poll, triggering a re-fetch from R2 even though the image hasn't
  // actually changed. We cache the first URL we compute per video and
  // reuse it for the lifetime of the page. New videos (e.g. one that
  // just finished transcoding and flipped has_poster=1) get their URL
  // on first appearance, so the freshly-available poster still loads.
  const posterUrlsRef = useRef({});
  // Per-video retry counter for poster loads. Bumped on every `<img>`
  // onError firing, capped at MAX_POSTER_RETRIES. The count is appended
  // to the URL as `&r=N` so React (and the browser) see a different src
  // and actually re-fetch instead of serving the cached failure. After
  // MAX_POSTER_RETRIES the entry flips to posterFailed and the play-icon
  // glyph takes over. Transient failures the browser bubbles up as
  // onError include: 429 from R2, 5xx from the edge, TCP RST, TLS
  // handshake fail, DNS hiccups, and any network stall the cellular
  // stack gives up on. Linear backoff 0.5/1/1.5/.../5 s — total wait
  // across 10 retries is ~27.5 s, which comfortably outlasts an LTE
  // handoff or a 30 s edge cool-down.
  const [posterRetries, setPosterRetries] = useState({});

  const fetchCourse = useCallback(async (silent = false) => {
    if (!silent) { if (!loading) setRefreshing(true); }
    try {
      const { data, ok } = await apiGet(`/api/courses/${courseId}?page=${page}&limit=${limit}`);
      if (ok && data) {
        setCourse(data.course);
        setVideos(data.videos || []);
        setR2PublicDomain(data.r2PublicDomain || '');
        setPagination(data.pagination);
        if (siteName) document.title = `${data.course.course_name} - ${siteName}`;
      }
    } catch {
      if (!silent) showToast('Failed to load course.');
    }
    setLoading(false);
    setRefreshing(false);
  }, [courseId, page, limit, siteName]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse]);

  // Auto-refresh every 5s while any video is processing
  const fetchCourseRef = useRef(fetchCourse);
  fetchCourseRef.current = fetchCourse;
  useEffect(() => {
    const hasProcessing = videos.some(v => v.status !== 'finished' && v.status !== 'error');
    if (!hasProcessing) return;
    const timer = setInterval(() => fetchCourseRef.current(true), 5000);
    return () => clearInterval(timer);
  }, [videos]);

  // posterLoaded / posterFailed / posterRetries deliberately persist
  // across `videos` changes. Stale entries for video_ids that aren't
  // currently rendered are harmless; what matters is that re-appearing
  // video_ids (during auto-refresh or back-pagination) keep their
  // `loaded` flag so the skeleton doesn't flash. Failed entries persist
  // too — once the MAX_POSTER_RETRIES budget is exhausted we treat the
  // poster as permanently broken for this session (likely a 404 or a
  // bad token, neither of which retries cure). A full page reload
  // resets all three maps. Retry counts persist so partial budgets
  // carry across pagination — e.g. if a poster failed 3 times on page
  // 1, navigates to page 2, comes back, it gets 7 more shots, not 10.

  const updateParams = (newPage, newLimit) => {
    // Always include page so URL params override the one-shot sessionStorage restore
    const params = { page: String(newPage) };
    if (newLimit !== 10) params.limit = String(newLimit);
    setSearchParams(params);
  };

  if (!loading && !course) {
    return <p className="text-muted">Course not found.</p>;
  }

  // Avatar slot for a video row. Three-way fallback:
  //   1. Server says has_poster (posterPath + posterToken present) AND
  //      the retry budget isn't exhausted → render <img>. Wrapper shows
  //      the skeleton shimmer until onLoad fires, then the img fades in
  //      over the dark letterbox bg. On any onError we schedule a
  //      delayed bump of posterRetries — that changes the URL (via
  //      `&r=N`) and triggers a fresh fetch.
  //   2. MAX_POSTER_RETRIES exceeded for this video_id → swap to the
  //      play-icon glyph. Most likely the object 404s or the token is
  //      bad; either way more retries won't help.
  //   3. No posterPath from the server → straight to play-icon.
  // The CSS sets aspect-ratio: 16/9 on the wrapper so the row height stays
  // uniform whether we render an image or the glyph.
  const renderAvatar = (video) => {
    const hasPoster = video.posterToken && r2PublicDomain && !posterFailed[video.video_id];
    if (hasPoster) {
      // Cached base URL stays stable across auto-refresh polls. We only
      // generate it the first time we see this video_id with a poster
      // present; after that, the same URL is reused. If the backing
      // token expires the cached image is already in the browser's
      // memory cache, so the rendered <img> keeps showing the old data
      // — no 403 visible to the user.
      //
      // Path is `/posters/{course_id}/{video_id}.jpg` — same shape the
      // server signs the token against. The server stopped shipping
      // posterPath since the client has all the parts already.
      let baseSrc = posterUrlsRef.current[video.video_id];
      if (!baseSrc) {
        baseSrc = `https://${r2PublicDomain}/posters/${courseId}/${video.video_id}.jpg?verify=${video.posterToken}`;
        posterUrlsRef.current[video.video_id] = baseSrc;
      }
      const retries = posterRetries[video.video_id] || 0;
      // Append `&r=N` so React + the browser see a distinct URL on each
      // retry attempt. Without this, the failed fetch is in the memory
      // cache and the browser would just replay the same failure.
      const src = retries > 0 ? `${baseSrc}&r=${retries}` : baseSrc;
      const loaded = !!posterLoaded[video.video_id];
      return (
        <div className={`video-poster-thumb ${loaded ? '' : 'loading'}`}>
          <img
            src={src}
            alt=""
            loading="lazy"
            onLoad={() => setPosterLoaded(prev => ({ ...prev, [video.video_id]: true }))}
            onError={() => {
              // Closure-captured `retries` reflects the count at render
              // time, which matches the URL the browser actually tried.
              // After MAX, give up — fall through to play-icon glyph.
              if (retries >= MAX_POSTER_RETRIES) {
                setPosterFailed(prev => ({ ...prev, [video.video_id]: true }));
                return;
              }
              // Linear backoff: 0.5/1/1.5/.../5 s. The setState uses the
              // functional form so it stays correct even if other img
              // errors land for sibling videos in between.
              const delay = 500 + retries * 500;
              setTimeout(() => {
                setPosterRetries(prev => ({
                  ...prev,
                  [video.video_id]: (prev[video.video_id] || 0) + 1,
                }));
              }, delay);
            }}
            style={{ opacity: loaded ? 1 : 0 }}
          />
        </div>
      );
    }
    return <div className="video-play-icon">&#9654;</div>;
  };

  // The video list shows skeleton rows on initial fetch AND on
  // pagination switch — the per-page videos always change, so a flash
  // of skeleton + new content reads correctly. Auto-refresh polls
  // (silent=true) don't trigger either flag, so processing-status
  // updates stay live in place.
  const showListSkeleton = loading || refreshing;
  // The course header (title / "Course #N") and the description above
  // the list only skeleton on the INITIAL load — pagination keeps the
  // same course, so those values don't change and showing a fresh
  // placeholder every time the user clicks Next is just noise. After
  // first load `course` stays populated across refreshes, so we render
  // the real values until something else clears them (route change, etc.).
  const showHeaderSkeleton = loading || !course;
  const skeletonCount = Math.min(limit, 8);

  return (
    <div className="card card-page">
      <div className="card-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          {showHeaderSkeleton ? (
            <>
              <div className="skeleton skeleton-page-title" />
              <div className="skeleton skeleton-page-subtitle" />
            </>
          ) : (
            <>
              <h2>{course.course_name}</h2>
              <p className="text-muted text-sm">Course #{course.course_id}</p>
            </>
          )}
        </div>
        <Link to="/" className="btn btn-secondary btn-sm">Back to Courses</Link>
      </div>

      <div className="card-body">
        {/* Description sits above whatever's in the body (skeleton or
            real rows) — once `course` is populated it survives
            pagination refreshes so the user keeps reading what they
            were reading. */}
        {course?.description && (
          <p className="text-muted mb-3">{course.description}</p>
        )}
        {showListSkeleton ? (
          <div>
            {Array.from({ length: skeletonCount }).map((_, i) => <SkeletonRow key={i} />)}
          </div>
        ) : (
          <>
            {/* (description rendered above; this branch is just for the list) */}

            {videos.length === 0 && pagination.total === 0 ? (
              <p className="text-muted">No videos in this course yet.</p>
            ) : (
              <div>
                {videos.map(video => (
                  video.status === 'finished' && canPlay ? (
                    <Link
                      key={video.video_id}
                      to={`/watch/${video.video_id}`}
                      className="video-item"
                      style={{ textDecoration: 'none', color: 'inherit' }}
                      onClick={() => sessionStorage.setItem(storageKey, JSON.stringify({ page, limit }))}
                    >
                      {renderAvatar(video)}
                      <div className="video-info">
                        <h4>{video.title}</h4>
                        <div className="video-meta">
                          {video.week && <span className="week-badge">Week {video.week}</span>}
                          {video.lecture_date && <span>{video.lecture_date.slice(0, 10)}</span>}
                          {video.duration_seconds > 0 && <span>{formatDuration(video.duration_seconds)}</span>}
                        </div>
                      </div>
                      <div className="video-actions">
                        <span className="status status-finished">Available</span>
                      </div>
                    </Link>
                  ) : video.status === 'finished' && !canPlay ? (
                    <div key={video.video_id} className="video-item disabled">
                      {renderAvatar(video)}
                      <div className="video-info">
                        <h4>{video.title}</h4>
                        <div className="video-meta">
                          {video.week && <span className="week-badge">Week {video.week}</span>}
                          {video.lecture_date && <span>{video.lecture_date.slice(0, 10)}</span>}
                          {video.duration_seconds > 0 && <span>{formatDuration(video.duration_seconds)}</span>}
                        </div>
                      </div>
                      <div className="video-actions">
                        <span className="status status-finished">Available</span>
                      </div>
                    </div>
                  ) : (
                    <div key={video.video_id} className="video-item disabled">
                      <div className="video-info">
                        <h4>{video.title}</h4>
                        <div className="video-meta">
                          {video.week && <span className="week-badge">Week {video.week}</span>}
                          {video.lecture_date && <span>{video.lecture_date.slice(0, 10)}</span>}
                          {video.duration_seconds > 0 && <span>{formatDuration(video.duration_seconds)}</span>}
                        </div>
                      </div>
                      <div className="video-actions">
                        {video.status === 'error' ? (
                          <span className="status status-error">Error</span>
                        ) : (
                          <span className="status status-processing">
                            {video.status.replace(/_/g, ' ')} {video.processing_progress ? video.processing_progress + '%' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {!showListSkeleton && pagination.total > 0 && (
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          limit={pagination.limit}
          onPageChange={(p) => updateParams(p, limit)}
          onLimitChange={(l) => updateParams(1, l)}
          itemLabel="video"
        />
      )}
    </div>
  );
}
