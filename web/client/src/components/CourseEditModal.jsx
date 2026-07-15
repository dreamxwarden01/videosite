import { useState, useEffect, useRef } from 'react';
import { apiGet, apiPut, apiDelete } from '../api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from './ConfirmModal';
import DeleteCourseModal from './DeleteCourseModal';
import ProfileEditModal from './ProfileEditModal';
import VsSaveBar from './VsSaveBar';
import { MODULE_LABELS, moduleTerm } from '../utils/moduleLabel';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
const DetailsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="M9 16h4" /></svg>
);
const SlidersIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
);
const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
);

export default function CourseEditModal({ courseId, onClose, onCourseChanged, onDeleted }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('details');

  // Course details
  const [courseCode, setCourseCode] = useState('');
  const [courseName, setCourseName] = useState('');
  const [moduleLabel, setModuleLabel] = useState('week');
  const [isActive, setIsActive] = useState('1');
  const [courseInfo, setCourseInfo] = useState(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const originalDetails = useRef({});

  // Transcoding config
  const [useCustomProfiles, setUseCustomProfiles] = useState(false);
  const [useEnhancedProfiles, setUseEnhancedProfiles] = useState(false);
  const [audioNormalization, setAudioNormalization] = useState(true);
  const [defaultGlobalProfiles, setDefaultGlobalProfiles] = useState([]);
  const [enhancedGlobalProfiles, setEnhancedGlobalProfiles] = useState([]);
  const [courseProfiles, setCourseProfiles] = useState([]);
  const [savingTranscoding, setSavingTranscoding] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const originalTranscoding = useRef({});

  // Delete
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { ok, data } = await apiGet(`/api/admin/courses/${courseId}/edit`);
        if (cancelled) return;
        if (ok && data) {
          setCourseInfo(data.course);
          setCourseCode(data.course.course_code);
          setCourseName(data.course.course_name || '');
          setModuleLabel(data.course.module_label || 'week');
          setIsActive(data.course.is_active ? '1' : '0');
          setUseCustomProfiles(!!data.course.use_custom_profiles);
          setUseEnhancedProfiles(!!data.course.use_enhanced_profiles);
          setAudioNormalization(!!data.course.audio_normalization);
          setDefaultGlobalProfiles(data.defaultGlobalProfiles || []);
          setEnhancedGlobalProfiles(data.enhancedGlobalProfiles || []);
          setCourseProfiles(data.courseProfiles || []);
          originalDetails.current = {
            course_code: data.course.course_code,
            course_name: data.course.course_name || '',
            module_label: data.course.module_label || 'week',
            is_active: data.course.is_active ? '1' : '0'
          };
          originalTranscoding.current = {
            use_custom_profiles: !!data.course.use_custom_profiles,
            use_enhanced_profiles: !!data.course.use_enhanced_profiles,
            audio_normalization: !!data.course.audio_normalization,
            profiles: JSON.stringify(data.courseProfiles || [])
          };
        }
      } catch {
        if (!cancelled) showToast('Failed to load course.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [courseId]);

  const anySaving = savingDetails || savingTranscoding;

  const detailsDirty = !loading && (
    courseCode !== originalDetails.current.course_code
    || courseName !== originalDetails.current.course_name
    || moduleLabel !== originalDetails.current.module_label
    || isActive !== originalDetails.current.is_active
  );

  const transcodingDirty = !loading && (
    useCustomProfiles !== originalTranscoding.current.use_custom_profiles
    || useEnhancedProfiles !== originalTranscoding.current.use_enhanced_profiles
    || audioNormalization !== originalTranscoding.current.audio_normalization
    || JSON.stringify(courseProfiles) !== originalTranscoding.current.profiles
  );

  const requestClose = async () => {
    if (anySaving) return;
    if (detailsDirty || transcodingDirty) {
      if (!await confirm({ title: 'Discard unsaved changes?', message: 'Your edits to this course won\'t be saved.', confirmLabel: 'Discard', danger: true })) return;
    }
    onClose();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || anySaving || showProfileModal || showDeleteModal) return;
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anySaving, detailsDirty, transcodingDirty, showProfileModal, showDeleteModal]);

  const handleSaveDetails = async (e) => {
    e.preventDefault();
    if (!courseCode.trim()) { showToast('Course code is required.'); return; }
    setSavingDetails(true);
    try {
      const { ok, data } = await apiPut(`/api/admin/courses/${courseId}`, {
        courseCode, courseName, moduleLabel, is_active: isActive
      });
      if (ok) {
        showToast('Course updated.', 'success');
        originalDetails.current = { course_code: courseCode, course_name: courseName, module_label: moduleLabel, is_active: isActive };
        setCourseInfo(prev => ({ ...prev, course_code: courseCode, course_name: courseName }));
        onCourseChanged({ course_code: courseCode, course_name: courseName, module_label: moduleLabel });
      } else {
        showToast(data?.error || 'Failed to save.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingDetails(false); }
  };

  const handleDiscardDetails = () => {
    setCourseCode(originalDetails.current.course_code);
    setCourseName(originalDetails.current.course_name);
    setModuleLabel(originalDetails.current.module_label);
    setIsActive(originalDetails.current.is_active);
  };

  const handleToggleCustomProfiles = async (newValue) => {
    if (!newValue && useCustomProfiles) {
      // Switching back to global — warn and delete custom profiles
      if (!await confirm({ title: 'Restore global defaults?', message: 'This discards the custom transcoding profiles for this course and restores the global defaults.', confirmLabel: 'Restore defaults', danger: true })) return;
      try {
        const { ok } = await apiDelete(`/api/admin/courses/${courseId}/transcoding-profiles`);
        if (ok) {
          setUseCustomProfiles(false);
          setCourseProfiles([]);
          showToast('Restored to global profiles.', 'success');
          originalTranscoding.current = { ...originalTranscoding.current, use_custom_profiles: false, profiles: '[]' };
        }
      } catch (err) { showToast(err.message); }
    } else if (newValue && !useCustomProfiles) {
      // Switching to custom — copy the currently-effective global set as
      // a starting point (whichever the enhanced toggle currently lands on).
      const seedFrom = useEnhancedProfiles ? enhancedGlobalProfiles : defaultGlobalProfiles;
      setUseCustomProfiles(true);
      setCourseProfiles(seedFrom.map(p => ({ ...p, profile_id: undefined, is_system_profile: 0, is_enhanced_profile: null })));
    }
  };

  const handleSaveTranscoding = async () => {
    setSavingTranscoding(true);
    try {
      // Save audio normalization + custom-profiles flag + enhanced-profiles flag.
      const { ok: metaOk, data: metaData } = await apiPut(`/api/admin/courses/${courseId}`, {
        use_custom_profiles: useCustomProfiles,
        use_enhanced_profiles: useEnhancedProfiles,
        audio_normalization: audioNormalization
      });
      if (!metaOk) { showToast(metaData?.error || 'Failed to save.'); return; }

      // Save custom profiles if enabled
      if (useCustomProfiles && courseProfiles.length > 0) {
        const { ok, data } = await apiPut(`/api/admin/courses/${courseId}/transcoding-profiles`, { profiles: courseProfiles });
        if (!ok) { showToast(data?.error || 'Failed to save profiles.'); return; }
      }

      showToast('Transcoding config saved.', 'success');
      originalTranscoding.current = {
        use_custom_profiles: useCustomProfiles,
        use_enhanced_profiles: useEnhancedProfiles,
        audio_normalization: audioNormalization,
        profiles: JSON.stringify(courseProfiles)
      };
    } catch (err) { showToast(err.message); }
    finally { setSavingTranscoding(false); }
  };

  const handleDiscardTranscoding = () => {
    setUseCustomProfiles(originalTranscoding.current.use_custom_profiles);
    setUseEnhancedProfiles(originalTranscoding.current.use_enhanced_profiles);
    setAudioNormalization(originalTranscoding.current.audio_normalization);
    setCourseProfiles(JSON.parse(originalTranscoding.current.profiles));
  };

  const handleProfileSave = (profile) => {
    if (editingProfile !== null) {
      const updated = [...courseProfiles];
      updated[editingProfile] = profile;
      setCourseProfiles(updated);
    } else {
      setCourseProfiles([...courseProfiles, profile]);
    }
    setShowProfileModal(false);
    setEditingProfile(null);
  };

  const handleDeleteProfile = async (idx) => {
    if (!await confirm({ title: 'Delete profile?', message: 'This removes the transcoding profile from this course.', confirmLabel: 'Delete', danger: true })) return;
    setCourseProfiles(courseProfiles.filter((_, i) => i !== idx));
  };

  const displayProfiles = useCustomProfiles
    ? courseProfiles
    : (useEnhancedProfiles ? enhancedGlobalProfiles : defaultGlobalProfiles);

  const cols = {
    name: { flex: 2, minWidth: 0 },
    res: { flex: 1.3, minWidth: 0 },
    br: { flex: 1.4, minWidth: 0 },
    fps: { flex: 1, minWidth: 0 },
    act: { width: 72, flexShrink: 0 }
  };

  return (
    <div className="vs-scrim">
      <div className="vs-modal vs-modal-split">
        <div className="vs-modal-head">
          <h3 className="vs-modal-title">
            Edit course
            {courseInfo?.course_code && (
              <span style={{ color: '#9ca3af', fontWeight: 400 }}>{'  ·  '}{courseInfo.course_code}</span>
            )}
          </h3>
          <button type="button" className="vs-modal-x" onClick={requestClose} disabled={anySaving}><CloseIcon /></button>
        </div>

        <div className="vs-modal-body">
          <div className="vs-split-rail">
            <button type="button" className={`vs-rail-item${activeTab === 'details' ? ' on' : ''}`} onClick={() => setActiveTab('details')}>
              <DetailsIcon /> Course details
            </button>
            <button type="button" className={`vs-rail-item${activeTab === 'transcoding' ? ' on' : ''}`} onClick={() => setActiveTab('transcoding')}>
              <SlidersIcon /> Transcoding
            </button>
            <div className="vs-rail-spacer" />
            {user?.permissions?.deleteCourse && (
              <>
                <div className="vs-rail-sep" />
                <button type="button" className="vs-rail-item dg" onClick={() => setShowDeleteModal(true)}>
                  <TrashIcon /> Delete course
                </button>
              </>
            )}
          </div>

          <div className="vs-split-pane">
            {loading ? (
              <p className="vs-pane-sub" style={{ textAlign: 'center', padding: '24px 0' }}>Loading…</p>
            ) : !courseInfo ? (
              <>
                <div className="vs-pane-h">Course not found</div>
                <p className="vs-pane-sub">This course could not be loaded.</p>
              </>
            ) : activeTab === 'details' ? (
              <form onSubmit={handleSaveDetails}>
                <div className="vs-pane-h">Course details</div>
                <p className="vs-pane-sub">The course code, name, and how each item is numbered.</p>

                <div className="vs-field">
                  <label className="vs-label" htmlFor="ce-code">Course code</label>
                  <input
                    type="text" id="ce-code" className="vs-input" maxLength={15} required
                    value={courseCode} onChange={e => setCourseCode(e.target.value)} disabled={savingDetails}
                  />
                  <p className="vs-hint">Letters, digits, and spaces — up to 15 characters (e.g. CS 201).</p>
                </div>

                <div className="vs-field">
                  <label className="vs-label" htmlFor="ce-name">Course name</label>
                  <input
                    type="text" id="ce-name" className="vs-input" maxLength={300}
                    placeholder="Introduction to Algorithms"
                    value={courseName} onChange={e => setCourseName(e.target.value)} disabled={savingDetails}
                  />
                  <p className="vs-hint">The full title shown at the top of the course. Optional.</p>
                </div>

                <div className="vs-field">
                  <label className="vs-label" htmlFor="ce-module">Module label</label>
                  <select id="ce-module" className="vs-select" value={moduleLabel} onChange={e => setModuleLabel(e.target.value)} disabled={savingDetails}>
                    {MODULE_LABELS.map(l => <option key={l} value={l}>{moduleTerm(l)}</option>)}
                  </select>
                  <p className="vs-hint">Shown next to each video and file, like &ldquo;{moduleTerm(moduleLabel)} 3&rdquo;.</p>
                </div>

                <div className="vs-field">
                  <label className="vs-label" htmlFor="ce-status">Status</label>
                  <select id="ce-status" className="vs-select" value={isActive} onChange={e => setIsActive(e.target.value)} disabled={savingDetails}>
                    <option value="1">Active</option>
                    <option value="0">Inactive</option>
                  </select>
                </div>

                <div className="vs-field">
                  <label className="vs-label" htmlFor="ce-id">Course ID</label>
                  <input type="text" id="ce-id" className="vs-input" value={courseInfo.course_id} disabled readOnly />
                </div>
              </form>
            ) : (
              <div>
                <div className="vs-pane-h">Transcoding</div>
                <p className="vs-pane-sub">How this course&rsquo;s videos are encoded.</p>

                <div className="vs-field">
                  <div className="vs-toggle">
                    <div className="vs-toggle-lbl">
                      <div className="vs-label">Audio normalization</div>
                      <p className="vs-hint">EBU R128 loudness normalization for this course&rsquo;s videos.</p>
                    </div>
                    <label className="vs-switch">
                      <input type="checkbox" checked={audioNormalization} onChange={e => setAudioNormalization(e.target.checked)} />
                      <span className="vs-switch-slider"></span>
                    </label>
                  </div>
                </div>

                <div className="vs-field">
                  <div className="vs-toggle">
                    <div className="vs-toggle-lbl">
                      <div className="vs-label">Use global default profiles</div>
                      <p className="vs-hint">{useCustomProfiles ? 'Using custom profiles for this course.' : 'Using global profiles from site settings.'}</p>
                    </div>
                    <label className="vs-switch">
                      <input type="checkbox" checked={!useCustomProfiles} onChange={e => handleToggleCustomProfiles(!e.target.checked)} />
                      <span className="vs-switch-slider"></span>
                    </label>
                  </div>
                </div>

                {!useCustomProfiles && (
                  <div className="vs-field">
                    <div className="vs-toggle">
                      <div className="vs-toggle-lbl">
                        <div className="vs-label">Use enhanced quality profiles</div>
                        <p className="vs-hint">
                          {useEnhancedProfiles
                            ? 'Encoding at 1440p / 1080p / 720p with higher bitrate ceilings.'
                            : 'Encoding at default quality (1080p / 720p).'}
                        </p>
                      </div>
                      <label className="vs-switch">
                        <input type="checkbox" checked={useEnhancedProfiles} onChange={e => setUseEnhancedProfiles(e.target.checked)} />
                        <span className="vs-switch-slider"></span>
                      </label>
                    </div>
                  </div>
                )}

                <div className="vs-field">
                  <div className={`vs-ptable${!useCustomProfiles ? ' locked' : ''}`}>
                    <div className="vs-ptable-head">
                      <div style={cols.name}>Name</div>
                      <div style={cols.res}>Resolution</div>
                      <div style={cols.br}>Video bitrate</div>
                      <div style={cols.fps}>Max FPS</div>
                      {useCustomProfiles && <div style={cols.act} />}
                    </div>
                    {displayProfiles.map((p, idx) => (
                      <div className="vs-prow" key={p.profile_id || idx}>
                        <div className="vs-prow-c" style={cols.name}>{p.name}</div>
                        <div className="vs-prow-c mut" style={cols.res}>{p.width}x{p.height}</div>
                        <div className="vs-prow-c mut" style={cols.br}>{p.video_bitrate_kbps} kbps</div>
                        <div className="vs-prow-c mut" style={cols.fps}>{p.fps_limit} fps</div>
                        {useCustomProfiles && (
                          <div style={{ ...cols.act, display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            <button type="button" className="vs-ico-btn" title="Edit" onClick={() => { setEditingProfile(idx); setShowProfileModal(true); }}><EditIcon /></button>
                            <button type="button" className="vs-ico-btn dg" title="Delete" onClick={() => handleDeleteProfile(idx)}><TrashIcon /></button>
                          </div>
                        )}
                      </div>
                    ))}
                    {displayProfiles.length === 0 && (
                      <div className="vs-ptable-empty">No profiles</div>
                    )}
                  </div>
                </div>

                {useCustomProfiles && (
                  <button type="button" className="vs-btn vs-btn-sm" onClick={() => { setEditingProfile(null); setShowProfileModal(true); }}>
                    <PlusIcon /> Add profile
                  </button>
                )}
              </div>
            )}

            {!loading && courseInfo && (
              activeTab === 'details' ? (
                <VsSaveBar
                  visible={detailsDirty}
                  busy={savingDetails}
                  onSave={handleSaveDetails}
                  onDiscard={handleDiscardDetails}
                />
              ) : (
                <VsSaveBar
                  visible={transcodingDirty}
                  busy={savingTranscoding}
                  onSave={handleSaveTranscoding}
                  onDiscard={handleDiscardTranscoding}
                />
              )
            )}
          </div>
        </div>
      </div>

      {showDeleteModal && (
        <DeleteCourseModal
          courseId={courseId}
          courseCode={courseInfo?.course_code || ''}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={() => { setShowDeleteModal(false); onDeleted(); }}
        />
      )}

      <ProfileEditModal
        isOpen={showProfileModal}
        profile={editingProfile !== null ? courseProfiles[editingProfile] : null}
        onClose={() => { setShowProfileModal(false); setEditingProfile(null); }}
        onSave={handleProfileSave}
      />
    </div>
  );
}
