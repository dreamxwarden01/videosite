import { useState } from 'react';
import { useToast } from '../context/ToastContext';
import useMfaChallenge from '../hooks/useMfaChallenge';
import MfaChallengeUI from './MfaChallengeUI';
import { MfaSetupRequiredModal } from './MfaPageGuard';

export default function AddCourseModal({ isOpen, onClose, onCreated, mfaFetch: externalMfaFetch }) {
  const { showToast } = useToast();
  const { mfaFetch: internalMfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();
  const mfaFetch = externalMfaFetch || internalMfaFetch;
  const [courseName, setCourseName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!courseName.trim()) {
      showToast('Course name is required.');
      return;
    }
    setSaving(true);
    try {
      const { ok, data } = await mfaFetch('/api/admin/courses', {
        method: 'POST',
        body: { courseName: courseName.trim(), description: description.trim() }
      });
      if (ok && data?.courseId) {
        showToast('Course created.', 'success');
        onCreated(data.courseId);
      } else {
        showToast(data?.error || 'Failed to create course.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="modal-overlay active" onClick={onClose}>
        <div className="upload-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Add Course</h3>
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="modal-body">
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="addCourseName">Course Name</label>
                <input
                  type="text" id="addCourseName" className="form-control"
                  value={courseName} onChange={e => setCourseName(e.target.value)}
                  autoFocus required
                />
              </div>
              <div className="form-group">
                <label htmlFor="addCourseDesc">Description</label>
                <textarea
                  id="addCourseDesc" className="form-control"
                  value={description} onChange={e => setDescription(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Creating...' : 'Create Course'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
      {mfaState && (
        <MfaChallengeUI isModal challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </>
  );
}
