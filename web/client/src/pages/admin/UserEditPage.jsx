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
import DeleteUserModal from '../../components/DeleteUserModal';
import PasswordRules, { checkPasswordComplexity } from '../../components/PasswordRules';

export default function UserEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('details');
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // User details
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('2');
  const [isActive, setIsActive] = useState('1');
  const [roles, setRoles] = useState([]);
  const originalDetails = useRef({});
  const [savingDetails, setSavingDetails] = useState(false);

  // Permissions
  const [allPermissions, setAllPermissions] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [canChangePermissions, setCanChangePermissions] = useState(false);
  const [adminPermissions, setAdminPermissions] = useState({});
  const [savingPerms, setSavingPerms] = useState(false);

  // MFA
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaMethods, setMfaMethods] = useState([]);
  const [resettingMfa, setResettingMfa] = useState(false);

  // Security — password
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  // Sessions (lazy-loaded)
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const sessionsLoaded = useRef(false);

  // Validation
  const [errors, setErrors] = useState({});
  const [validity, setValidity] = useState({
    displayName: true,
    email: true,
    password: false,
    confirmPassword: false,
  });

  useEffect(() => {
    document.title = `Edit User - ${siteName}`;
  }, [siteName]);

  const fetchUser = useCallback(async () => {
    try {
      const { data, ok } = await mfaPageFetch(`/api/admin/users/${id}/edit`);
      if (ok && data) {
        setRoles(data.roles || []);
        setAllPermissions(data.allPermissions || []);
        setAdminPermissions(data.adminPermissions || {});
        if (data.targetUser) {
          setUsername(data.targetUser.username);
          setDisplayName(data.targetUser.display_name);
          setEmail(data.targetUser.email || '');
          setRoleId(String(data.targetUser.role_id));
          setIsActive(data.targetUser.is_active ? '1' : '0');
          originalDetails.current = {
            display_name: data.targetUser.display_name,
            email: data.targetUser.email || '',
            role_id: String(data.targetUser.role_id),
            is_active: data.targetUser.is_active ? '1' : '0'
          };
          setValidity(prev => ({ ...prev, displayName: true, email: true }));
        }
        setOverrides(data.overrides || {});
        setCanChangePermissions(data.canChangePermissions || false);
        setMfaEnabled(data.mfaEnabled || false);
        setMfaMethods(data.mfaMethods || []);
      }
    } catch {
      showToast('Failed to load user.');
    } finally {
      setLoading(false);
    }
  }, [id, mfaPageFetch]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser, mfaVerifiedKey]);

  // Lazy-load sessions when activity tab is first opened
  useEffect(() => {
    if (activeTab !== 'activity' || sessionsLoaded.current) return;
    sessionsLoaded.current = true;
    setSessionsLoading(true);
    (async () => {
      try {
        const { data, ok } = await mfaFetch(`/api/admin/users/${id}/sessions`, { method: 'GET' });
        if (ok && data) setSessions(data.sessions || []);
      } catch {
        showToast('Failed to load sessions.');
      } finally {
        setSessionsLoading(false);
      }
    })();
  }, [activeTab, id]);

  if (!user?.permissions?.changeUser) {
    return <p className="text-muted">Permission denied.</p>;
  }
  if (loading) return <LoadingSpinner />;
  if (!username) return <p className="text-muted">User not found.</p>;

  // Dirty tracking — details
  const detailsDirty = displayName !== originalDetails.current.display_name
    || email !== originalDetails.current.email
    || roleId !== originalDetails.current.role_id
    || isActive !== originalDetails.current.is_active;

  const hasDetailsErrors = !!(errors.displayName || errors.email) || !validity.displayName || !validity.email;

  // Dirty tracking — password
  const passwordDirty = password.length > 0;
  const passwordReady = passwordDirty && validity.password && validity.confirmPassword;

  // ---- Blur handlers ----
  const setFieldError = (field, msg) => setErrors(prev => ({ ...prev, [field]: msg || undefined }));
  const setFieldValid = (field, valid) => setValidity(prev => ({ ...prev, [field]: valid }));

  const handleDisplayNameBlur = () => {
    const val = displayName.trim();
    if (!val) { setFieldError('displayName', 'Display name is required.'); setFieldValid('displayName', false); }
    else if (val.length > 30) { setFieldError('displayName', 'Display name must be 30 characters or fewer.'); setFieldValid('displayName', false); }
    else if (!/^[A-Za-z0-9 ]+$/.test(val)) { setFieldError('displayName', 'Only letters, digits, and spaces allowed.'); setFieldValid('displayName', false); }
    else { setFieldError('displayName', ''); setFieldValid('displayName', true); }
  };

  const handleEmailBlur = () => {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFieldError('email', 'Invalid email address format.'); setFieldValid('email', false);
    } else {
      setFieldError('email', ''); setFieldValid('email', true);
    }
  };

  const handlePasswordBlur = () => {
    if (!password) { setFieldValid('password', false); return; }
    const { error } = checkPasswordComplexity(password);
    setFieldError('password', error);
    setFieldValid('password', !error);
    if (confirmPassword) {
      const match = confirmPassword === password;
      setFieldError('confirmPassword', match ? '' : 'Passwords do not match.');
      setFieldValid('confirmPassword', match);
    }
  };

  const handleConfirmBlur = () => {
    if (!confirmPassword) { setFieldError('confirmPassword', 'Please confirm the password.'); setFieldValid('confirmPassword', false); }
    else if (confirmPassword !== password) { setFieldError('confirmPassword', 'Passwords do not match.'); setFieldValid('confirmPassword', false); }
    else { setFieldError('confirmPassword', ''); setFieldValid('confirmPassword', true); }
  };

  const blockSpace = (e) => { if (e.key === ' ') e.preventDefault(); };

  // ---- Save handlers ----
  const handleSaveDetails = async (e) => {
    e.preventDefault();
    if (hasDetailsErrors || !detailsDirty) return;
    setSavingDetails(true);
    try {
      const body = { displayName: displayName.trim(), email, roleId, is_active: isActive };
      const { ok, data } = await mfaFetch(`/api/admin/users/${id}`, { method: 'PUT', body });
      if (ok) {
        showToast('User updated.', 'success');
        originalDetails.current = { display_name: displayName.trim(), email, role_id: roleId, is_active: isActive };
      } else {
        showToast(data?.error || 'Failed to save.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingDetails(false); }
  };

  const handleSavePassword = async () => {
    if (!passwordReady) return;
    setSavingPassword(true);
    try {
      const body = { displayName: originalDetails.current.display_name, password };
      const { ok, data } = await mfaFetch(`/api/admin/users/${id}`, { method: 'PUT', body });
      if (ok) {
        showToast('Password updated. User sessions have been terminated.', 'success');
        setPassword('');
        setConfirmPassword('');
        setFieldError('password', '');
        setFieldError('confirmPassword', '');
        setFieldValid('password', false);
        setFieldValid('confirmPassword', false);
      } else {
        showToast(data?.error || 'Failed to update password.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingPassword(false); }
  };

  const handleResetMfa = async () => {
    if (!await confirm('Reset this user\'s MFA? This will disable MFA and remove all their configured methods. The user will need to set up MFA again.')) return;
    setResettingMfa(true);
    try {
      const { ok, data } = await mfaFetch(`/api/admin/users/${id}/reset-mfa`, { method: 'POST' });
      if (ok) {
        showToast('MFA has been reset.', 'success');
        setMfaEnabled(false);
        setMfaMethods([]);
      } else if (data?.error) {
        showToast(data.error);
      }
    } catch {
      showToast('Failed to reset MFA.');
    }
    setResettingMfa(false);
  };

  const handleOverrideChange = (perm, value) => {
    setOverrides(prev => ({ ...prev, [perm]: parseInt(value) }));
  };

  const handleSavePermissions = async (e) => {
    e.preventDefault();
    setSavingPerms(true);
    try {
      const permissionsBody = {};
      for (const perm of allPermissions) {
        if (!adminPermissions[perm]) continue;
        permissionsBody[perm] = overrides[perm] || 0;
      }
      const { ok, data } = await mfaFetch(`/api/admin/users/${id}/permissions`, { method: 'PUT', body: { permissions: permissionsBody } });
      if (ok) {
        showToast('Permissions updated.', 'success');
      } else {
        showToast(data?.error || 'Failed to update permissions.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingPerms(false); }
  };

  const handleTerminateAll = async () => {
    if (!await confirm('Terminate all sessions for this user? They will be signed out everywhere.')) return;
    try {
      const { ok, data } = await mfaFetch(`/api/admin/users/${id}/sessions/terminate-all`, { method: 'POST' });
      if (ok) {
        showToast('All sessions terminated.', 'success');
        setSessions([]);
      } else {
        showToast('Failed: ' + (data?.error || 'Unknown error'));
      }
    } catch (err) { showToast('Failed: ' + err.message); }
  };

  // ---- Sidebar config ----
  const sidebarItems = [
    { key: 'details', label: 'User Details' },
    { key: 'security', label: 'Sign In & Security' },
    ...(canChangePermissions ? [{ key: 'permissions', label: 'Permissions' }] : []),
    { key: 'activity', label: 'Recent Activity' },
  ];

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
      <div>
        {/* Title bar card */}
        <div className="card" style={{ padding: '12px 16px', marginBottom: '16px' }}>
          <div className="flex-between">
            <div className="flex gap-2" style={{ alignItems: 'center' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/users')}>Back</button>
              <h2 style={{ margin: 0 }}>{username}</h2>
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
                onClick={() => setActiveTab(item.key)}
              >
                {item.label}
              </button>
            ))}
            {user.permissions.deleteUser && (
              <button
                className="course-edit-mobile-tab course-edit-mobile-delete"
                onClick={() => setShowDeleteModal(true)}
              >
                Delete User
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
              {user.permissions.deleteUser && (
                <button
                  className="course-edit-sidebar-item course-edit-sidebar-delete"
                  onClick={() => setShowDeleteModal(true)}
                >
                  Delete User
                </button>
              )}
            </div>

            {/* Content area */}
            <div className="course-edit-content">
              {/* ===== USER DETAILS ===== */}
              {activeTab === 'details' && (
                <form onSubmit={handleSaveDetails} style={{ maxWidth: '600px' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '16px' }}>User Details</h3>

                  <div className="form-group">
                    <label htmlFor="displayName">Display Name</label>
                    <input
                      type="text" id="displayName"
                      className={`form-control${errors.displayName ? ' input-error' : ''}`}
                      value={displayName}
                      onChange={e => { const v = e.target.value; setDisplayName(v); setFieldError('displayName', ''); setFieldValid('displayName', v.trim().length > 0 && v.trim().length <= 30 && /^[A-Za-z0-9 ]*$/.test(v)); }}
                      onBlur={handleDisplayNameBlur}
                      maxLength={30}
                    />
                    {errors.displayName ? <span className="field-error">{errors.displayName}</span>
                      : <span className="text-muted text-sm">1-30 characters: letters, digits, spaces</span>}
                  </div>

                  <div className="form-group">
                    <label htmlFor="email">Email</label>
                    <input
                      type="email" id="email"
                      className={`form-control${errors.email ? ' input-error' : ''}`}
                      value={email}
                      onChange={e => { setEmail(e.target.value); setFieldError('email', ''); setFieldValid('email', !e.target.value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.target.value.trim())); }}
                      onBlur={handleEmailBlur}
                      disabled={mfaEnabled}
                    />
                    {errors.email && <span className="field-error">{errors.email}</span>}
                    {mfaEnabled && (
                      <span className="text-muted text-sm" style={{ color: '#b45309' }}>
                        Cannot change email while MFA is enabled. Reset MFA first.
                      </span>
                    )}
                  </div>

                  <div className="form-group">
                    <label htmlFor="roleId">Role</label>
                    <select id="roleId" className="form-control" value={roleId} onChange={e => setRoleId(e.target.value)}>
                      {roles.map(r => (
                        <option key={r.role_id} value={r.role_id}>
                          {r.role_name} (Level {r.permission_level})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label htmlFor="is_active">Status</label>
                    <select id="is_active" className="form-control" value={isActive} onChange={e => setIsActive(e.target.value)}>
                      <option value="1">Active</option>
                      <option value="0">Inactive</option>
                    </select>
                  </div>

                  <p className="text-muted text-sm mb-3">Username: {username}</p>

                  <button type="submit" className="btn btn-primary" disabled={savingDetails || !detailsDirty || hasDetailsErrors}>
                    {savingDetails ? 'Saving...' : 'Save Changes'}
                  </button>
                </form>
              )}

              {/* ===== SIGN IN & SECURITY ===== */}
              {activeTab === 'security' && (
                <div style={{ maxWidth: '600px' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '16px' }}>Sign In & Security</h3>

                  {/* Password section */}
                  <div style={{ marginBottom: '32px' }}>
                    <h4 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>Change Password</h4>
                    <div className="form-group">
                      <label htmlFor="adm_new_secret">New Password</label>
                      <input
                        type="text" id="adm_new_secret"
                        className={`form-control${errors.password ? ' input-error' : ''}`}
                        style={{ WebkitTextSecurity: 'disc', textSecurity: 'disc' }}
                        value={password}
                        onChange={e => { const v = e.target.value; setPassword(v); setFieldError('password', ''); const { error } = checkPasswordComplexity(v); setFieldValid('password', !error); if (confirmPassword) { const match = confirmPassword === v; setFieldValid('confirmPassword', match); } }}
                        onBlur={handlePasswordBlur}
                        onKeyDown={blockSpace}
                        placeholder="Leave blank to keep current"
                        autoComplete="off"
                      />
                      <PasswordRules password={password} />
                    </div>

                    {password && (
                      <div className="form-group">
                        <label htmlFor="adm_confirm_secret">Confirm New Password</label>
                        <input
                          type="text" id="adm_confirm_secret"
                          className={`form-control${errors.confirmPassword ? ' input-error' : ''}`}
                          style={{ WebkitTextSecurity: 'disc', textSecurity: 'disc' }}
                          value={confirmPassword}
                          onChange={e => { setConfirmPassword(e.target.value); setFieldError('confirmPassword', ''); setFieldValid('confirmPassword', e.target.value.length > 0 && e.target.value === password); }}
                          onBlur={handleConfirmBlur}
                          onKeyDown={blockSpace}
                          autoComplete="off"
                        />
                        {errors.confirmPassword && <span className="field-error">{errors.confirmPassword}</span>}
                      </div>
                    )}

                    <button
                      type="button" className="btn btn-primary"
                      disabled={!passwordReady || savingPassword}
                      onClick={handleSavePassword}
                    >
                      {savingPassword ? 'Updating...' : 'Update Password'}
                    </button>
                  </div>

                  {/* MFA section — always displayed */}
                  <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                      <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Multi-Factor Authentication</h4>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: '12px',
                        fontSize: '12px', fontWeight: 500, color: '#fff',
                        backgroundColor: mfaEnabled ? '#16a34a' : '#9ca3af'
                      }}>
                        {mfaEnabled ? 'Enabled' : 'Not Configured'}
                      </span>
                    </div>

                    {mfaEnabled ? (
                      <>
                        <p className="text-muted text-sm" style={{ marginBottom: '12px' }}>
                          Methods: {mfaMethods.length > 0 ? mfaMethods.map(m =>
                            m === 'email' ? 'Email' : m === 'authenticator' ? 'Authenticator' : 'Passkey'
                          ).join(', ') : 'Email only'}
                        </p>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={resettingMfa}
                          onClick={handleResetMfa}
                        >
                          {resettingMfa ? 'Resetting...' : 'Reset MFA'}
                        </button>
                      </>
                    ) : (
                      <p className="text-muted text-sm">
                        This user has not set up multi-factor authentication.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* ===== PERMISSIONS ===== */}
              {activeTab === 'permissions' && canChangePermissions && (
                <div>
                  <h3 style={{ marginTop: 0, marginBottom: '8px' }}>Permission Overrides</h3>
                  <p className="text-muted text-sm mb-3">
                    Override individual permissions for this user. "Inherit" uses the role's default setting.
                  </p>
                  <form onSubmit={handleSavePermissions}>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Permission</th>
                            <th>Override</th>
                          </tr>
                        </thead>
                        <tbody>
                          {allPermissions.map(perm => {
                            const canEdit = !!adminPermissions[perm];
                            return (
                              <tr key={perm} style={!canEdit ? { opacity: 0.5 } : undefined}>
                                <td>{perm}</td>
                                <td>
                                  <select
                                    className="form-control"
                                    style={{ width: '150px' }}
                                    value={overrides[perm] || 0}
                                    onChange={e => handleOverrideChange(perm, e.target.value)}
                                    disabled={!canEdit}
                                  >
                                    <option value="0">Inherit</option>
                                    <option value="1">Grant</option>
                                    <option value="2">Deny</option>
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <button type="submit" className="btn btn-primary mt-3" disabled={savingPerms}>
                      {savingPerms ? 'Saving...' : 'Save Permission Overrides'}
                    </button>
                  </form>
                </div>
              )}

              {/* ===== RECENT ACTIVITY ===== */}
              {activeTab === 'activity' && (
                <div>
                  <div className="flex-between" style={{ marginBottom: '16px' }}>
                    <h3 style={{ margin: 0 }}>Recent Activity</h3>
                    {sessions.length > 0 && (
                      <button className="btn btn-danger btn-sm" onClick={handleTerminateAll}>
                        Terminate All Sessions
                      </button>
                    )}
                  </div>

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Device</th>
                          <th>IP Address</th>
                          <th>Last Activity</th>
                          <th>Signed In</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessionsLoading && (
                          <tr>
                            <td colSpan="4" className="text-muted" style={{ textAlign: 'center', padding: '16px' }}>Loading...</td>
                          </tr>
                        )}
                        {!sessionsLoading && sessions.length === 0 && (
                          <tr>
                            <td colSpan="4" className="text-muted" style={{ textAlign: 'center', padding: '16px' }}>No active sessions</td>
                          </tr>
                        )}
                        {!sessionsLoading && sessions.map((s, i) => (
                          <tr key={i}>
                            <td>{s.deviceName || 'Unknown'}</td>
                            <td>{s.ip_address || 'Unknown'}</td>
                            <td>{new Date(s.last_activity).toLocaleString()}</td>
                            <td>{new Date(s.last_sign_in).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <DeleteUserModal
        isOpen={showDeleteModal}
        username={username}
        userId={id}
        onClose={() => setShowDeleteModal(false)}
        mfaFetch={mfaFetch}
        onDeleted={() => navigate('/admin/users')}
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
