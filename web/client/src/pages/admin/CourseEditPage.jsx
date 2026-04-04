import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function CourseEditPage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const isEdit = Boolean(courseId);

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);

  // Course form
  const [courseName, setCourseName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState('1');
  const [courseInfo, setCourseInfo] = useState(null);

  useEffect(() => {
    document.title = `${isEdit ? 'Edit Course' : 'Add Course'} - ${siteName}`;
  }, [isEdit, siteName]);

  const fetchCourse = useCallback(async () => {
    if (!isEdit) return;
    try {
      const { data, ok } = await mfaPageFetch(`/api/admin/courses/${courseId}/edit`);
      if (ok && data) {
        setCourseInfo(data.course);
        setCourseName(data.course.course_name);
        setDescription(data.course.description || '');
        setIsActive(data.course.is_active ? '1' : '0');
      }
    } catch {
      showToast('Failed to load course.');
    } finally {
      setLoading(false);
    }
  }, [courseId, isEdit, mfaPageFetch]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse, mfaVerifiedKey]);

  const requiredPerm = isEdit ? 'changeCourse' : 'addCourse';
  if (!user?.permissions?.[requiredPerm]) {
    return <p className="text-muted">Permission denied.</p>;
  }

  if (loading) return <LoadingSpinner />;

  const handleSave = async (e) => {
    e.preventDefault();
    if (!courseName.trim()) {
      showToast('Course name is required.');
      return;
    }

    setSaving(true);
    try {
      const body = { courseName, description };
      if (isEdit) body.is_active = isActive;

      const url = isEdit ? `/api/admin/courses/${courseId}` : '/api/admin/courses';
      const { ok, data } = await mfaFetch(url, { method: isEdit ? 'PUT' : 'POST', body });
      if (ok) {
        showToast(isEdit ? 'Course updated.' : 'Course created.', 'success');
        if (!isEdit && data?.courseId) {
          navigate(`/admin/courses/${data.courseId}/edit`);
        } else if (!isEdit) {
          navigate('/admin/courses');
        } else {
          fetchCourse();
        }
      } else {
        showToast(data?.error || 'Failed to save course.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <h1 className="mb-3">{isEdit ? 'Edit Course' : 'Add Course'}</h1>

      <div className="card">
        <form onSubmit={handleSave} style={{ maxWidth: '600px' }}>
          <div className="form-group">
            <label htmlFor="courseName">Course Name</label>
            <input
              type="text" id="courseName" className="form-control"
              value={courseName} onChange={e => setCourseName(e.target.value)} required
            />
          </div>
          <div className="form-group">
            <label htmlFor="description">Description</label>
            <textarea
              id="description" className="form-control"
              value={description} onChange={e => setDescription(e.target.value)}
            />
          </div>
          {isEdit && (
            <>
              <div className="form-group">
                <label htmlFor="is_active">Status</label>
                <select id="is_active" className="form-control" value={isActive} onChange={e => setIsActive(e.target.value)}>
                  <option value="1">Active</option>
                  <option value="0">Inactive</option>
                </select>
              </div>
              {courseInfo && (
                <p className="text-muted text-sm mb-3">
                  Course ID: {courseInfo.course_id}
                </p>
              )}
            </>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Course'}
            </button>
            <Link to="/admin/courses" className="btn btn-secondary">Cancel</Link>
          </div>
        </form>
      </div>

      {mfaState && (
        <MfaChallengeUI isModal={true}
          challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </div>
    </MfaPageGuard>
  );
}
