import { useState, useEffect } from 'react';
import { useToast } from '../context/ToastContext';

export default function DeleteUserModal({ isOpen, username, userId, onClose, onDeleted, mfaFetch }) {
  const { showToast } = useToast();
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Reset confirm input when modal opens
  useEffect(() => {
    if (isOpen) setConfirmName('');
  }, [isOpen]);

  if (!isOpen) return null;

  const nameMatches = confirmName === username;

  const handleDelete = async () => {
    if (!nameMatches) return;
    setDeleting(true);
    try {
      const { ok, data } = await mfaFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (ok) {
        showToast('User deleted.', 'success');
        onDeleted();
      } else {
        showToast(data?.error || 'Failed to delete user.');
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
          <h3>Delete User</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: '16px', color: '#991b1b' }}>
            This will permanently delete <strong>{username}</strong> and all their data. This cannot be undone.
          </p>
          <div className="form-group">
            <label htmlFor="confirm_action">Type the username to confirm:</label>
            <input
              type="text" id="confirm_action" className="form-control"
              value={confirmName} onChange={e => setConfirmName(e.target.value)}
              placeholder={username} autoFocus autoComplete="off"
              readOnly onFocus={e => e.target.removeAttribute('readOnly')}
            />
          </div>
          <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              type="button" className="btn btn-danger"
              disabled={!nameMatches || deleting}
              onClick={handleDelete}
            >
              {deleting ? 'Deleting...' : 'Delete User'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
