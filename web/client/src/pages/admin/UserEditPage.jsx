import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function UserEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const isEdit = Boolean(id);

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [savingPerms, setSavingPerms] = useState(false);

  // User form fields
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('2');
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState('1');

  // Roles and permissions
  const [roles, setRoles] = useState([]);
  const [allPermissions, setAllPermissions] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [canChangePermissions, setCanChangePermissions] = useState(false);
  const [adminPermissions, setAdminPermissions] = useState({});

  // MFA state (edit mode)
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaMethods, setMfaMethods] = useState([]);
  const [resettingMfa, setResettingMfa] = useState(false);

  useEffect(() => {
    document.title = `${isEdit ? 'Edit User' : 'Add User'} - ${siteName}`;
  }, [isEdit, siteName]);

  const fetchUser = useCallback(async () => {
    try {
      let url;
      if (isEdit) {
        url = `/api/admin/users/${id}/edit`;
      } else {
        url = '/api/admin/users/new';
      }
      const { data, ok } = await mfaPageFetch(url);
      if (ok && data) {
        setRoles(data.roles || []);
        setAllPermissions(data.allPermissions || []);
        setAdminPermissions(data.adminPermissions || {});
        if (isEdit && data.targetUser) {
          setUsername(data.targetUser.username);
          setDisplayName(data.targetUser.display_name);
          setEmail(data.targetUser.email || '');
          setRoleId(String(data.targetUser.role_id));
          setIsActive(data.targetUser.is_active ? '1' : '0');
          setOverrides(data.overrides || {});
          setCanChangePermissions(data.canChangePermissions || false);
          setMfaEnabled(data.mfaEnabled || false);
          setMfaMethods(data.mfaMethods || []);
        }
      }
    } catch {
      showToast('Failed to load form.');
    } finally {
      setLoading(false);
    }
  }, [id, isEdit, mfaPageFetch]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser, mfaVerifiedKey]);

  const requiredPerm = isEdit ? 'changeUser' : 'addUser';
  if (!user?.permissions?.[requiredPerm]) {
    return <p className="text-muted">Permission denied.</p>;
  }

  if (loading) return <LoadingSpinner />;

  const handleSave = async (e) => {
    e.preventDefault();

    // Client-side validation
    if (!isEdit) {
      const u = username.trim();
      if (u.length < 3 || u.length > 20) { showToast('Username must be between 3 and 20 characters.'); return; }
      if (!/^[A-Za-z0-9_-]+$/.test(u)) { showToast('Username can only contain letters, digits, dashes, and underscores.'); return; }
    }
    const dn = displayName.trim();
    if (!dn || dn.length > 30) { showToast('Display name must be between 1 and 30 characters.'); return; }
    if (!/^[A-Za-z0-9 ]+$/.test(dn)) { showToast('Display name can only contain letters, digits, and spaces.'); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { showToast('Invalid email address format.'); return; }

    setSaving(true);
    try {
      const body = { displayName: dn, email, roleId, password };
      if (!isEdit) body.username = username.trim();
      if (isEdit) body.is_active = isActive;

      const url = isEdit ? `/api/admin/users/${id}` : '/api/admin/users';
      const { ok, data } = await mfaFetch(url, { method: isEdit ? 'PUT' : 'POST', body });
      if (ok) {
        showToast(isEdit ? 'User updated.' : 'User created.', 'success');
        navigate('/admin/users');
      } else {
        showToast(data?.error || 'Failed to save user.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
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
        if (!adminPermissions[perm]) continue; // skip keys admin doesn't have
        permissionsBody[perm] = overrides[perm] || 0;
      }
      const { ok, data } = await mfaFetch(`/api/admin/users/${id}/permissions`, { method: 'PUT', body: { permissions: permissionsBody } });
      if (ok) {
        showToast('Permissions updated.', 'success');
      } else {
        showToast(data?.error || 'Failed to update permissions.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingPerms(false);
    }
  };

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <h1 className="mb-3">{isEdit ? `Edit User: ${username}` : 'Add User'}</h1>

      <div className="card">
        <form onSubmit={handleSave} style={{ maxWidth: '600px' }}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              type="text" id="username" className="form-control"
              value={username} onChange={e => setUsername(e.target.value)}
              readOnly={isEdit} required={!isEdit} maxLength={20}
            />
            {!isEdit && <span className="text-muted text-sm">3-20 characters: letters, digits, dashes, underscores</span>}
          </div>
          <div className="form-group">
            <label htmlFor="displayName">Display Name</label>
            <input
              type="text" id="displayName" className="form-control"
              value={displayName} onChange={e => setDisplayName(e.target.value)} required maxLength={30}
            />
            <span className="text-muted text-sm">1-30 characters: letters, digits, spaces</span>
          </div>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email" id="email" className="form-control"
              value={email} onChange={e => setEmail(e.target.value)}
              disabled={isEdit && mfaEnabled}
            />
            {isEdit && mfaEnabled && (
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
            <label htmlFor="password">{isEdit ? 'New Password (leave blank to keep current)' : 'Password'}</label>
            <input
              type="password" id="password" className="form-control"
              value={password} onChange={e => setPassword(e.target.value)}
              required={!isEdit} minLength="8"
            />
          </div>
          {isEdit && (
            <div className="form-group">
              <label htmlFor="is_active">Status</label>
              <select id="is_active" className="form-control" value={isActive} onChange={e => setIsActive(e.target.value)}>
                <option value="1">Active</option>
                <option value="0">Inactive</option>
              </select>
            </div>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create User'}
            </button>
            <Link to="/admin/users" className="btn btn-secondary">Cancel</Link>
          </div>
        </form>
      </div>

      {/* MFA Status (edit mode only, when user has MFA) */}
      {isEdit && mfaEnabled && (
        <div className="card mt-3">
          <div className="card-header">
            <h2>Multi-Factor Authentication</h2>
            <span className="badge badge-success">Enabled</span>
          </div>
          <p className="text-muted text-sm mb-3">
            Methods: {mfaMethods.length > 0 ? mfaMethods.map(m =>
              m === 'email' ? 'Email' : m === 'authenticator' ? 'Authenticator' : 'Passkey'
            ).join(', ') : 'Email only'}
          </p>
          <button
            className="btn btn-danger btn-sm"
            disabled={resettingMfa}
            onClick={async () => {
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
            }}
          >
            {resettingMfa ? 'Resetting...' : 'Reset MFA'}
          </button>
        </div>
      )}

      {/* Permission Overrides (edit mode only, if allowed) */}
      {isEdit && canChangePermissions && (
        <div className="card mt-3">
          <div className="card-header">
            <h2>Permission Overrides</h2>
          </div>
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
    </div>

    {mfaState && (
      <MfaChallengeUI isModal={true}
        challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
        maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
        onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
    )}
    <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </MfaPageGuard>
  );
}
