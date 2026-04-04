import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { apiFetch, apiGet, apiPost, apiPut } from '../api';
import MfaChallengeUI from '../components/MfaChallengeUI';
import LoadingSpinner from '../components/LoadingSpinner';
import PasswordRules, { checkPasswordComplexity } from '../components/PasswordRules';

export default function ProfilePage() {
  const { siteName } = useSite();
  const { user, refresh } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [profile, setProfile] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [canChangePassword, setCanChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);

  // Security state
  const [security, setSecurity] = useState(null);

  // Password form
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [pwTouched, setPwTouched] = useState({});

  // Email change modal
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailStep, setEmailStep] = useState(1); // 1 = input, 2 = verify OTP
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [changingEmail, setChangingEmail] = useState(false);
  const [emailChallengeId, setEmailChallengeId] = useState(null);
  const [emailMaskedNew, setEmailMaskedNew] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailError, setEmailError] = useState('');
  const [resendCountdown, setResendCountdown] = useState(0);
  const resendEndRef = useRef(0);
  const resendTimerRef = useRef(null);

  // Display name editing
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  // Preflight state for email change
  const [preflightData, setPreflightData] = useState(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [mfaChallengeId, setMfaChallengeId] = useState(null);
  const [emailDailyLimitReached, setEmailDailyLimitReached] = useState(false);

  useEffect(() => {
    document.title = `Profile - ${siteName}`;
  }, [siteName]);

  const loadProfile = async () => {
    try {
      const { data, ok } = await apiGet('/api/profile');
      if (ok && data) {
        setProfile(data.profile);
        setSessions(data.sessions || []);
        setCanChangePassword(data.canChangePassword);
      }
    } catch {
      showToast('Failed to load profile.');
    }
    setLoading(false);
  };

  const loadSecurity = async () => {
    try {
      const { data, ok } = await apiGet('/api/profile/security');
      if (ok && data) {
        setSecurity(data);
      }
    } catch {
      // Non-critical, don't show toast
    }
  };

  useEffect(() => {
    refresh();
    loadProfile();
    loadSecurity();
  }, []);

  // Password validation
  const { error: newPwError } = checkPasswordComplexity(newPassword);
  const pwConfirmError = confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match.' : '';
  const pwFormValid = currentPassword && newPassword && !newPwError && confirmPassword && !pwConfirmError;

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (changingPw || !pwFormValid) return;
    setChangingPw(true);

    const { data, ok } = await apiPost('/api/profile/password', {
      currentPassword, newPassword, confirmPassword,
    });

    if (ok) {
      showToast('Password changed successfully.', 'success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwTouched({});
      setShowPasswordForm(false);
      await refresh();
      loadProfile();
      loadSecurity();
    } else {
      showToast(data?.error || 'Failed to change password.');
    }
    setChangingPw(false);
  };

  // Resend cooldown timer helpers
  const startResendTimer = useCallback((seconds = 60) => {
    if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    resendEndRef.current = Date.now() + seconds * 1000;
    setResendCountdown(seconds);
    resendTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((resendEndRef.current - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(resendTimerRef.current);
        resendTimerRef.current = null;
        setResendCountdown(0);
      } else {
        setResendCountdown(remaining);
      }
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    };
  }, []);

  const openEmailModal = async () => {
    setNewEmail('');
    setEmailPassword('');
    setEmailStep(1);
    setEmailChallengeId(null);
    setEmailMaskedNew('');
    setEmailOtp('');
    setEmailError('');
    setPreflightData(null);
    setMfaChallengeId(null);
    setEmailDailyLimitReached(false);
    setPreflightLoading(true);
    if (resendTimerRef.current) { clearInterval(resendTimerRef.current); resendTimerRef.current = null; }
    setResendCountdown(0);
    setShowEmailModal(true);

    const { data, ok } = await apiPost('/api/profile/email/preflight');
    if (ok && data) {
      setPreflightData(data);
      if (data.existingChallengeId) {
        setMfaChallengeId(data.existingChallengeId);
      }
    } else {
      setEmailError(data?.error || 'Failed to check requirements.');
    }
    setPreflightLoading(false);
  };

  const closeEmailModal = () => {
    setShowEmailModal(false);
    if (resendTimerRef.current) { clearInterval(resendTimerRef.current); resendTimerRef.current = null; }
    setResendCountdown(0);
  };

  // Step 1: Start email change
  const handleEmailStart = async (e) => {
    e.preventDefault();
    if (changingEmail) return;
    setChangingEmail(true);
    setEmailError('');

    const body = { email: newEmail };
    if (preflightData?.needsPassword) {
      body.currentPassword = emailPassword;
    }

    const options = { method: 'POST', body };
    if (mfaChallengeId) {
      options.headers = { 'X-MFA-Challenge': mfaChallengeId };
    }

    const { data, ok, status } = await apiFetch('/api/profile/email/start', options);

    if (status === 429) {
      if (data && data.retryAfter != null) {
        startResendTimer(data.retryAfter);
        setEmailError(data.error || 'Too many requests.');
      } else if (data) {
        setEmailDailyLimitReached(true);
      } else {
        startResendTimer(30);
        setEmailError('Too many requests. Please wait.');
      }
      setChangingEmail(false);
      return;
    }

    if (ok && data) {
      setEmailChallengeId(data.challengeId);
      setEmailMaskedNew(data.maskedNewEmail || newEmail);
      setEmailStep(2);
      startResendTimer();
    } else {
      setEmailError(data?.error || 'Failed to start email change.');
    }
    setChangingEmail(false);
  };

  // Step 2: Confirm OTP
  const handleEmailConfirm = async () => {
    if (changingEmail) return;
    if (emailOtp.length !== 6) {
      setEmailError('Please enter the 6-digit code.');
      return;
    }
    setChangingEmail(true);
    setEmailError('');

    const { data, ok } = await apiPost('/api/profile/email/confirm', {
      challengeId: emailChallengeId,
      code: emailOtp,
      mfaChallengeId: mfaChallengeId || null,
    });

    if (ok) {
      showToast('Email updated successfully.', 'success');
      closeEmailModal();
      await refresh();
      loadProfile();
      loadSecurity();
    } else {
      if (data?.mustResend) {
        setEmailError('Code expired. Please request a new code.');
        setEmailOtp('');
      } else if (data?.attemptsRemaining !== undefined) {
        setEmailError(data?.error || `Invalid code. ${data.attemptsRemaining} attempt(s) remaining.`);
      } else {
        setEmailError(data?.error || 'Verification failed.');
      }
    }
    setChangingEmail(false);
  };

  // Resend OTP
  const handleEmailResend = async () => {
    if (resendCountdown > 0 || changingEmail) return;
    setChangingEmail(true);
    setEmailError('');
    setEmailOtp('');

    const { data, ok, status } = await apiPost('/api/profile/email/resend', {
      challengeId: emailChallengeId,
    });

    if (status === 429) {
      if (data && data.retryAfter != null) {
        startResendTimer(data.retryAfter);
        setEmailError(data.error || 'Too many requests.');
      } else if (data) {
        setEmailDailyLimitReached(true);
      } else {
        startResendTimer(30);
        setEmailError('Too many requests. Please wait.');
      }
      setChangingEmail(false);
      return;
    }

    if (ok) {
      startResendTimer();
      showToast('Code resent.', 'success');
    } else {
      setEmailError(data?.error || 'Failed to resend code.');
    }
    setChangingEmail(false);
  };

  const handleTerminateAll = async () => {
    if (!await confirm('Terminate all other sessions?')) return;
    const { ok } = await apiPost('/api/profile/sessions/terminate-all');
    if (ok) {
      showToast('All other sessions terminated.', 'success');
      loadProfile();
    } else {
      showToast('Failed to terminate sessions.');
    }
  };

  const startEditDisplayName = () => {
    setDisplayNameValue(profile.display_name || '');
    setEditingDisplayName(true);
  };

  const cancelEditDisplayName = () => {
    setEditingDisplayName(false);
    setDisplayNameValue('');
  };

  const saveDisplayName = async () => {
    if (savingDisplayName) return;
    const trimmed = displayNameValue.trim();
    if (!trimmed) { showToast('Display name is required.'); return; }
    if (trimmed.length > 30) { showToast('Display name must be 30 characters or fewer.'); return; }
    if (!/^[A-Za-z0-9 ]+$/.test(trimmed)) { showToast('Only letters, digits, and spaces allowed.'); return; }
    setSavingDisplayName(true);
    const { data, ok } = await apiPut('/api/profile/display-name', { displayName: trimmed });
    if (ok) {
      showToast('Display name updated.', 'success');
      setEditingDisplayName(false);
      await refresh();
      loadProfile();
    } else {
      showToast(data?.error || 'Failed to update display name.');
    }
    setSavingDisplayName(false);
  };

  if (loading) return <LoadingSpinner />;
  if (!profile) return <p className="text-muted">Failed to load profile.</p>;

  // Build MFA summary text
  const mfaMethodSummary = () => {
    if (!security || !security.methods || security.methods.length === 0) {
      return 'No methods configured';
    }
    const parts = [];
    const hasEmail = security.hasEmail;
    const authCount = security.methods.filter(m => m.method_type === 'authenticator').length;
    const passkeyCount = security.methods.filter(m => m.method_type === 'passkey').length;
    if (hasEmail && security.mfaEnabled) parts.push('Email');
    if (authCount > 0) parts.push(`${authCount} authenticator${authCount > 1 ? 's' : ''}`);
    if (passkeyCount > 0) parts.push(`${passkeyCount} passkey${passkeyCount > 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'No methods configured';
  };

  const formatPasswordDate = () => {
    if (!security?.passwordChangedAt) return 'Never changed';
    return `Last changed: ${new Date(security.passwordChangedAt).toLocaleDateString()}`;
  };

  return (
    <>
      <h1 style={{ marginBottom: '24px' }}>Profile</h1>

      {/* Account Information */}
      <div className="card">
        <div className="card-header">
          <h2>Account Information</h2>
        </div>
        <table>
          <tbody>
            <tr><td style={{ width: '150px', fontWeight: 500 }}>Username</td><td>{profile.username}</td></tr>
            <tr>
              <td style={{ fontWeight: 500 }}>Display Name</td>
              <td>
                {editingDisplayName ? (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <input
                      type="text"
                      className="form-control"
                      value={displayNameValue}
                      onChange={(e) => setDisplayNameValue(e.target.value.slice(0, 30))}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveDisplayName(); if (e.key === 'Escape') cancelEditDisplayName(); }}
                      style={{ width: '200px', fontSize: '14px', padding: '4px 8px' }}
                      autoFocus
                    />
                    <button className="btn btn-sm btn-primary" disabled={savingDisplayName || !displayNameValue.trim()} onClick={saveDisplayName}>
                      {savingDisplayName ? '...' : 'Save'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={cancelEditDisplayName}>Cancel</button>
                  </div>
                ) : (
                  <>
                    {profile.display_name}
                    <button
                      className="btn btn-sm btn-secondary"
                      style={{ marginLeft: '12px' }}
                      onClick={startEditDisplayName}
                    >
                      Change
                    </button>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <td style={{ fontWeight: 500 }}>Email</td>
              <td>
                {profile.maskedEmail || 'Not set'}
                <button
                  className="btn btn-sm btn-secondary"
                  style={{ marginLeft: '12px' }}
                  onClick={openEmailModal}
                >
                  {profile.hasEmail ? 'Change' : 'Set email'}
                </button>
              </td>
            </tr>
            <tr><td style={{ fontWeight: 500 }}>Role</td><td>{profile.role_name}</td></tr>
            <tr><td style={{ fontWeight: 500 }}>Member Since</td><td>{new Date(profile.created_at).toLocaleDateString()}</td></tr>
          </tbody>
        </table>
      </div>

      {/* Security & Sign-in */}
      <h2 style={{ marginTop: '32px', marginBottom: '16px' }}>Security & Sign-in</h2>

      {/* Your Password */}
      {canChangePassword && (
        <div className="card">
          <div className="card-header">
            <div>
              <h2 style={{ marginBottom: '4px' }}>Your Password</h2>
              <span className="text-muted text-sm">{formatPasswordDate()}</span>
            </div>
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => { setShowPasswordForm(!showPasswordForm); setPwTouched({}); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }}
            >
              {showPasswordForm ? 'Cancel' : 'Change Password'}
            </button>
          </div>
          {showPasswordForm && (
            <form onSubmit={handlePasswordChange} style={{ maxWidth: '400px', padding: '0 16px 16px' }}>
              <div className="form-group">
                <label>Current Password</label>
                <input type="password"
                  className={`form-control${pwTouched.current && !currentPassword ? ' input-error' : ''}`}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  onBlur={() => setPwTouched(prev => ({ ...prev, current: true }))}
                />
                {pwTouched.current && !currentPassword && <span className="field-error">Current password is required.</span>}
              </div>
              <div className="form-group">
                <label>New Password</label>
                <input type="password"
                  className={`form-control${pwTouched.newPw && newPwError ? ' input-error' : ''}`}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onBlur={() => { setPwTouched(prev => ({ ...prev, newPw: true })); if (confirmPassword) setPwTouched(prev => ({ ...prev, confirm: true })); }}
                  onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                />
                <PasswordRules password={newPassword} />
              </div>
              <div className="form-group">
                <label>Confirm New Password</label>
                <input type="password"
                  className={`form-control${pwTouched.confirm && pwConfirmError ? ' input-error' : ''}`}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onBlur={() => setPwTouched(prev => ({ ...prev, confirm: true }))}
                  onKeyDown={(e) => { if (e.key === ' ') e.preventDefault(); }}
                />
                {pwTouched.confirm && pwConfirmError && <span className="field-error">{pwConfirmError}</span>}
              </div>
              <button type="submit" className="btn btn-primary" disabled={changingPw || !pwFormValid}>
                {changingPw ? 'Changing...' : 'Change Password'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Multi-Factor Authentication */}
      <div className="card">
        <div className="card-header">
          <div>
            <h2 style={{ marginBottom: '4px' }}>Multi-Factor Authentication</h2>
            <span className="text-muted text-sm">{mfaMethodSummary()}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              className={`badge ${security?.mfaEnabled ? 'badge-success' : 'badge-muted'}`}
              style={{
                display: 'inline-block',
                padding: '3px 10px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#fff',
                backgroundColor: security?.mfaEnabled ? '#16a34a' : '#9ca3af',
              }}
            >
              {security?.mfaEnabled ? 'Enabled' : 'Disabled'}
            </span>
            <Link to="/profile/security/mfa" className="btn btn-sm btn-secondary">
              Manage
            </Link>
          </div>
        </div>
      </div>

      {/* Active Sessions */}
      <div className="card">
        <div className="card-header">
          <h2>Active Sessions</h2>
          {sessions.length > 1 && (
            <button className="btn btn-danger btn-sm" onClick={handleTerminateAll}>
              Terminate all other sessions
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
              {sessions.map((s, i) => (
                <tr key={i}>
                  <td>
                    {s.deviceName || 'Unknown'}
                    {s.isCurrent && <strong> (current)</strong>}
                  </td>
                  <td>{s.ip_address || 'Unknown'}</td>
                  <td>{new Date(s.last_activity).toLocaleString()}</td>
                  <td>{new Date(s.last_sign_in).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Email Change Modal */}
      {showEmailModal && (
        <div className="mfa-challenge-overlay">
          <div className="mfa-challenge-modal">
            {preflightLoading ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <LoadingSpinner />
              </div>
            ) : preflightData?.needsChallenge && !mfaChallengeId ? (
              <MfaChallengeUI
                challengeId={preflightData.challengeId}
                allowedMethods={preflightData.allowedMethods}
                maskedEmail={preflightData.maskedEmail}
                apiBase="/api/mfa/challenge"
                onSuccess={(cid) => setMfaChallengeId(cid)}
                onCancel={closeEmailModal}
                title="Verify to change email"
              />
            ) : emailStep === 1 ? (
              /* Step 1: Email input */
              <>
                <h2 style={{ marginBottom: '16px', textAlign: 'center' }}>
                  {profile.hasEmail ? 'Change Email' : 'Set Email'}
                </h2>
                <form onSubmit={handleEmailStart}>
                  <div className="form-group">
                    <label>New Email Address</label>
                    <input
                      type="email"
                      className="form-control"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      required
                      autoFocus
                    />
                  </div>
                  {preflightData?.needsPassword && (
                    <div className="form-group">
                      <label>Current Password</label>
                      <input
                        type="password"
                        className="form-control"
                        value={emailPassword}
                        onChange={(e) => setEmailPassword(e.target.value)}
                        required
                      />
                    </div>
                  )}
                  {emailError && (
                    <div className="field-error" style={{ marginBottom: '12px' }}>{emailError}</div>
                  )}
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={closeEmailModal}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={changingEmail}
                    >
                      {changingEmail ? 'Sending code...' : 'Continue'}
                    </button>
                  </div>
                </form>
              </>
            ) : emailDailyLimitReached ? (
              /* Step 2: Daily limit reached */
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Email verification limit reached</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '24px' }}>
                  You've reached the daily email verification limit. Please try again tomorrow.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={closeEmailModal}
                >
                  Close
                </button>
              </>
            ) : (
              /* Step 2: OTP verification */
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Verify your new email</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '4px' }}>
                  We sent a code to {emailMaskedNew}
                </p>
                <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '20px' }}>
                  The code expires in 10 minutes
                </p>
                <div className="form-group">
                  <input
                    type="text"
                    className="form-control"
                    value={emailOtp}
                    onChange={(e) => setEmailOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="6-digit code"
                    maxLength={6}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    style={{ textAlign: 'center', fontSize: '20px', letterSpacing: '8px' }}
                  />
                </div>
                {emailError && (
                  <div className="field-error" style={{ textAlign: 'center', marginBottom: '12px' }}>{emailError}</div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
                  <button
                    className="btn btn-sm btn-secondary"
                    disabled={resendCountdown > 0 || changingEmail || emailDailyLimitReached}
                    onClick={handleEmailResend}
                    type="button"
                  >
                    {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={closeEmailModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={changingEmail || emailOtp.length !== 6}
                    onClick={handleEmailConfirm}
                  >
                    {changingEmail ? 'Verifying...' : 'Verify'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
