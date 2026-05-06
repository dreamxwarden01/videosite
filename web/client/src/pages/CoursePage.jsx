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
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 10 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchCourse = useCallback(async (silent = false) => {
    if (!silent) { if (!loading) setRefreshing(true); }
    try {
      const { data, ok } = await apiGet(`/api/courses/${courseId}?page=${page}&limit=${limit}`);
      if (ok && data) {
        setCourse(data.course);
        setVideos(data.videos || []);
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
                      <div className="video-play-icon">&#9654;</div>
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
                      <div className="video-play-icon">&#9654;</div>
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
