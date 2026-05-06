import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSite } from '../../context/SiteContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import { apiGet, apiPost } from '../../api';
import Pagination from '../../components/Pagination';
import UploadModal from '../../components/UploadModal';
import EditVideoModal from '../../components/EditVideoModal';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function VideoListPage() {
  const { courseId } = useParams();
  const { user } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const [courseName, setCourseName] = useState('');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(parseInt(searchParams.get('page')) || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(10);

  const [showUploadModal, setShowUploadModal] = useState(false);
  const [courses, setCourses] = useState([]);
  const [editingVideo, setEditingVideo] = useState(null);

  const fetchVideos = useCallback(async () => {
    try {
      const { data, ok } = await apiGet(`/api/admin/videos/${courseId}?page=${page}&limit=${limit}`);
      if (ok && data) {
        setCourseName(data.course?.course_name || '');
        setVideos(data.videos || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      }
    } catch (err) {
      showToast('Failed to load videos', 'error');
    } finally {
      setLoading(false);
    }
  }, [courseId, page, limit, showToast]);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  // Set page title
  useEffect(() => {
    if (!siteName) return;
    document.title = `Videos${courseName ? ` - ${courseName}` : ''} - ${siteName}`;
  }, [courseName, siteName]);

  // Auto-refresh every 2s while any video is processing
  const fetchVideosRef = useRef(fetchVideos);
  fetchVideosRef.current = fetchVideos;
  useEffect(() => {
    const hasProcessing = videos.some(v => v.status !== 'finished' && v.status !== 'error');
    if (!hasProcessing) return;
    const timer = setInterval(() => fetchVideosRef.current(), 2000);
    return () => clearInterval(timer);
  }, [videos]);

  // Fetch course list for upload modal
  useEffect(() => {
    apiGet('/api/courses').then(({ data, ok }) => {
      if (ok && data?.courses) setCourses(data.courses);
    });
  }, []);

  if (!user?.permissions?.uploadVideo && !user?.permissions?.changeVideo) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const handlePageChange = (newPage) => {
    setPage(newPage);
    setSearchParams({ page: newPage });
  };
  const handleLimitChange = (newLimit) => {
    setLimit(newLimit);
    setPage(1);
    setSearchParams({ page: 1 });
  };

  const getVideoStatusLabel = (video) => {
    if (video.status === 'finished') return 'Available';
    if (video.status === 'error') return 'Error';
    return `${video.status.replace('_', ' ')} ${video.processing_progress || 0}%`;
  };

  const handleRetry = async (videoId) => {
    if (!await confirm('Re-queue this video for transcoding?')) return;
    try {
      const { ok, data } = await apiPost(`/api/videos/${videoId}/retry`);
      if (ok) {
        showToast('Video re-queued for processing.', 'success');
        fetchVideos();
      } else {
        showToast(data?.error || 'Retry failed.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleDeleteVideo = async (videoId) => {
    if (!await confirm('Delete this video? This cannot be undone.')) return;
    try {
      const { ok, data } = await apiPost(`/api/videos/${videoId}/delete`);
      if (ok) {
        showToast('Video deleted.', 'success');
        fetchVideos();
      } else {
        showToast(data?.error || 'Failed to delete video.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleCleanSource = async (videoId) => {
    if (!await confirm('Delete the original source file from R2? This cannot be undone.')) return;
    try {
      const { ok, data } = await apiPost(`/api/videos/${videoId}/clean-source`);
      if (ok) {
        showToast('Source file cleaned.', 'success');
        fetchVideos();
      } else {
        showToast(data?.error || 'Clean failed.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      {/* Header card bar */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: '16px' }}>
        <div className="flex-between">
          <div className="flex gap-2" style={{ alignItems: 'center' }}>
            <Link to="/admin/videos" className="btn btn-secondary btn-sm">Back</Link>
            <h2 style={{ margin: 0 }}>{courseName}</h2>
          </div>
          {user.permissions.uploadVideo && (
            <button className="btn btn-primary" onClick={() => setShowUploadModal(true)}>Upload a Video</button>
          )}
        </div>
      </div>

      {/* Video list */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Week</th>
                <th>Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {videos.map(video => (
                <tr key={video.video_id}>
                  <td>{video.title}</td>
                  <td>{video.week || '-'}</td>
                  <td>{video.lecture_date ? video.lecture_date.slice(0, 10) : '-'}</td>
                  <td>
                    <span className={`status status-${video.status}`}>
                      {getVideoStatusLabel(video)}
                    </span>
                    {video.processing_error && (
                      <span className="text-sm text-muted" title={video.processing_error}> (!)</span>
                    )}
                  </td>
                  <td>
                    {video.status === 'error' && user.permissions.uploadVideo && (
                      <button className="btn btn-warning btn-sm" onClick={() => handleRetry(video.video_id)}>Retry</button>
                    )}
                    {user.permissions.changeVideo && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingVideo(video)}>Edit</button>
                    )}
                    {user.permissions.deleteVideo && (
                      <button className="btn btn-danger btn-sm" onClick={() => handleDeleteVideo(video.video_id)}>Delete</button>
                    )}
                    {user.permissions.changeVideo && video.status === 'finished' && video.has_source && (
                      <button className="btn btn-warning btn-sm" onClick={() => handleCleanSource(video.video_id)}>Clean Source</button>
                    )}
                  </td>
                </tr>
              ))}
              {videos.length === 0 && (
                <tr><td colSpan="5" className="text-muted" style={{ textAlign: 'center', padding: '20px' }}>No videos yet</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={limit}
          onPageChange={handlePageChange}
          onLimitChange={handleLimitChange}
          itemLabel="video"
        />
      </div>

      {/* Edit Video Modal */}
      <EditVideoModal
        isOpen={!!editingVideo}
        video={editingVideo}
        courseName={courseName}
        canReplace={!!user.permissions.uploadVideo}
        onClose={() => setEditingVideo(null)}
        onComplete={() => { setEditingVideo(null); fetchVideos(); }}
      />

      {/* Upload Modal */}
      {showUploadModal && (
        <UploadModal
          isOpen
          courses={courses}
          preselectedCourseId={courseId}
          preselectedCourseName={courseName}
          onClose={() => setShowUploadModal(false)}
          onUploadComplete={() => { setShowUploadModal(false); fetchVideos(); }}
        />
      )}
    </div>
  );
}
