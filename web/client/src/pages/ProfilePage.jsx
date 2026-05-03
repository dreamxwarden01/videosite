import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { apiFetch, apiGet, apiPost, apiPut } from '../api';
import MfaChallengeUI from '../components/MfaChallengeUI';
import LoadingSpinner from '../components/LoadingSpinner';
import PasswordRules, { checkPasswordComplexity } from '../components/PasswordRules';
import MfaManagementPanel from '../components/MfaManagementPanel';

/**
 * ProfilePage — sidebar/tabs layout matching the admin UserEditPage.
 *
 * Tabs:
 *   - account   — username, display name (inline edit), email (modal), role, joined
 *   - security  — password change (preflight modal: MFA challenge if enabled,
 *                 current password if not). Sign-out-others toggle is the
 *                 user's choice, not automatic.
 *   - mfa       — MfaManagementPanel (was the standalone MfaManagePage)
 *   - sessions  — active session list + terminate-all-others
 *
 * Identity-verification preflight for the password change mirrors the
 * email-change pattern: caller hits /preflight first, server returns
 * either { needsChallenge: true, ... } or { needsPassword: true } and the
 * UI runs the matching prompt before submitting the actual change.
 */
export default function ProfilePage() {
  const { siteName } = useSite();
  const { refresh } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const [profile, setProfile] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [canChangePassword, setCanChangePassword] = useState(false);
  const [security, setSecurity] = useState(null);
  const [loading, setLoading] = useState(true);

  // Tab state — accept ?tab= in URL so /profile/security/mfa redirect lands
  // on the right tab (and so deep links to a section keep working).
  const initialTab = (() => {
    const t = searchParams.get('tab');
    if (t === 'security' || t === 'mfa' || t === 'sessions' || t === 'account') return t;
    return 'account';
  })();
  const [activeTab, setActiveTab] = useState(initialTab);

  const switchTab = (key) => {
    setActiveTab(key);
    // Keep the URL in sync so back-button history works as expected.
    if (key === 'account') {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: key }, { replace: true });
    }
  };

  // -------------------- Display name (inline edit) ---------------------
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  // -------------------- Email change modal -----------------------------
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailStep, setEmailStep] = useState(1); // 1 = input, 2 = verify OTP
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [changingEmail, setChangingEmail] = useState(false);
  const [emailChallengeId, setEmailChallengeId] = useState(null);
  const [emailMaskedNew, setEmailMaskedNew] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailError, setEmailError] = useState('');
  const [emailDailyLimitReached, setEmailDailyLimitReached] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);
  const resendEndRef = useRef(0);
  const resendTimerRef = useRef(null);

  // Email preflight (MFA challenge or password)
  const [emailPreflightData, setEmailPreflightData] = useState(null);
  const [emailPreflightLoading, setEmailPreflightLoading] = useState(false);
  const [emailMfaChallengeId, setEmailMfaChallengeId] = useState(null);

  // -------------------- Password change --------------------------------
  // Inline form state (no current password — moved to preflight modal).
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [pwTouched, setPwTouched] = useState({});
  const [changingPw, setChangingPw] = useState(false);
  // Confirm + sign-out toggle stay mounted unconditionally — the focus-
  // triggered reveal still wasn't reliable enough for strong-password
  // autofill across browsers, and the cost of always rendering them is
  // just a couple of extra rows on the security tab.

  // Password preflight state — mirrors the email modal's two modes
  // (MFA challenge vs current-password prompt) and stays open until the
  // submit succeeds or the user cancels.
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const [pwPreflightLoading, setPwPreflightLoading] = useState(false);
  const [pwPreflightData, setPwPreflightData] = useState(null);
  const [pwMfaChallengeId, setPwMfaChallengeId] = useState(null);
  const [pwModalCurrent, setPwModalCurrent] = useState(''); // current password input inside the modal
  const [pwModalError, setPwModalError] = useState('');

  /* ============================ effects ============================ */

  useEffect(() => {
    document.title = `Profile - ${siteName}`;
  }, [siteName]);

  const loadProfile = useCallback(async () => {
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
  }, [showToast]);

  const loadSecurity = useCallback(async () => {
    try {
      const { data, ok } = await apiGet('/api/profile/security');
      if (ok && data) setSecurity(data);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    refresh();
    loadProfile();
    loadSecurity();
    // Don't depend on refresh — it gets a fresh identity reference each render
    // and would loop us. We only want to fetch on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup resend timer on unmount
  useEffect(() => {
    return () => {
      if (resendTimerRef.current) clearInterval(resendTimerRef.current);
    };
  }, []);

  /* =========================== display name ========================== */

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

  /* ============================== email ============================== */

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

  const openEmailModal = async () => {
    setNewEmail('');
    setEmailPassword('');
    setEmailStep(1);
    setEmailChallengeId(null);
    setEmailMaskedNew('');
    setEmailOtp('');
    setEmailError('');
    setEmailPreflightData(null);
    setEmailMfaChallengeId(null);
    setEmailDailyLimitReached(false);
    setEmailPreflightLoading(true);
    if (resendTimerRef.current) { clearInterval(resendTimerRef.current); resendTimerRef.current = null; }
    setResendCountdown(0);
    setShowEmailModal(true);

    const { data, ok } = await apiPost('/api/profile/email/preflight');
    if (ok && data) {
      setEmailPreflightData(data);
      if (data.existingChallengeId) setEmailMfaChallengeId(data.existingChallengeId);
    } else {
      setEmailError(data?.error || 'Failed to check requirements.');
    }
    setEmailPreflightLoading(false);
  };

  const closeEmailModal = () => {
    setShowEmailModal(false);
    if (resendTimerRef.current) { clearInterval(resendTimerRef.current); resendTimerRef.current = null; }
    setResendCountdown(0);
  };

  const handleEmailStart = async (e) => {
    e.preventDefault();
    if (changingEmail) return;
    setChangingEmail(true);
    setEmailError('');

    const body = { email: newEmail };
    if (emailPreflightData?.needsPassword) body.currentPassword = emailPassword;

    const options = { method: 'POST', body };
    if (emailMfaChallengeId) {
      options.headers = { 'X-MFA-Challenge': emailMfaChallengeId };
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
      mfaChallengeId: emailMfaChallengeId || null,
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

  /* ============================ password ============================ */

  const { error: newPwError } = checkPasswordComplexity(newPassword);
  const pwConfirmError = confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match.' : '';
  const pwInlineValid = !!newPassword && !newPwError && !!confirmPassword && !pwConfirmError;

  const closePwModal = () => {
    setPwModalOpen(false);
    setPwPreflightData(null);
    setPwMfaChallengeId(null);
    setPwModalCurrent('');
    setPwModalError('');
    setPwPreflightLoading(false);
  };

  const openPwModal = async () => {
    if (!pwInlineValid || changingPw) return;
    setPwModalCurrent('');
    setPwModalError('');
    setPwMfaChallengeId(null);
    setPwPreflightData(null);
    setPwPreflightLoading(true);
    setPwModalOpen(true);

    const { data, ok } = await apiPost('/api/profile/password/preflight');
    if (!ok || !data) {
      setPwModalError(data?.error || 'Failed to check requirements.');
      setPwPreflightLoading(false);
      return;
    }
    setPwPreflightData(data);
    setPwPreflightLoading(false);

    // Fast-path: server surfaced a still-valid verified one-time challenge
    // (e.g. user retried after a transient failure). Skip the picker UI and
    // submit straight away, the way they expected when they clicked Change.
    if (data.existingChallengeId) {
      setPwMfaChallengeId(data.existingChallengeId);
      submitPasswordChange({ mfaChallengeId: data.existingChallengeId });
    }
  };

  // Submit happens after the user passes either MFA or current-password
  // verification inside the modal. We hold the verified state in modal
  // state and POST it to /api/profile/password.
  const submitPasswordChange = async ({ mfaChallengeId, currentPasswordValue }) => {
    if (changingPw) return;
    setChangingPw(true);
    setPwModalError('');

    const body = {
      newPassword,
      confirmPassword,
      signOutOthers,
    };
    if (mfaChallengeId) body.mfaChallengeId = mfaChallengeId;
    if (currentPasswordValue) body.currentPassword = currentPasswordValue;

    const { data, ok } = await apiPost('/api/profile/password', body);

    if (ok) {
      showToast('Password changed successfully.', 'success');
      // Reset inline form
      setNewPassword('');
      setConfirmPassword('');
      setSignOutOthers(true);
      setPwTouched({});
      closePwModal();
      // If we terminated other sessions the server killed the entries;
      // either way, refresh so the sessions tab + last-changed date stay
      // accurate. Don't force a /api/me refresh — current session was
      // preserved server-side, so the user stays signed in here.
      loadProfile();
      loadSecurity();
    } else {
      setPwModalError(data?.error || 'Failed to change password.');
    }
    setChangingPw(false);
  };

  // Triggered when the user submits the current-password prompt in the
  // modal (only shown when MFA is not enabled).
  const handlePwModalCurrentSubmit = async (e) => {
    e?.preventDefault?.();
    if (!pwModalCurrent) {
      setPwModalError('Current password is required.');
      return;
    }
    await submitPasswordChange({ currentPasswordValue: pwModalCurrent });
  };

  /* ============================ sessions ============================ */

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

  /* =========================== formatters =========================== */

  const formatPasswordDate = () => {
    if (!security?.passwordChangedAt) return 'Last changed: never';
    return `Last changed: ${new Date(security.passwordChangedAt).toLocaleDateString()}`;
  };

  /* ============================== render ============================ */

  if (loading) return <LoadingSpinner />;
  if (!profile) return <p className="text-muted">Failed to load profile.</p>;

  const sidebarItems = [
    { key: 'account', label: 'Account' },
    ...(canChangePassword ? [{ key: 'security', label: 'Your Password' }] : []),
    { key: 'mfa', label: 'Multi-Factor Authentication' },
    { key: 'sessions', label: 'Active Sessions' },
  ];

  return (
    <div className="admin-edit-page">
      {/* Title bar card */}
      <div className="card" style={{ padding: '12px 16px', marginBottom: '16px', flexShrink: 0 }}>
        <div className="flex-between">
          <div className="flex gap-2" style={{ alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>{profile.display_name}</h2>
            <span className="text-muted text-sm">@{profile.username}</span>
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
              onClick={() => switchTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="course-edit-layout">
          {/* Sidebar */}
          <div className="course-edit-sidebar">
            {sidebarItems.map(item => (
              <button
                key={item.key}
                className={`course-edit-sidebar-item${activeTab === item.key ? ' active' : ''}`}
                onClick={() => switchTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Content area */}
          <div className="course-edit-content">

            {/* ===== ACCOUNT ===== */}
            {activeTab === 'account' && (
              <div className="course-edit-content-scroll">
                <div style={{ maxWidth: '600px' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '16px' }}>Account Information</h3>

                  <table className="profile-info-table">
                    <tbody>
                      <tr>
                        <td className="profile-info-key">Username</td>
                        <td>{profile.username}</td>
                      </tr>
                      <tr>
                        <td className="profile-info-key">Display Name</td>
                        <td>
                          {editingDisplayName ? (
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
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
                        <td className="profile-info-key">Email</td>
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
                      <tr>
                        <td className="profile-info-key">Role</td>
                        <td>{profile.role_name}</td>
                      </tr>
                      <tr>
                        <td className="profile-info-key">Member Since</td>
                        <td>{new Date(profile.created_at).toLocaleDateString()}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== SIGN IN & SECURITY ===== */}
            {activeTab === 'security' && canChangePassword && (
              <div className="course-edit-content-scroll">
                <div style={{ maxWidth: '600px' }}>
                  <h3 style={{ marginTop: 0, marginBottom: '4px' }}>Your Password</h3>
                  <p className="text-muted text-sm" style={{ marginBottom: '20px' }}>{formatPasswordDate()}</p>

                  {/* Hidden username for password managers — helps autofill
                      associate the suggested new password with this account
                      even though the form has no visible username field. */}
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={profile.username}
                    readOnly
                    aria-hidden="true"
                    tabIndex={-1}
                    style={{ position: 'absolute', left: '-9999px', height: 0, width: 0, opacity: 0 }}
                  />

                  <div className="form-group">
                    <label htmlFor="profileNewPassword">New Password</label>
                    <input
                      type="password"
                      id="profileNewPassword"
                      autoComplete="new-password"
                      className={`form-control${pwTouched.newPw && newPwError ? ' input-error' : ''}`}
                      value={newPassword}
                      onChange={(e) => { const v = e.target.value.replace(/\s/g, ''); setNewPassword(v); }}
                      onBlur={() => setPwTouched(prev => ({ ...prev, newPw: true }))}
                    />
                    <PasswordRules password={newPassword} />
                  </div>

                  <div className="form-group">
                    <label htmlFor="profileConfirmPassword">Confirm New Password</label>
                    <input
                      type="password"
                      id="profileConfirmPassword"
                      autoComplete="new-password"
                      className={`form-control${pwTouched.confirm && pwConfirmError ? ' input-error' : ''}`}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value.replace(/\s/g, ''))}
                      onBlur={() => setPwTouched(prev => ({ ...prev, confirm: true }))}
                    />
                    {pwTouched.confirm && pwConfirmError && <span className="field-error">{pwConfirmError}</span>}
                  </div>

                  <div className="form-group" style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 400 }}>
                      <input
                        type="checkbox"
                        checked={signOutOthers}
                        onChange={(e) => setSignOutOthers(e.target.checked)}
                        style={{ margin: 0 }}
                      />
                      <span>Sign out all other devices</span>
                    </label>
                    <span className="text-muted text-sm" style={{ marginLeft: '24px', display: 'block', marginTop: '2px' }}>
                      Recommended if you suspect your old password was compromised.
                    </span>
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!pwInlineValid || changingPw}
                    onClick={openPwModal}
                  >
                    {changingPw ? 'Changing...' : 'Change Password'}
                  </button>
                </div>
              </div>
            )}

            {/* ===== MULTI-FACTOR AUTHENTICATION ===== */}
            {activeTab === 'mfa' && (
              <div className="course-edit-content-scroll">
                <h3 style={{ marginTop: 0, marginBottom: '16px' }}>Multi-Factor Authentication</h3>
                <MfaManagementPanel onChange={() => { loadSecurity(); }} />
              </div>
            )}

            {/* ===== ACTIVE SESSIONS ===== */}
            {activeTab === 'sessions' && (
              <div className="course-edit-content-scroll">
                <div className="flex-between" style={{ marginBottom: '16px' }}>
                  <h3 style={{ margin: 0 }}>Active Sessions</h3>
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
                        <th>Last Seen</th>
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
                          <td>{new Date(s.last_seen).toLocaleString()}</td>
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

      {/* ============= Password change preflight modal ============= */}
      {pwModalOpen && (
        <div className="mfa-challenge-overlay">
          <div className="mfa-challenge-modal">
            {pwPreflightLoading ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <LoadingSpinner />
              </div>
            ) : pwPreflightData?.needsChallenge && !pwMfaChallengeId ? (
              <MfaChallengeUI
                challengeId={pwPreflightData.challengeId}
                allowedMethods={pwPreflightData.allowedMethods}
                maskedEmail={pwPreflightData.maskedEmail}
                apiBase="/api/mfa/challenge"
                onSuccess={(cid) => {
                  setPwMfaChallengeId(cid);
                  // Verification done — submit the password change. The server
                  // will re-validate AND consume the one-time challenge.
                  submitPasswordChange({ mfaChallengeId: cid });
                }}
                onCancel={closePwModal}
                title="Verify to change your password"
              />
            ) : pwPreflightData?.needsChallenge && pwMfaChallengeId ? (
              // We already have a verified challenge (either an existing one
              // surfaced by /preflight or one we just earned) — submit was in
              // flight. Show a brief verifying state in case of a slow request.
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <h2 style={{ marginBottom: '12px' }}>Updating password...</h2>
                {pwModalError ? (
                  <>
                    <p className="field-error" style={{ marginBottom: '16px' }}>{pwModalError}</p>
                    <button className="btn btn-secondary" onClick={closePwModal}>Close</button>
                  </>
                ) : (
                  <LoadingSpinner />
                )}
              </div>
            ) : pwPreflightData?.needsPassword ? (
              // No MFA — just confirm the current password.
              <form onSubmit={handlePwModalCurrentSubmit}>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Confirm your password</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px' }}>
                  Enter your current password to change it.
                </p>
                <div className="form-group">
                  <label htmlFor="pwModalCurrent">Current Password</label>
                  <input
                    type="password"
                    id="pwModalCurrent"
                    className="form-control"
                    autoComplete="current-password"
                    value={pwModalCurrent}
                    onChange={(e) => { setPwModalCurrent(e.target.value.replace(/\s/g, '')); setPwModalError(''); }}
                    autoFocus
                  />
                </div>
                {pwModalError && (
                  <div className="field-error" style={{ marginBottom: '12px' }}>{pwModalError}</div>
                )}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={closePwModal}
                    disabled={changingPw}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ flex: 1, justifyContent: 'center' }}
                    disabled={changingPw || !pwModalCurrent}
                  >
                    {changingPw ? 'Changing...' : 'Confirm'}
                  </button>
                </div>
              </form>
            ) : (
              // Preflight failed (no data + error already in pwModalError)
              <div style={{ textAlign: 'center' }}>
                <h2 style={{ marginBottom: '12px' }}>Unable to continue</h2>
                {pwModalError && (
                  <p className="field-error" style={{ marginBottom: '16px' }}>{pwModalError}</p>
                )}
                <button className="btn btn-secondary" onClick={closePwModal}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============= Email change modal ============= */}
      {showEmailModal && (
        <div className="mfa-challenge-overlay">
          <div className="mfa-challenge-modal">
            {emailPreflightLoading ? (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <LoadingSpinner />
              </div>
            ) : emailPreflightData?.needsChallenge && !emailMfaChallengeId ? (
              <MfaChallengeUI
                challengeId={emailPreflightData.challengeId}
                allowedMethods={emailPreflightData.allowedMethods}
                maskedEmail={emailPreflightData.maskedEmail}
                apiBase="/api/mfa/challenge"
                onSuccess={(cid) => setEmailMfaChallengeId(cid)}
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
                      onChange={(e) => setNewEmail(e.target.value.replace(/\s/g, ''))}
                      required
                      autoFocus
                    />
                  </div>
                  {emailPreflightData?.needsPassword && (
                    <div className="form-group">
                      <label>Current Password</label>
                      <input
                        type="password"
                        className="form-control"
                        autoComplete="current-password"
                        value={emailPassword}
                        onChange={(e) => setEmailPassword(e.target.value.replace(/\s/g, ''))}
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
    </div>
  );
}
