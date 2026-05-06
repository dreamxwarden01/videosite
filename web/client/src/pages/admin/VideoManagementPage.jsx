import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSite } from '../../context/SiteContext';
import { useToast } from '../../context/ToastContext';
import { apiGet } from '../../api';
import Pagination from '../../components/Pagination';
import UploadModal from '../../components/UploadModal';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function VideoManagementPage() {
  const { user } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [showUploadModal, setShowUploadModal] = useState(false);

  const fetchCourses = useCallback(async () => {
    try {
      const { data, ok } = await apiGet('/api/courses');
      if (ok && data?.courses) {
        setCourses(data.courses);
      }
    } catch (err) {
      showToast('Failed to load courses', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses]);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Video Management - ${siteName}`;
  }, [siteName]);

  if (!user?.permissions?.uploadVideo && !user?.permissions?.changeVideo) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const total = courses.length;
  const totalPages = Math.ceil(total / limit);
  const paginatedCourses = courses.slice((page - 1) * limit, page * limit);

  const handlePageChange = (newPage) => setPage(newPage);
  const handleLimitChange = (newLimit) => {
    setLimit(newLimit);
    setPage(1);
  };

  if (loading) return <LoadingSpinner />;

  return (
    <div>
      <div className="flex-between mb-3">
        <h1>Video Management</h1>
        {user.permissions.uploadVideo && (
          <button className="btn btn-primary" onClick={() => setShowUploadModal(true)}>Upload a Video</button>
        )}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Course Name</th>
                <th>Video Count</th>
                <th>Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {paginatedCourses.map(c => (
                <tr
                  key={c.course_id}
                  className="clickable-row"
                  onClick={() => navigate(`/admin/videos/${c.course_id}`)}
                >
                  <td>{c.course_name}</td>
                  <td>{c.video_count || 0}</td>
                  <td>{c.last_video_at ? new Date(c.last_video_at).toLocaleDateString() : '-'}</td>
                </tr>
              ))}
              {courses.length === 0 && (
                <tr>
                  <td colSpan="3" className="text-muted" style={{ textAlign: 'center', padding: '20px' }}>
                    No courses available
                  </td>
                </tr>
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
          itemLabel="course"
        />
      </div>

      {showUploadModal && (
        <UploadModal
          isOpen
          courses={courses}
          preselectedCourseId={null}
          onClose={() => setShowUploadModal(false)}
          onUploadComplete={() => { setShowUploadModal(false); fetchCourses(); }}
        />
      )}
    </div>
  );
}
