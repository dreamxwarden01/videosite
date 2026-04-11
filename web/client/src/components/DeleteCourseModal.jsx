import { useState } from 'react';
import { useToast } from '../context/ToastContext';

export default function DeleteCourseModal({ isOpen, courseName, courseId, onClose, onDeleted, mfaFetch }) {
  const { showToast } = useToast();
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  if (!isOpen) return null;

  const nameMatches = confirmName === courseName;

  const handleDelete = async () => {
    if (!nameMatches) return;
    setDeleting(true);
    try {
      const { ok, data } = await mfaFetch(`/api/admin/courses/${courseId}`, { method: 'DELETE' });
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
    <div className="modal-overlay active" onClick={() => {}}>
      <div className="upload-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
        <div className="modal-header">
          <h3>Delete Course</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: '16px', color: '#991b1b' }}>
            This will permanently delete <strong>{courseName}</strong> and all its videos. This cannot be undone.
          </p>
          <div className="form-group">
            <label htmlFor="deleteConfirmName">Type the course name to confirm:</label>
            <input
              type="text" id="deleteConfirmName" className="form-control"
              value={confirmName} onChange={e => setConfirmName(e.target.value)}
              placeholder={courseName} autoFocus
            />
          </div>
          <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              type="button" className="btn btn-danger"
              disabled={!nameMatches || deleting}
              onClick={handleDelete}
            >
              {deleting ? 'Deleting...' : 'Delete Course'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
