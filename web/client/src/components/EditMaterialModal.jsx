import { useState, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import { apiPut } from '../api';

export default function EditMaterialModal({ isOpen, onClose, onEdited, material }) {
  const { showToast } = useToast();
  const [filename, setFilename] = useState('');
  const [week, setWeek] = useState('');
  const [saving, setSaving] = useState(false);

  // Populate fields when material changes or modal opens
  useEffect(() => {
    if (isOpen && material) {
      setFilename(material.filename || '');
      setWeek(material.week || '');
    }
  }, [isOpen, material]);

  if (!isOpen || !material) return null;

  const filenameValid = filename.trim().length > 0 && filename.trim().length <= 255 && !/[/\\]/.test(filename);
  const weekValid = week.trim().length > 0;
  const hasChanges = filename.trim() !== (material.filename || '') || week.trim() !== (material.week || '');
  const canSave = filenameValid && weekValid && hasChanges && !saving;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const { ok, data } = await apiPut(`/api/materials/${material.material_id}`, {
        filename: filename.trim(),
        week: week.trim() || undefined,
      });
      if (ok) {
        showToast('Material updated.', 'success');
        onEdited();
      } else {
        showToast(data?.error || 'Failed to update material.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay active" onClick={() => {}}>
      <div className="upload-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '480px' }}>
        <div className="modal-header">
          <h3>Edit Material</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="edit_mat_filename">Filename</label>
              <input
                type="text" id="edit_mat_filename"
                className={`form-control${filename && !filenameValid ? ' input-error' : ''}`}
                value={filename}
                onChange={e => setFilename(e.target.value)}
                maxLength={255}
                autoComplete="off"
                autoFocus
              />
              {filename && !filenameValid && (
                <span className="field-error">Filename must be 1-255 characters without path separators.</span>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="edit_mat_week">Week <span style={{ color: '#dc3545' }}>*</span></label>
              <input
                type="text" id="edit_mat_week"
                className="form-control"
                value={week}
                onChange={e => setWeek(e.target.value)}
                maxLength={20}
                autoComplete="off"
              />
            </div>

            <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!canSave}>
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
