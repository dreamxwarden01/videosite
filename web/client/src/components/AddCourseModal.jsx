import { useState } from 'react';
import { apiPost } from '../api';
import { useToast } from '../context/ToastContext';
import { MODULE_LABELS, moduleTerm } from '../utils/moduleLabel';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);

export default function AddCourseModal({ onClose, onCreated }) {
  const { showToast } = useToast();
  const [courseCode, setCourseCode] = useState('');
  const [courseName, setCourseName] = useState('');
  const [moduleLabel, setModuleLabel] = useState('week');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!courseCode.trim()) {
      showToast('Course code is required.');
      return;
    }
    setSaving(true);
    try {
      const { ok, data } = await apiPost('/api/admin/courses', {
        courseCode: courseCode.trim(), courseName: courseName.trim(), moduleLabel
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
    <div className="vs-scrim">
      <form className="vs-modal" onSubmit={handleSubmit}>
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">Add Course</h3>
          <button type="button" className="vs-modal-x" onClick={onClose} disabled={saving}><CloseIcon /></button>
        </div>
        <div className="vs-modal-body">
          <div className="vs-field">
            <label className="vs-label" htmlFor="addCourseCode">Course Code</label>
            <input
              type="text" id="addCourseCode" className="vs-input"
              value={courseCode} onChange={e => setCourseCode(e.target.value)}
              maxLength={15} autoFocus required
            />
            <p className="vs-hint">Letters, digits, and spaces — up to 15 characters (e.g. CS 201).</p>
          </div>
          <div className="vs-field">
            <label className="vs-label" htmlFor="addCourseName">Course Name</label>
            <input
              type="text" id="addCourseName" className="vs-input"
              value={courseName} onChange={e => setCourseName(e.target.value)}
              maxLength={300} placeholder="Introduction to Algorithms"
            />
            <p className="vs-hint">The full title shown at the top of the course. Optional.</p>
          </div>
          <div className="vs-field">
            <label className="vs-label" htmlFor="addCourseModuleLabel">Module label</label>
            <select
              id="addCourseModuleLabel" className="vs-select"
              value={moduleLabel} onChange={e => setModuleLabel(e.target.value)}
            >
              {MODULE_LABELS.map(l => <option key={l} value={l}>{moduleTerm(l)}</option>)}
            </select>
            <p className="vs-hint">The term shown next to each video/material number (e.g. “{moduleTerm(moduleLabel)} 3”).</p>
          </div>
        </div>
        <div className="vs-modal-foot">
          <button type="button" className="vs-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="vs-btn vs-btn-primary" disabled={saving}>
            {saving ? 'Creating...' : 'Create Course'}
          </button>
        </div>
      </form>
    </div>
  );
}
