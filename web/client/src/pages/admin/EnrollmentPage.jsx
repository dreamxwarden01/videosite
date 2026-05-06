import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function EnrollmentPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const selectedCourseId = searchParams.get('courseId') || '';
  const page = parseInt(searchParams.get('page')) || 1;
  const limit = [10, 20, 50].includes(parseInt(searchParams.get('limit'))) ? parseInt(searchParams.get('limit')) : 10;

  const [courses, setCourses] = useState([]);
  const [enrollmentData, setEnrollmentData] = useState(null);
  const [selectedCourse, setSelectedCourse] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Enrollment Management - ${siteName}`;
  }, [siteName]);

  const fetchData = useCallback(async () => {
    if (!loading) setRefreshing(true);
    try {
      let url = '/api/admin/enrollment';
      const params = [];
      if (selectedCourseId) params.push(`courseId=${selectedCourseId}`);
      if (selectedCourseId) {
        params.push(`page=${page}`);
        params.push(`limit=${limit}`);
      }
      if (params.length) url += '?' + params.join('&');

      const { data, ok } = await mfaPageFetch(url);
      if (ok && data) {
        setCourses(data.courses || []);
        setEnrollmentData(data.enrollmentData || null);
        setSelectedCourse(data.selectedCourse || null);
        setPagination(data.pagination || null);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedCourseId, page, limit, mfaPageFetch]);

  useEffect(() => {
    fetchData();
  }, [fetchData, mfaVerifiedKey]);

  if (!user?.permissions?.manageEnrolment) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const handleCourseChange = (e) => {
    const val = e.target.value;
    if (val) {
      setSearchParams({ courseId: val });
    } else {
      setSearchParams({});
    }
  };

  const updateParams = (newParams) => {
    const current = {};
    if (selectedCourseId) current.courseId = selectedCourseId;
    setSearchParams({ ...current, ...newParams });
  };

  const handleToggleEnrollment = async (userId, courseId, action) => {
    try {
      const { ok, data } = await mfaFetch('/api/admin/enrollment', { method: 'POST', body: { action, userId, courseId } });
      if (ok) {
        showToast('Enrollment updated.', 'success');
        setEnrollmentData(prev => prev ? prev.map(u =>
          u.user_id === userId ? { ...u, is_enrolled: action === 'add' ? 1 : 0 } : u
        ) : prev);
      } else {
        showToast(data?.error || 'Failed to update enrollment.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  if (loading) return <LoadingSpinner />;

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
      <div>
        <h1 className="mb-3">Enrollment Management</h1>

        <div className="card mb-3">
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="courseSelect">Select Course</label>
            <select
              id="courseSelect"
              className="form-control"
              value={selectedCourseId}
              onChange={handleCourseChange}
            >
              <option value="">-- Select a course --</option>
              {courses.map(c => (
                <option key={c.course_id} value={c.course_id}>
                  {c.course_name} ({c.course_id})
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedCourse && enrollmentData && (
          <div className="card">
            <div className="card-header">
              <h2>{selectedCourse.course_name}</h2>
            </div>
            <div className={`table-wrap${refreshing ? ' data-loading' : ''}`}>
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Enrolled</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {enrollmentData.map(u => (
                    <tr key={u.user_id}>
                      <td>{u.display_name} ({u.username})</td>
                      <td>{u.role_name}</td>
                      <td>
                        <span className={`status ${u.is_enrolled ? 'status-finished' : ''}`}>
                          {u.is_enrolled ? 'Enrolled' : 'Not enrolled'}
                        </span>
                      </td>
                      <td>
                        {u.is_enrolled ? (
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => handleToggleEnrollment(u.user_id, selectedCourse.course_id, 'remove')}
                          >
                            Remove
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleToggleEnrollment(u.user_id, selectedCourse.course_id, 'add')}
                          >
                            Enroll
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination && (
              <Pagination
                page={pagination.page}
                totalPages={pagination.totalPages}
                total={pagination.total}
                limit={pagination.limit}
                onPageChange={(p) => updateParams({ page: p })}
                onLimitChange={(l) => updateParams({ page: 1, limit: l })}
                itemLabel="user"
              />
            )}
          </div>
        )}
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
