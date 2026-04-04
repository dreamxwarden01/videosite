import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function CoursesPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [courses, setCourses] = useState([]);
  const [page, setPage] = useState(parseInt(searchParams.get('page')) || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    document.title = `Course Management - ${siteName}`;
  }, [siteName]);

  const fetchCourses = useCallback(async () => {
    if (!loading) setRefreshing(true);
    try {
      const { data, ok } = await mfaPageFetch(`/api/admin/courses?page=${page}&limit=${limit}`);
      if (ok && data) {
        setCourses(data.courses || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, mfaPageFetch]);

  useEffect(() => {
    fetchCourses();
  }, [fetchCourses, mfaVerifiedKey]);

  if (!user?.permissions?.manageCourse) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const handleDelete = async (courseId, courseName) => {
    if (!await confirm('Delete this course and all its videos?')) return;
    try {
      const { ok, data } = await mfaFetch(`/api/admin/courses/${courseId}`, { method: 'DELETE' });
      if (ok) {
        showToast('Course deleted.', 'success');
        fetchCourses();
      } else {
        showToast(data?.error || 'Failed to delete course.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const handlePageChange = (newPage) => {
    setPage(newPage);
    setSearchParams({ page: newPage });
  };

  const handleLimitChange = (newLimit) => {
    setLimit(newLimit);
    setPage(1);
    setSearchParams({ page: 1 });
  };

  if (loading) return <LoadingSpinner />;

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
      <div>
        <div className="flex-between mb-3">
          <h1>Course Management</h1>
          {user.permissions.addCourse && (
            <Link to="/admin/courses/new" className="btn btn-primary">Add Course</Link>
          )}
        </div>

        <div className="card">
          <div className={`table-wrap${refreshing ? ' data-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Videos</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {courses.map(course => (
                  <tr key={course.course_id}>
                    <td>{course.course_id}</td>
                    <td>{course.course_name}</td>
                    <td>{course.video_count || 0}</td>
                    <td>
                      <span className={`status ${course.is_active ? 'status-finished' : 'status-error'}`}>
                        {course.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>{new Date(course.created_at).toLocaleDateString()}</td>
                    <td>
                      {user.permissions.changeCourse && (
                        <Link to={`/admin/courses/${course.course_id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                      )}
                      {user.permissions.deleteCourse && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(course.course_id, course.course_name)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {courses.length === 0 && (
                  <tr>
                    <td colSpan="6" className="text-muted" style={{ textAlign: 'center', padding: '20px' }}>
                      No courses yet
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
      </div>

      {mfaState && (
        <MfaChallengeUI isModal={true}
          challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </MfaPageGuard>
  );
}
