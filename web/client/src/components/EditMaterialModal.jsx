import { useState, useEffect } from 'react';
import { apiPut } from '../api';
import { useToast } from '../context/ToastContext';
import { moduleTerm } from '../utils/moduleLabel';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);

export default function EditMaterialModal({ material, moduleLabel, onClose, onSaved }) {
  const { showToast } = useToast();
  const [filename, setFilename] = useState(material.filename || '');
  const [week, setWeek] = useState(material.module_number || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  const trimmedName = filename.trim();
  const filenameValid = trimmedName.length > 0 && trimmedName.length <= 255 && !/[/\\]/.test(filename);
  const weekValid = week.trim().length > 0;
  const hasChanges = trimmedName !== (material.filename || '') || week.trim() !== (material.module_number || '');
  const canSave = filenameValid && weekValid && hasChanges && !saving;

  const moduleWord = moduleTerm(moduleLabel);

  async function handleSave(e) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    const { ok, data } = await apiPut(`/api/materials/${material.material_id}`, {
      filename: trimmedName,
      module_number: week.trim(),
    });
    if (ok) {
      showToast('Material updated.', 'success');
      onSaved();
    } else {
      showToast(data?.error || 'Failed to update material.');
      setSaving(false);
    }
  }

  return (
    <div className="vs-scrim">
      <form className="vs-modal" onSubmit={handleSave}>
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">Edit Material</h3>
          <button type="button" className="vs-modal-x" onClick={onClose} disabled={saving}><CloseIcon /></button>
        </div>
        <div className="vs-modal-body">
          <div className="vs-field">
            <label className="vs-label" htmlFor="edit_mat_filename">Filename</label>
            <input
              type="text" id="edit_mat_filename"
              className={`vs-input${filename && !filenameValid ? ' err' : ''}`}
              value={filename}
              onChange={e => setFilename(e.target.value)}
              maxLength={255}
              autoComplete="off"
              autoFocus
              disabled={saving}
            />
            {filename && !filenameValid && (
              <p className="vs-hint err">Filename must be 1-255 characters without path separators.</p>
            )}
          </div>

          <div className="vs-field">
            <label className="vs-label" htmlFor="edit_mat_module">{moduleWord} number</label>
            <input
              type="text" id="edit_mat_module"
              className="vs-input"
              value={week}
              onChange={e => setWeek(e.target.value)}
              maxLength={50}
              autoComplete="off"
              disabled={saving}
            />
          </div>
        </div>
        <div className="vs-modal-foot">
          <button type="button" className="vs-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="vs-btn vs-btn-primary" disabled={!canSave}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
