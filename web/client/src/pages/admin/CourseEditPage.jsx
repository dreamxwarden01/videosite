import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import LoadingSpinner from '../../components/LoadingSpinner';
import DeleteCourseModal from '../../components/DeleteCourseModal';
import ProfileEditModal from '../../components/ProfileEditModal';

export default function CourseEditPage() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('details');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Course details
  const [courseName, setCourseName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState('1');
  const [courseInfo, setCourseInfo] = useState(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const originalDetails = useRef({});

  // Transcoding config
  const [useCustomProfiles, setUseCustomProfiles] = useState(false);
  const [audioNormalization, setAudioNormalization] = useState(true);
  const [globalProfiles, setGlobalProfiles] = useState([]);
  const [courseProfiles, setCourseProfiles] = useState([]);
  const [savingTranscoding, setSavingTranscoding] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const originalTranscoding = useRef({});

  // Delete
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Edit Course - ${siteName}`;
  }, [siteName]);

  const fetchCourse = useCallback(async () => {
    try {
      const { data, ok } = await mfaPageFetch(`/api/admin/courses/${courseId}/edit`);
      if (ok && data) {
        setCourseInfo(data.course);
        setCourseName(data.course.course_name);
        setDescription(data.course.description || '');
        setIsActive(data.course.is_active ? '1' : '0');
        setUseCustomProfiles(!!data.course.use_custom_profiles);
        setAudioNormalization(!!data.course.audio_normalization);
        setGlobalProfiles(data.globalProfiles || []);
        setCourseProfiles(data.courseProfiles || []);
        originalDetails.current = {
          course_name: data.course.course_name,
          description: data.course.description || '',
          is_active: data.course.is_active ? '1' : '0'
        };
        originalTranscoding.current = {
          use_custom_profiles: !!data.course.use_custom_profiles,
          audio_normalization: !!data.course.audio_normalization,
          profiles: JSON.stringify(data.courseProfiles || [])
        };
      }
    } catch {
      showToast('Failed to load course.');
    } finally {
      setLoading(false);
    }
  }, [courseId, mfaPageFetch]);

  useEffect(() => {
    fetchCourse();
  }, [fetchCourse, mfaVerifiedKey]);

  if (!user?.permissions?.changeCourse) {
    return <p className="text-muted">Permission denied.</p>;
  }

  // Dirty tracking
  const detailsDirty = courseName !== originalDetails.current.course_name
    || description !== originalDetails.current.description
    || isActive !== originalDetails.current.is_active;

  const transcodingDirty = useCustomProfiles !== originalTranscoding.current.use_custom_profiles
    || audioNormalization !== originalTranscoding.current.audio_normalization
    || JSON.stringify(courseProfiles) !== originalTranscoding.current.profiles;

  const handleSaveDetails = async (e) => {
    e.preventDefault();
    if (!courseName.trim()) { showToast('Course name is required.'); return; }
    setSavingDetails(true);
    try {
      const { ok, data } = await mfaFetch(`/api/admin/courses/${courseId}`, {
        method: 'PUT', body: { courseName, description, is_active: isActive }
      });
      if (ok) {
        showToast('Course updated.', 'success');
        originalDetails.current = { course_name: courseName, description, is_active: isActive };
        setCourseInfo(prev => ({ ...prev, course_name: courseName }));
      } else {
        showToast(data?.error || 'Failed to save.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingDetails(false); }
  };

  const handleToggleCustomProfiles = async (newValue) => {
    if (!newValue && useCustomProfiles) {
      // Switching back to global — warn and delete custom profiles
      if (!await confirm('This will discard custom profiles and restore global defaults. Continue?')) return;
      try {
        const { ok } = await mfaFetch(`/api/admin/courses/${courseId}/transcoding-profiles`, { method: 'DELETE' });
        if (ok) {
          setUseCustomProfiles(false);
          setCourseProfiles([]);
          showToast('Restored to global profiles.', 'success');
          originalTranscoding.current = { ...originalTranscoding.current, use_custom_profiles: false, profiles: '[]' };
        }
      } catch (err) { showToast(err.message); }
    } else if (newValue && !useCustomProfiles) {
      // Switching to custom — copy global profiles as starting point
      setUseCustomProfiles(true);
      setCourseProfiles(globalProfiles.map(p => ({ ...p, profile_id: undefined })));
    }
  };

  const handleSaveTranscoding = async () => {
    setSavingTranscoding(true);
    try {
      // Save audio normalization + custom profiles flag
      const { ok: metaOk, data: metaData } = await mfaFetch(`/api/admin/courses/${courseId}`, {
        method: 'PUT', body: { courseName: courseInfo.course_name, use_custom_profiles: useCustomProfiles, audio_normalization: audioNormalization }
      });
      if (!metaOk) { showToast(metaData?.error || 'Failed to save.'); return; }

      // Save custom profiles if enabled
      if (useCustomProfiles && courseProfiles.length > 0) {
        const { ok, data } = await mfaFetch(`/api/admin/courses/${courseId}/transcoding-profiles`, {
          method: 'PUT', body: { profiles: courseProfiles }
        });
        if (!ok) { showToast(data?.error || 'Failed to save profiles.'); return; }
      }

      showToast('Transcoding config saved.', 'success');
      originalTranscoding.current = {
        use_custom_profiles: useCustomProfiles,
        audio_normalization: audioNormalization,
        profiles: JSON.stringify(courseProfiles)
      };
    } catch (err) { showToast(err.message); }
    finally { setSavingTranscoding(false); }
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
    if (!await confirm('Delete this profile?')) return;
    setCourseProfiles(courseProfiles.filter((_, i) => i !== idx));
  };

  const displayProfiles = useCustomProfiles ? courseProfiles : globalProfiles;

  const sidebarItems = [
    { key: 'details', label: 'Course Details' },
    { key: 'transcoding', label: 'Transcoding Config' }
  ];

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
      {loading ? (
        <LoadingSpinner />
      ) : !courseInfo ? (
        <p className="text-muted">Course not found.</p>
      ) : (
      <div className="admin-edit-page">
        {/* Title bar card */}
        <div className="card" style={{ padding: '12px 16px', marginBottom: '16px', flexShrink: 0 }}>
          <div className="flex-between">
            <div className="flex gap-2" style={{ alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/courses')}>Back</button>
              <h2 style={{ margin: 0 }}>{courseInfo.course_name}</h2>
            </div>
          </div>
        </div>

        {/* Main card with sidebar + content */}
        <div className="card course-edit-card">
          {/* Mobile tab bar */}
          <div className="course-edit-mobile-tabs">
            {sidebarItems.map(item => (
              <button
                key={item.key}
                className={`course-edit-mobile-tab${activeTab === item.key ? ' active' : ''}`}
                onClick={() => { setActiveTab(item.key); setMobileMenuOpen(false); }}
              >
                {item.label}
              </button>
            ))}
            {user.permissions.deleteCourse && (
              <button
                className="course-edit-mobile-tab course-edit-mobile-delete"
                onClick={() => setShowDeleteModal(true)}
              >
                Delete Course
              </button>
            )}
          </div>

          <div className="course-edit-layout">
            {/* Sidebar */}
            <div className="course-edit-sidebar">
              {sidebarItems.map(item => (
                <button
                  key={item.key}
                  className={`course-edit-sidebar-item${activeTab === item.key ? ' active' : ''}`}
                  onClick={() => setActiveTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              {user.permissions.deleteCourse && (
                <button
                  className="course-edit-sidebar-item course-edit-sidebar-delete"
                  onClick={() => setShowDeleteModal(true)}
                >
                  Delete Course
                </button>
              )}
            </div>

            {/* Content area */}
            <div className="course-edit-content">
              {activeTab === 'details' && (
                <div className="course-edit-content-scroll">
                <form onSubmit={handleSaveDetails} style={{ maxWidth: '600px' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '16px' }}>Course Details</h3>
                  <div className="form-group">
                    <label htmlFor="courseName">Course Name</label>
                    <input type="text" id="courseName" className="form-control"
                      value={courseName} onChange={e => setCourseName(e.target.value)} required />
                  </div>
                  <div className="form-group">
                    <label htmlFor="description">Description</label>
                    <textarea id="description" className="form-control"
                      value={description} onChange={e => setDescription(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="is_active">Status</label>
                    <select id="is_active" className="form-control" value={isActive} onChange={e => setIsActive(e.target.value)}>
                      <option value="1">Active</option>
                      <option value="0">Inactive</option>
                    </select>
                  </div>
                  <p className="text-muted text-sm mb-3">Course ID: {courseInfo.course_id}</p>
                  <button type="submit" className="btn btn-primary" disabled={savingDetails || !detailsDirty}>
                    {savingDetails ? 'Saving...' : 'Save Changes'}
                  </button>
                </form>
                </div>
              )}

              {activeTab === 'transcoding' && (
                <div className="course-edit-content-scroll">
                  <h3 style={{ marginTop: 0, marginBottom: '16px' }}>Transcoding Config</h3>

                  {/* Audio Normalization toggle */}
                  <div className="flex-between" style={{ marginBottom: '20px' }}>
                    <div>
                      <strong>Audio Normalization</strong>
                      <p className="text-muted text-sm" style={{ margin: '4px 0 0' }}>
                        EBU R128 loudness normalization for this course's videos
                      </p>
                    </div>
                    <label className="toggle-switch">
                      <input type="checkbox" checked={audioNormalization}
                        onChange={e => setAudioNormalization(e.target.checked)} />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  {/* Use Global Profiles toggle */}
                  <div className="flex-between" style={{ marginBottom: '20px' }}>
                    <div>
                      <strong>Use Global Default Profiles</strong>
                      <p className="text-muted text-sm" style={{ margin: '4px 0 0' }}>
                        {useCustomProfiles ? 'Using custom profiles for this course' : 'Using global profiles from site settings'}
                      </p>
                    </div>
                    <label className="toggle-switch">
                      <input type="checkbox" checked={!useCustomProfiles}
                        onChange={e => handleToggleCustomProfiles(!e.target.checked)} />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  {/* Profile list */}
                  <div className={`table-wrap${!useCustomProfiles ? ' data-loading' : ''}`} style={{ marginBottom: '16px' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Resolution</th>
                          <th>Video Bitrate</th>
                          <th>Max FPS</th>
                          {useCustomProfiles && <th>Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {displayProfiles.map((p, idx) => (
                          <tr key={p.profile_id || idx}>
                            <td>{p.name}</td>
                            <td>{p.width}x{p.height}</td>
                            <td>{p.video_bitrate_kbps} kbps</td>
                            <td>{p.fps_limit} fps</td>
                            {useCustomProfiles && (
                              <td>
                                <button className="btn btn-secondary btn-sm" onClick={() => { setEditingProfile(idx); setShowProfileModal(true); }}>Edit</button>
                                <button className="btn btn-danger btn-sm" style={{ marginLeft: '4px' }} onClick={() => handleDeleteProfile(idx)}>Delete</button>
                              </td>
                            )}
                          </tr>
                        ))}
                        {displayProfiles.length === 0 && (
                          <tr><td colSpan={useCustomProfiles ? 5 : 4} className="text-muted" style={{ textAlign: 'center', padding: '16px' }}>No profiles</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {useCustomProfiles && (
                    <button className="btn btn-secondary" style={{ marginBottom: '16px' }}
                      onClick={() => { setEditingProfile(null); setShowProfileModal(true); }}>
                      Add Profile
                    </button>
                  )}

                  <div>
                    <button className="btn btn-primary" disabled={savingTranscoding || !transcodingDirty}
                      onClick={handleSaveTranscoding}>
                      {savingTranscoding ? 'Saving...' : 'Save Transcoding Config'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      <DeleteCourseModal
        isOpen={showDeleteModal}
        courseName={courseInfo?.course_name || ''}
        courseId={courseId}
        onClose={() => setShowDeleteModal(false)}
        mfaFetch={mfaFetch}
        onDeleted={() => navigate('/admin/courses')}
      />

      <ProfileEditModal
        isOpen={showProfileModal}
        profile={editingProfile !== null ? courseProfiles[editingProfile] : null}
        onClose={() => { setShowProfileModal(false); setEditingProfile(null); }}
        onSave={handleProfileSave}
      />

      {mfaState && (
        <MfaChallengeUI isModal challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </MfaPageGuard>
  );
}
