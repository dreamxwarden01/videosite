import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet } from '../api';
import Pagination from '../components/Pagination';
import LoadingSpinner from '../components/LoadingSpinner';

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
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
  //   1. Server says has_poster (posterPath + posterToken present) AND no
  //      prior load error for this video_id → render <img>.
  //   2. Image previously errored (404 / token expired / network) → swap
  //      to the play-icon glyph. We don't retry within the same page load.
  //   3. No posterPath from the server → straight to play-icon.
  // The CSS sets aspect-ratio: 16/9 on the wrapper so the row height stays
  // uniform whether we render an image or the glyph.
  const renderAvatar = (video) => {
    const hasPoster = video.posterPath && video.posterToken && r2PublicDomain && !posterFailed[video.video_id];
    if (hasPoster) {
      const src = `https://${r2PublicDomain}${video.posterPath}?verify=${video.posterToken}`;
      return (
        <div className="video-poster-thumb">
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setPosterFailed(prev => ({ ...prev, [video.video_id]: true }))}
          />
        </div>
      );
    }
    return <div className="video-play-icon">&#9654;</div>;
  };

  return (
    <div className="card card-page">
      <div className="card-header">
        <div>
          <h2>{course ? course.course_name : <span>&nbsp;</span>}</h2>
          {course && <p className="text-muted text-sm">Course #{course.course_id}</p>}
        </div>
        <Link to="/" className="btn btn-secondary btn-sm">Back to Courses</Link>
      </div>

      <div className={`card-body${loading || refreshing ? ' data-loading' : ''}`}>
        {loading ? (
          <div style={{ minHeight: '120px' }}><LoadingSpinner /></div>
        ) : (
          <>
            {course.description && (
              <p className="text-muted mb-3">{course.description}</p>
            )}

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

      {!loading && pagination.total > 0 && (
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
