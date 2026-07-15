import { useState } from 'react';
import { apiDelete } from '../api';
import { useToast } from '../context/ToastContext';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);

export default function DeleteCourseModal({ courseId, courseCode, onClose, onDeleted }) {
  const { showToast } = useToast();
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const nameMatches = confirmName === courseCode;

  const handleDelete = async () => {
    if (!nameMatches) return;
    setDeleting(true);
    try {
      const { ok, data } = await apiDelete(`/api/admin/courses/${courseId}`);
      if (ok) {
        showToast('Course deleted.', 'success');
        onDeleted();
      } else {
        showToast(data?.error || 'Failed to delete course.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="vs-scrim vs-scrim-nested">
      <div className="vs-modal">
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">Delete Course</h3>
          <button type="button" className="vs-modal-x" onClick={onClose} disabled={deleting}><CloseIcon /></button>
        </div>
        <div className="vs-modal-body">
          <p className="vs-hint err" style={{ marginBottom: '14px' }}>
            Deleting <strong>{courseCode}</strong> removes every video, file, enrolment and watch record tied to it. This cannot be undone.
          </p>
          <div className="vs-field">
            <label className="vs-label" htmlFor="confirm_action">Type the course code to confirm</label>
            <input
              type="text" id="confirm_action" className="vs-input"
              value={confirmName} onChange={e => setConfirmName(e.target.value)}
              placeholder={courseCode} autoFocus autoComplete="off"
              readOnly onFocus={e => e.target.removeAttribute('readOnly')}
            />
          </div>
        </div>
        <div className="vs-modal-foot">
          <button type="button" className="vs-btn" onClick={onClose} disabled={deleting}>Cancel</button>
          <button
            type="button" className="vs-btn vs-btn-danger"
            disabled={!nameMatches || deleting}
            onClick={handleDelete}
          >
            {deleting ? 'Deleting...' : 'Delete Course'}
          </button>
        </div>
      </div>
    </div>
  );
}
