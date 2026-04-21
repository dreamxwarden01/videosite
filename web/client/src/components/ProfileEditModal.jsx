import { useState, useEffect, useRef } from 'react';

const FIELDS = [
  { key: 'name', label: 'Profile Name', type: 'text' },
  { key: 'width', label: 'Width (px)', type: 'numeric', min: 1, max: 7680 },
  { key: 'height', label: 'Height (px)', type: 'numeric', min: 1, max: 4320 },
  { key: 'video_bitrate_kbps', label: 'Video Bitrate (kbps)', type: 'numeric', min: 100, max: 100000 },
  { key: 'fps_limit', label: 'Max FPS', type: 'numeric', min: 1, max: 120 },
  { key: 'codec', label: 'Codec', type: 'select', options: ['h264'] },
  { key: 'profile', label: 'H.264 Profile', type: 'select', options: ['baseline', 'main', 'high'] },
  { key: 'preset', label: 'Encoding Preset', type: 'select', options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] },
  { key: 'segment_duration', label: 'Segment Duration (s)', type: 'numeric', min: 1, max: 30 },
  { key: 'gop_size', label: 'GOP Size (frames)', type: 'numeric', min: 1, max: 250 },
];

const DEFAULT_PROFILE = {
  name: '', width: '', height: '', video_bitrate_kbps: '', fps_limit: '60',
  codec: 'h264', profile: 'high', preset: 'medium', segment_duration: '6', gop_size: '48'
};

export default function ProfileEditModal({ isOpen, profile, onClose, onSave }) {
  const [form, setForm] = useState({ ...DEFAULT_PROFILE });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const originalRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      const initial = profile
        ? Object.fromEntries(FIELDS.map(f => [f.key, String(profile[f.key] ?? DEFAULT_PROFILE[f.key])]))
        : { ...DEFAULT_PROFILE };
      setForm(initial);
      originalRef.current = { ...initial };
      setErrors({});
      setTouched({});
    }
  }, [isOpen, profile]);

  if (!isOpen) return null;

  const handleDigitOnly = (e) => {
    if (e.key.length === 1 && !/\d/.test(e.key)) e.preventDefault();
  };

  const handleDigitPaste = (e) => {
    const pasted = e.clipboardData.getData('text');
    if (!/^\d+$/.test(pasted)) e.preventDefault();
  };

  const validate = (values) => {
    const errs = {};
    if (!values.name.trim()) errs.name = 'Required';
    for (const f of FIELDS) {
      if (f.type !== 'numeric') continue;
      const v = parseInt(values[f.key], 10);
      if (!values[f.key] || isNaN(v)) {
        errs[f.key] = 'Required';
      } else if (v < f.min || v > f.max) {
        errs[f.key] = `Must be ${f.min}–${f.max}`;
      }
    }
    return errs;
  };

  const handleChange = (key, value) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (touched[key]) {
      setErrors(validate(next));
    }
  };

  const handleBlur = (key) => {
    const nextTouched = { ...touched, [key]: true };
    setTouched(nextTouched);
    setErrors(validate(form));
  };

  const isDirty = originalRef.current && JSON.stringify(form) !== JSON.stringify(originalRef.current);
  const hasErrors = Object.keys(validate(form)).length > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    const allTouched = Object.fromEntries(FIELDS.map(f => [f.key, true]));
    setTouched(allTouched);
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const parsed = { ...form };
    for (const f of FIELDS) {
      if (f.type === 'numeric') parsed[f.key] = parseInt(form[f.key], 10);
    }
    onSave(parsed);
  };

  return (
    <div className="modal-overlay active" onClick={() => {}}>
      <div className="upload-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '480px' }}>
        <div className="modal-header">
          <h3>{profile ? 'Edit Profile' : 'Add Profile'}</h3>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form onSubmit={handleSubmit}>
            {FIELDS.map(f => (
              <div className="form-group" key={f.key} style={{ marginBottom: '12px' }}>
                <label htmlFor={`pf-${f.key}`} style={{ fontSize: '13px', marginBottom: '4px', display: 'block' }}>{f.label}</label>
                {f.type === 'select' ? (
                  <select
                    id={`pf-${f.key}`} className="form-control"
                    value={form[f.key]} onChange={e => handleChange(f.key, e.target.value)}
                  >
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    id={`pf-${f.key}`}
                    className={`form-control${touched[f.key] && errors[f.key] ? ' input-error' : ''}`}
                    type="text"
                    inputMode={f.type === 'numeric' ? 'numeric' : undefined}
                    value={form[f.key]}
                    onChange={e => handleChange(f.key, e.target.value)}
                    onBlur={() => handleBlur(f.key)}
                    onKeyDown={f.type === 'numeric' ? handleDigitOnly : undefined}
                    onPaste={f.type === 'numeric' ? handleDigitPaste : undefined}
                    autoFocus={f.key === 'name'}
                  />
                )}
                {touched[f.key] && errors[f.key] && (
                  <span className="field-error">{errors[f.key]}</span>
                )}
              </div>
            ))}
            <div className="flex gap-2" style={{ justifyContent: 'flex-end', marginTop: '16px' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!isDirty || hasErrors}>
                {profile ? 'Save Changes' : 'Add Profile'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
