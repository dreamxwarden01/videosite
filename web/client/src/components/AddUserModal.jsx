import { useState, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import useMfaChallenge from '../hooks/useMfaChallenge';
import MfaChallengeUI from './MfaChallengeUI';
import { MfaSetupRequiredModal } from './MfaPageGuard';
import PasswordRules, { checkPasswordComplexity } from './PasswordRules';

export default function AddUserModal({ isOpen, onClose, onCreated, mfaFetch: externalMfaFetch }) {
  const { showToast } = useToast();
  const { mfaFetch: internalMfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();
  const mfaFetch = externalMfaFetch || internalMfaFetch;

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [roles, setRoles] = useState([]);
  const [saving, setSaving] = useState(false);

  // Validation
  const [errors, setErrors] = useState({});
  const [validity, setValidity] = useState({
    username: false,
    displayName: false,
    password: false,
    confirmPassword: false,
  });

  // Fetch roles when modal opens
  useEffect(() => {
    if (!isOpen) {
      // Reset state when closed
      setUsername(''); setDisplayName(''); setEmail('');
      setPassword(''); setConfirmPassword('');
      setRoleId(''); setRoles([]); setSaving(false);
      setErrors({}); setValidity({ username: false, displayName: false, password: false, confirmPassword: false });
      return;
    }
    (async () => {
      try {
        const { data, ok } = await mfaFetch('/api/admin/users/new', { method: 'GET' });
        if (ok && data?.roles?.length) {
          setRoles(data.roles);
          // Default to site's registration_default_role if assignable, otherwise lowest assignable role
          const defaultId = data.defaultRoleId ? String(data.defaultRoleId) : null;
          const match = defaultId && data.roles.find(r => String(r.role_id) === defaultId);
          setRoleId(match ? defaultId : String(data.roles[0].role_id));
        }
      } catch {
        showToast('Failed to load roles.');
      }
    })();
  }, [isOpen]);

  if (!isOpen) return null;

  const setFieldError = (field, msg) => setErrors(prev => ({ ...prev, [field]: msg || undefined }));
  const setFieldValid = (field, valid) => setValidity(prev => ({ ...prev, [field]: valid }));

  // Blur handlers
  const handleUsernameBlur = () => {
    const val = username.trim();
    if (!val) { setFieldError('username', 'Username is required.'); setFieldValid('username', false); }
    else if (val.length < 3 || val.length > 20) { setFieldError('username', 'Username must be between 3 and 20 characters.'); setFieldValid('username', false); }
    else if (!/^[A-Za-z0-9_-]+$/.test(val)) { setFieldError('username', 'Only letters, digits, dashes, and underscores allowed.'); setFieldValid('username', false); }
    else { setFieldError('username', ''); setFieldValid('username', true); }
  };

  const handleDisplayNameBlur = () => {
    const val = displayName.trim();
    if (!val) { setFieldError('displayName', 'Display name is required.'); setFieldValid('displayName', false); }
    else if (val.length > 30) { setFieldError('displayName', 'Display name must be 30 characters or fewer.'); setFieldValid('displayName', false); }
    else if (!/^[A-Za-z0-9 ]+$/.test(val)) { setFieldError('displayName', 'Only letters, digits, and spaces allowed.'); setFieldValid('displayName', false); }
    else { setFieldError('displayName', ''); setFieldValid('displayName', true); }
  };

  const handleEmailBlur = () => {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setFieldError('email', 'Invalid email address format.');
    } else {
      setFieldError('email', '');
    }
  };

  const handlePasswordBlur = () => {
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
    if (!confirmPassword) { setFieldError('confirmPassword', 'Please confirm your password.'); setFieldValid('confirmPassword', false); }
    else if (confirmPassword !== password) { setFieldError('confirmPassword', 'Passwords do not match.'); setFieldValid('confirmPassword', false); }
    else { setFieldError('confirmPassword', ''); setFieldValid('confirmPassword', true); }
  };

  const blockSpace = (e) => { if (e.key === ' ') e.preventDefault(); };

  const emailValid = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const allValid = validity.username && validity.displayName && validity.password && validity.confirmPassword && emailValid && roleId;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!allValid) return;
    setSaving(true);
    try {
      const { ok, data } = await mfaFetch('/api/admin/users', {
        method: 'POST',
        body: {
          username: username.trim(),
          displayName: displayName.trim(),
          email: email.trim() || undefined,
          password,
          roleId
        }
      });
      if (ok && data?.userId) {
        showToast('User created.', 'success');
        onCreated(data.userId);
      } else {
        showToast(data?.error || 'Failed to create user.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="modal-overlay active" onClick={() => {}}>
        <div className="upload-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>Add User</h3>
            <button className="modal-close" onClick={onClose}>&times;</button>
          </div>
          <div className="modal-body">
            <form onSubmit={handleSubmit} autoComplete="off">
              {/* Decoy field absorbs browser username autofill — hidden via position/opacity, not display:none */}
              <div style={{ position: 'absolute', opacity: 0, height: 0, width: 0, overflow: 'hidden' }} aria-hidden="true">
                <input type="text" name="fake_user_trap" autoComplete="username" tabIndex={-1} />
              </div>

              <div className="form-group">
                <label htmlFor="adm_ident">Username</label>
                <input
                  type="text" id="adm_ident"
                  className={`form-control${errors.username ? ' input-error' : ''}`}
                  value={username}
                  onChange={e => { const v = e.target.value; setUsername(v); setFieldError('username', ''); setFieldValid('username', v.trim().length >= 3 && v.trim().length <= 20 && /^[A-Za-z0-9_-]+$/.test(v.trim())); }}
                  onBlur={handleUsernameBlur}
                  maxLength={20} autoFocus autoComplete="one-time-code"
                />
                {errors.username ? <span className="field-error">{errors.username}</span>
                  : <span className="text-muted text-sm">3-20 characters: letters, digits, dashes, underscores</span>}
              </div>

              <div className="form-group">
                <label htmlFor="adm_dname">Display Name</label>
                <input
                  type="text" id="adm_dname"
                  className={`form-control${errors.displayName ? ' input-error' : ''}`}
                  value={displayName}
                  onChange={e => { const v = e.target.value; setDisplayName(v); setFieldError('displayName', ''); setFieldValid('displayName', v.trim().length > 0 && v.trim().length <= 30 && /^[A-Za-z0-9 ]*$/.test(v)); }}
                  onBlur={handleDisplayNameBlur}
                  maxLength={30} autoComplete="one-time-code"
                />
                {errors.displayName ? <span className="field-error">{errors.displayName}</span>
                  : <span className="text-muted text-sm">1-30 characters: letters, digits, spaces</span>}
              </div>

              <div className="form-group">
                <label htmlFor="adm_contact">Email <span className="text-muted">(optional)</span></label>
                <input
                  type="text" id="adm_contact"
                  className={`form-control${errors.email ? ' input-error' : ''}`}
                  value={email}
                  onChange={e => { setEmail(e.target.value); setFieldError('email', ''); }}
                  onBlur={handleEmailBlur}
                  autoComplete="one-time-code"
                />
                {errors.email && <span className="field-error">{errors.email}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="adm_role">Role</label>
                <select id="adm_role" className="form-control" value={roleId} onChange={e => setRoleId(e.target.value)}>
                  {roles.map(r => (
                    <option key={r.role_id} value={r.role_id}>
                      {r.role_name} (Level {r.permission_level})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="adm_secret">Password</label>
                <input
                  type="text" id="adm_secret"
                  className={`form-control${errors.password ? ' input-error' : ''}`}
                  style={{ WebkitTextSecurity: 'disc', textSecurity: 'disc' }}
                  value={password}
                  onChange={e => { const v = e.target.value; setPassword(v); setFieldError('password', ''); const { error } = checkPasswordComplexity(v); setFieldValid('password', !error); }}
                  onBlur={handlePasswordBlur}
                  onKeyDown={blockSpace} autoComplete="off"
                />
                <PasswordRules password={password} />
              </div>

              <div className="form-group">
                <label htmlFor="adm_secret_confirm">Confirm Password</label>
                <input
                  type="text" id="adm_secret_confirm"
                  className={`form-control${errors.confirmPassword ? ' input-error' : ''}`}
                  style={{ WebkitTextSecurity: 'disc', textSecurity: 'disc' }}
                  value={confirmPassword}
                  onChange={e => { setConfirmPassword(e.target.value); setFieldError('confirmPassword', ''); setFieldValid('confirmPassword', e.target.value.length > 0 && e.target.value === password); }}
                  onBlur={handleConfirmBlur}
                  onKeyDown={blockSpace} autoComplete="off"
                />
                {errors.confirmPassword && <span className="field-error">{errors.confirmPassword}</span>}
              </div>

              <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!allValid || saving}>
                  {saving ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
      {mfaState && (
        <MfaChallengeUI isModal challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </>
  );
}
