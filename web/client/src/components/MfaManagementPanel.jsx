import { useState, useEffect, useCallback } from 'react';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost, apiFetch } from '../api';
import { startRegistration } from '@simplewebauthn/browser';
import useMfaChallenge from '../hooks/useMfaChallenge';
import MfaChallengeUI from './MfaChallengeUI';
import LoadingSpinner from './LoadingSpinner';

/**
 * MfaManagementPanel — the "Multi-Factor Authentication" tab body.
 *
 * Extracted out of the (now removed) standalone MfaManagePage so it can
 * live inline as a tab in ProfilePage. Owns its own MFA challenge hook
 * (mfaState modal) — anything in here that mutates an active method has
 * to pass the level-1 challenge gate, regardless of which tab the user
 * happened to land on.
 *
 * `onChange` lets the parent know when the MFA enable state may have
 * shifted, so other parts of the profile (e.g. the security overview
 * cached in the parent) can refresh.
 */
export default function MfaManagementPanel({ onChange }) {
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [methods, setMethods] = useState([]);
  const [hasEmail, setHasEmail] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState('');
  const [requireMFA, setRequireMFA] = useState(false);
  const [toggling, setToggling] = useState(false);

  // Authenticator setup
  const [showAuthSetup, setShowAuthSetup] = useState(false);
  const [authSetup, setAuthSetup] = useState(null); // { methodId, otpauthUri, qrDataUrl }
  const [authLabel, setAuthLabel] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [confirmingAuth, setConfirmingAuth] = useState(false);

  // Passkey registration
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [passkeyLabel, setPasskeyLabel] = useState('');
  const [showPasskeyLabel, setShowPasskeyLabel] = useState(false);
  // passkeyPhase: null | 'pre-verify' | 'verifying' | 'pre-register' | 'registering'
  const [passkeyPhase, setPasskeyPhase] = useState(null);
  const [pendingRegOptions, setPendingRegOptions] = useState(null);

  // Inline verify for inactive authenticators
  const [verifyingMethodId, setVerifyingMethodId] = useState(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [confirmingVerify, setConfirmingVerify] = useState(false);

  // Rename
  const [renamingMethodId, setRenamingMethodId] = useState(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  const { mfaFetch, mfaState, onMfaSuccess, onMfaCancel, lastChallengeId } = useMfaChallenge();

  const loadData = useCallback(async () => {
    try {
      const [methodsRes, securityRes] = await Promise.all([
        apiGet('/api/mfa/methods'),
        apiGet('/api/profile/security'),
      ]);

      if (methodsRes.ok && methodsRes.data) {
        setMethods(methodsRes.data.methods);
        setMfaEnabled(methodsRes.data.mfaEnabled);
      }
      if (securityRes.ok && securityRes.data) {
        setHasEmail(securityRes.data.hasEmail);
        setRequireMFA(securityRes.data.requireMFA);
        if (securityRes.data.maskedEmail) {
          setMaskedEmail(securityRes.data.maskedEmail);
        }
      }
    } catch {
      showToast('Failed to load MFA settings.');
    }
    setLoading(false);
  }, [showToast]);

  useEffect(() => { loadData(); }, [loadData]);

  /* ------------------------------------------------------------------ */
  /*  Enable / Disable toggle                                           */
  /* ------------------------------------------------------------------ */

  const handleToggleMfa = async () => {
    if (toggling) return;
    setToggling(true);

    const endpoint = mfaEnabled ? '/api/mfa/disable' : '/api/mfa/enable';
    const { data, ok, status } = await mfaFetch(endpoint, { method: 'POST' });

    if (status === 403 && !ok) {
      // mfaFetch handles showing challenge modal; will retry automatically
      setToggling(false);
      return;
    }

    if (ok) {
      showToast(mfaEnabled ? 'MFA disabled.' : 'MFA enabled.', 'success');
      setMfaEnabled(!mfaEnabled);
      loadData();
      onChange?.();
    } else {
      showToast(data?.error || `Failed to ${mfaEnabled ? 'disable' : 'enable'} MFA.`);
    }
    setToggling(false);
  };

  /* ------------------------------------------------------------------ */
  /*  Authenticator setup                                               */
  /* ------------------------------------------------------------------ */

  const handleStartAuthSetup = async () => {
    const { data, ok, status } = await mfaFetch('/api/mfa/methods/authenticator/setup', {
      method: 'POST',
      body: { label: 'Authenticator' },
    });

    if (status === 403 && !ok) {
      // mfaFetch handles the challenge modal; will retry and resolve
      return;
    }

    if (ok && data) {
      setAuthSetup(data);
      setAuthLabel('');
      setAuthCode('');
      setShowAuthSetup(true);
    } else {
      showToast(data?.error || 'Failed to start authenticator setup.');
    }
  };

  const handleConfirmAuth = async () => {
    if (confirmingAuth || !authSetup) return;
    if (authCode.length !== 6) {
      showToast('Please enter a 6-digit code.');
      return;
    }
    setConfirmingAuth(true);

    const body = {
      methodId: authSetup.methodId,
      code: authCode,
      label: authLabel || 'Authenticator',
    };
    if (lastChallengeId) {
      body.challengeId = lastChallengeId;
    }

    const { data, ok } = await apiPost('/api/mfa/methods/authenticator/confirm', body);

    if (ok) {
      showToast('Authenticator added successfully.', 'success');
      setShowAuthSetup(false);
      setAuthSetup(null);
      loadData();
      onChange?.();
    } else {
      showToast(data?.error || 'Invalid code. Please try again.');
    }
    setConfirmingAuth(false);
  };

  // Verify an inactive authenticator method
  const handleVerifyInactiveAuth = async (methodId) => {
    if (confirmingVerify) return;
    if (verifyCode.length !== 6) {
      showToast('Please enter a 6-digit code.');
      return;
    }
    setConfirmingVerify(true);

    const { data, ok } = await apiPost('/api/mfa/methods/authenticator/confirm', {
      methodId,
      code: verifyCode,
      label: methods.find(m => m.id === methodId)?.label || 'Authenticator',
    });

    if (ok) {
      showToast('Authenticator verified and activated.', 'success');
      setVerifyingMethodId(null);
      setVerifyCode('');
      loadData();
      onChange?.();
    } else {
      showToast(data?.error || 'Invalid code. Please try again.');
    }
    setConfirmingVerify(false);
  };

  /* ------------------------------------------------------------------ */
  /*  Passkey registration                                              */
  /* ------------------------------------------------------------------ */

  const activePasskeyCount = methods.filter(m => m.method_type === 'passkey' && !!m.is_active).length;
  const needsPasskeyVerify = mfaEnabled && activePasskeyCount > 0;

  const handleAddPasskey = async () => {
    if (registeringPasskey) return;

    if (needsPasskeyVerify && !passkeyPhase) {
      setPasskeyPhase('pre-verify');
      return;
    }

    await doPasskeyRegistration();
  };

  const doPasskeyRegistration = async () => {
    setRegisteringPasskey(true);
    if (needsPasskeyVerify) setPasskeyPhase('verifying');

    try {
      const { data: options, ok, status } = await mfaFetch('/api/mfa/methods/passkey/register-options', {
        method: 'POST',
      });

      if (status === 403 && !ok) {
        setRegisteringPasskey(false);
        setPasskeyPhase(null);
        return;
      }

      if (!ok || !options) {
        showToast('Failed to get registration options.');
        setRegisteringPasskey(false);
        setPasskeyPhase(null);
        return;
      }

      if (needsPasskeyVerify) {
        setPendingRegOptions(options);
        setPasskeyPhase('pre-register');
        setRegisteringPasskey(false);
        return;
      }

      await completePasskeyRegistration(options);
    } catch {
      showToast('Passkey registration failed.');
      setRegisteringPasskey(false);
      setPasskeyPhase(null);
    }
  };

  const completePasskeyRegistration = async (options) => {
    setRegisteringPasskey(true);
    if (needsPasskeyVerify) setPasskeyPhase('registering');

    try {
      let credential;
      try {
        credential = await startRegistration({ optionsJSON: options });
      } catch {
        showToast('Passkey registration cancelled or failed.');
        setRegisteringPasskey(false);
        setPasskeyPhase(null);
        setPendingRegOptions(null);
        return;
      }

      const body = {
        credential,
        label: passkeyLabel || 'Passkey',
        regChallengeId: options.regChallengeId,
      };
      if (options.mfaChallengeId) {
        body.challengeId = options.mfaChallengeId;
      } else if (lastChallengeId) {
        body.challengeId = lastChallengeId;
      }

      const { data, ok: regOk } = await apiPost('/api/mfa/methods/passkey/register', body);

      if (regOk) {
        showToast('Passkey added successfully.', 'success');
        setPasskeyLabel('');
        setShowPasskeyLabel(false);
        loadData();
        onChange?.();
      } else {
        showToast(data?.error || 'Failed to register passkey.');
      }
    } catch {
      showToast('Passkey registration failed.');
    }
    setRegisteringPasskey(false);
    setPasskeyPhase(null);
    setPendingRegOptions(null);
  };

  const cancelPasskeyPhase = () => {
    setPasskeyPhase(null);
    setPendingRegOptions(null);
    setRegisteringPasskey(false);
  };

  /* ------------------------------------------------------------------ */
  /*  Remove method                                                     */
  /* ------------------------------------------------------------------ */

  const handleRemoveMethod = async (methodId, methodLabel, isInactive = false) => {
    if (isInactive) {
      // Inactive methods can be removed without MFA challenge
      const { data, ok } = await apiFetch(`/api/mfa/methods/${methodId}`, {
        method: 'DELETE',
      });
      if (ok) {
        showToast('MFA method removed.', 'success');
        loadData();
        onChange?.();
      } else {
        showToast(data?.error || 'Failed to remove method.');
      }
      return;
    }

    const { data, ok, status } = await mfaFetch(`/api/mfa/methods/${methodId}`, {
      method: 'DELETE',
    });

    if (status === 403 && !ok) {
      return;
    }

    if (ok) {
      showToast('MFA method removed.', 'success');
      loadData();
      onChange?.();
    } else {
      showToast(data?.error || 'Failed to remove method.');
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Rename method                                                     */
  /* ------------------------------------------------------------------ */

  const startRename = (method) => {
    setRenamingMethodId(method.id);
    setRenameLabel(method.label || '');
  };

  const cancelRename = () => {
    setRenamingMethodId(null);
    setRenameLabel('');
  };

  const handleRename = async (methodId) => {
    if (savingRename || !renameLabel.trim()) return;
    setSavingRename(true);

    const { data, ok, status } = await mfaFetch(`/api/mfa/methods/${methodId}/rename`, {
      method: 'PUT',
      body: { label: renameLabel.trim() },
    });

    if (status === 403 && !ok) {
      setSavingRename(false);
      return;
    }

    if (ok) {
      showToast('Method renamed.', 'success');
      setRenamingMethodId(null);
      setRenameLabel('');
      loadData();
    } else {
      showToast(data?.error || 'Failed to rename method.');
    }
    setSavingRename(false);
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                            */
  /* ------------------------------------------------------------------ */

  if (loading) return <LoadingSpinner />;

  const sortByLastUsed = (a, b) => {
    const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  };

  const activeAuthenticators = methods.filter(m => m.method_type === 'authenticator' && !!m.is_active);
  const inactiveAuthenticators = methods.filter(m => m.method_type === 'authenticator' && !m.is_active);
  const activePasskeys = methods.filter(m => m.method_type === 'passkey' && !!m.is_active);
  const inactivePasskeys = methods.filter(m => m.method_type === 'passkey' && !m.is_active);

  const MAX_AUTHENTICATORS = 5;
  const MAX_PASSKEYS = 10;
  const authAtCap = activeAuthenticators.length >= MAX_AUTHENTICATORS;
  const passkeyAtCap = activePasskeys.length >= MAX_PASSKEYS;
  const authenticators = [...activeAuthenticators.sort(sortByLastUsed), ...inactiveAuthenticators];
  const passkeys = [...activePasskeys.sort(sortByLastUsed), ...inactivePasskeys];

  const canToggle = mfaEnabled || hasEmail;
  const forceEnabled = requireMFA && mfaEnabled;

  return (
    <>
      <div className="profile-mfa-panel">
        {/* Status / toggle */}
        <div className="profile-mfa-section">
          <div className="profile-mfa-section-header">
            <div>
              <h3 className="profile-mfa-section-title">MFA Status</h3>
              {forceEnabled && (
                <span className="text-muted text-sm">Your role requires MFA to be enabled.</span>
              )}
              {!hasEmail && !mfaEnabled && (
                <span className="text-muted text-sm">Set an email address on the Account tab before enabling MFA.</span>
              )}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, cursor: canToggle && !forceEnabled ? 'pointer' : 'not-allowed' }}>
              <span style={{ fontSize: '14px', fontWeight: 500 }}>
                {mfaEnabled ? 'Enabled' : 'Disabled'}
              </span>
              <div
                role="switch"
                aria-checked={mfaEnabled}
                tabIndex={0}
                onClick={canToggle && !forceEnabled && !toggling ? handleToggleMfa : undefined}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && canToggle && !forceEnabled && !toggling) {
                    e.preventDefault();
                    handleToggleMfa();
                  }
                }}
                style={{
                  width: '44px',
                  height: '24px',
                  borderRadius: '12px',
                  backgroundColor: mfaEnabled ? '#16a34a' : '#d1d5db',
                  position: 'relative',
                  transition: 'background-color 0.2s',
                  opacity: (canToggle && !forceEnabled) ? 1 : 0.5,
                }}
              >
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  backgroundColor: '#fff',
                  position: 'absolute',
                  top: '3px',
                  left: mfaEnabled ? '23px' : '3px',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
            </label>
          </div>
        </div>

        {/* Email section */}
        <div className="profile-mfa-section">
          <h3 className="profile-mfa-section-title">Email Verification</h3>
          {hasEmail ? (
            <>
              <p style={{ marginBottom: '4px' }}>
                <strong>Email:</strong> {maskedEmail || '(loading...)'}
              </p>
              <p className="text-muted text-sm">
                Email is automatically used for verification when MFA is enabled.
              </p>
            </>
          ) : (
            <p className="text-muted">
              No email address set. Set your email on the Account tab to use email verification.
            </p>
          )}
        </div>

        {/* Authenticator section */}
        <div className="profile-mfa-section">
          <div className="profile-mfa-section-header">
            <div>
              <h3 className="profile-mfa-section-title">Authenticator Apps</h3>
              <p className="text-muted text-sm" style={{ marginTop: '2px' }}>
                {activeAuthenticators.length} of {MAX_AUTHENTICATORS} active
                {inactiveAuthenticators.length > 0 && `, ${inactiveAuthenticators.length} pending`}
              </p>
            </div>
            <button className="btn btn-sm btn-primary" onClick={handleStartAuthSetup} disabled={showAuthSetup || authAtCap}>
              {authAtCap ? 'Limit reached' : 'Add authenticator'}
            </button>
          </div>

          {authenticators.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Status</th>
                    <th>Last Used</th>
                    <th>Added</th>
                    <th style={{ width: '160px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {authenticators.map(m => {
                    const inactive = !m.is_active;
                    const isRenaming = renamingMethodId === m.id;
                    return (
                      <tr key={m.id} style={inactive ? { opacity: 0.75 } : undefined}>
                        <td>
                          {isRenaming ? (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <input
                                type="text"
                                className="form-control"
                                value={renameLabel}
                                onChange={(e) => setRenameLabel(e.target.value.slice(0, 100))}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(m.id); if (e.key === 'Escape') cancelRename(); }}
                                style={{ width: '160px', fontSize: '13px', padding: '4px 8px' }}
                                autoFocus
                              />
                              <button className="btn btn-sm btn-primary" disabled={savingRename || !renameLabel.trim()} onClick={() => handleRename(m.id)}>
                                {savingRename ? '...' : 'Save'}
                              </button>
                              <button className="btn btn-sm btn-secondary" onClick={cancelRename}>Cancel</button>
                            </div>
                          ) : (
                            <span style={{ cursor: 'pointer' }} title="Click to rename" onClick={() => startRename(m)}>
                              {m.label || 'Authenticator'}
                            </span>
                          )}
                        </td>
                        <td>
                          {inactive ? (
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                              fontSize: '11px', fontWeight: 600, color: '#92400e',
                              backgroundColor: '#fef3c7',
                            }}>Pending</span>
                          ) : (
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                              fontSize: '11px', fontWeight: 600, color: '#065f46',
                              backgroundColor: '#d1fae5',
                            }}>Active</span>
                          )}
                        </td>
                        <td>{m.last_used_at ? new Date(m.last_used_at).toLocaleString() : 'Never'}</td>
                        <td>{new Date(m.created_at).toLocaleDateString()}</td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            {inactive && (
                              <button
                                className="btn btn-sm btn-primary"
                                onClick={() => {
                                  setVerifyingMethodId(verifyingMethodId === m.id ? null : m.id);
                                  setVerifyCode('');
                                }}
                              >
                                Verify
                              </button>
                            )}
                            <button
                              className="btn btn-sm btn-danger"
                              onClick={() => handleRemoveMethod(m.id, m.label || 'Authenticator', inactive)}
                            >
                              Remove
                            </button>
                          </div>
                          {inactive && verifyingMethodId === m.id && (
                            <div style={{ marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                              <input
                                type="text"
                                className="form-control"
                                value={verifyCode}
                                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                placeholder="6-digit code"
                                maxLength={6}
                                inputMode="numeric"
                                style={{ width: '120px', fontSize: '14px' }}
                                autoFocus
                              />
                              <button
                                className="btn btn-sm btn-primary"
                                disabled={confirmingVerify || verifyCode.length !== 6}
                                onClick={() => handleVerifyInactiveAuth(m.id)}
                              >
                                {confirmingVerify ? '...' : 'Confirm'}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {authenticators.length === 0 && !showAuthSetup && (
            <p className="text-muted">No authenticators configured.</p>
          )}

          {showAuthSetup && authSetup && (
            <div style={{ maxWidth: '400px', marginTop: '12px' }}>
              <hr style={{ margin: '0 0 16px 0', borderColor: '#e5e7eb' }} />
              <p style={{ marginBottom: '12px', fontWeight: 500 }}>Scan this QR code with your authenticator app:</p>
              <div style={{ textAlign: 'center', marginBottom: '12px' }}>
                <img src={authSetup.qrDataUrl} alt="TOTP QR Code" style={{ width: '200px', height: '200px' }} />
              </div>
              {authSetup.secret && (
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <p className="text-muted text-sm" style={{ marginBottom: '4px' }}>Or enter this setup key manually:</p>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(authSetup.secret).then(() => {
                        showToast('Setup key copied to clipboard.', 'success');
                      }).catch(() => {
                        showToast('Failed to copy. Key: ' + authSetup.secret);
                      });
                    }}
                    style={{ fontFamily: 'monospace', letterSpacing: '2px', fontSize: '13px' }}
                  >
                    {authSetup.secret} &nbsp; Copy
                  </button>
                </div>
              )}
              <div className="form-group">
                <label>Label (optional)</label>
                <input
                  type="text"
                  className="form-control"
                  value={authLabel}
                  onChange={(e) => setAuthLabel(e.target.value)}
                  placeholder="e.g. My Phone"
                />
              </div>
              <div className="form-group">
                <label>Verification Code</label>
                <input
                  type="text"
                  className="form-control"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6-digit code"
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setShowAuthSetup(false); setAuthSetup(null); loadData(); }}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleConfirmAuth}
                  disabled={confirmingAuth || authCode.length !== 6}
                >
                  {confirmingAuth ? 'Verifying...' : 'Confirm'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Passkey section */}
        <div className="profile-mfa-section">
          <div className="profile-mfa-section-header">
            <div>
              <h3 className="profile-mfa-section-title">Passkeys</h3>
              <p className="text-muted text-sm" style={{ marginTop: '2px' }}>
                {activePasskeys.length} of {MAX_PASSKEYS} active
                {inactivePasskeys.length > 0 && `, ${inactivePasskeys.length} pending`}
              </p>
            </div>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setShowPasskeyLabel(true)}
              disabled={registeringPasskey || passkeyAtCap || showPasskeyLabel}
            >
              {passkeyAtCap ? 'Limit reached' : registeringPasskey ? 'Registering...' : 'Add passkey'}
            </button>
          </div>

          {passkeys.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Status</th>
                    <th>Last Used</th>
                    <th>Added</th>
                    <th style={{ width: '80px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {passkeys.map(m => {
                    const inactive = !m.is_active;
                    const isRenaming = renamingMethodId === m.id;
                    return (
                      <tr key={m.id} style={inactive ? { opacity: 0.75 } : undefined}>
                        <td>
                          {isRenaming ? (
                            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <input
                                type="text"
                                className="form-control"
                                value={renameLabel}
                                onChange={(e) => setRenameLabel(e.target.value.slice(0, 100))}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleRename(m.id); if (e.key === 'Escape') cancelRename(); }}
                                style={{ width: '160px', fontSize: '13px', padding: '4px 8px' }}
                                autoFocus
                              />
                              <button className="btn btn-sm btn-primary" disabled={savingRename || !renameLabel.trim()} onClick={() => handleRename(m.id)}>
                                {savingRename ? '...' : 'Save'}
                              </button>
                              <button className="btn btn-sm btn-secondary" onClick={cancelRename}>Cancel</button>
                            </div>
                          ) : (
                            <span style={{ cursor: 'pointer' }} title="Click to rename" onClick={() => startRename(m)}>
                              {m.label || 'Passkey'}
                            </span>
                          )}
                        </td>
                        <td>
                          {inactive ? (
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                              fontSize: '11px', fontWeight: 600, color: '#92400e',
                              backgroundColor: '#fef3c7',
                            }}>Pending</span>
                          ) : (
                            <span style={{
                              display: 'inline-block', padding: '2px 8px', borderRadius: '10px',
                              fontSize: '11px', fontWeight: 600, color: '#065f46',
                              backgroundColor: '#d1fae5',
                            }}>Active</span>
                          )}
                        </td>
                        <td>{m.last_used_at ? new Date(m.last_used_at).toLocaleString() : 'Never'}</td>
                        <td>{new Date(m.created_at).toLocaleDateString()}</td>
                        <td>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleRemoveMethod(m.id, m.label || 'Passkey', inactive)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {passkeys.length === 0 && (
            <p className="text-muted">No passkeys configured.</p>
          )}
        </div>
      </div>

      {/* Passkey registration modals */}
      {showPasskeyLabel && !passkeyPhase && !registeringPasskey && (
        <div className="mfa-challenge-overlay">
          <div onClick={(e) => e.stopPropagation()}>
            <div className="mfa-challenge-modal">
              <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Add Passkey</h2>
              <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px' }}>
                Give your passkey a label to identify it later.
              </p>
              <div className="form-group">
                <label>Label (optional)</label>
                <input
                  type="text"
                  className="form-control"
                  value={passkeyLabel}
                  onChange={(e) => setPasskeyLabel(e.target.value)}
                  placeholder="e.g. MacBook Touch ID"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddPasskey(); }}
                />
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setShowPasskeyLabel(false); setPasskeyLabel(''); }}>
                  Cancel
                </button>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={handleAddPasskey}>
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {passkeyPhase === 'pre-verify' && (
        <div className="mfa-challenge-overlay">
          <div onClick={(e) => e.stopPropagation()}>
            <div className="mfa-challenge-modal">
              <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Verify your identity</h2>
              <p style={{ textAlign: 'center', color: '#555', marginBottom: '8px' }}>
                To add a new passkey, you first need to verify with an existing one.
              </p>
              <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '24px' }}>
                Make sure your current passkey device is connected and ready, then continue.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { cancelPasskeyPhase(); setShowPasskeyLabel(false); setPasskeyLabel(''); }}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={doPasskeyRegistration}>Continue</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {passkeyPhase === 'verifying' && (
        <div className="mfa-challenge-overlay">
          <div onClick={(e) => e.stopPropagation()}>
            <div className="mfa-challenge-modal">
              <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Verifying</h2>
              <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px' }}>
                Waiting for verification...
              </p>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div className="spinner" />
              </div>
            </div>
          </div>
        </div>
      )}

      {passkeyPhase === 'pre-register' && (
        <div className="mfa-challenge-overlay">
          <div onClick={(e) => e.stopPropagation()}>
            <div className="mfa-challenge-modal">
              <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Ready to register</h2>
              <p style={{ textAlign: 'center', color: '#555', marginBottom: '8px' }}>
                Verification complete.
              </p>
              <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '24px' }}>
                If you are using a hardware security key, disconnect the current one and insert the new device you want to register. When ready, continue.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { cancelPasskeyPhase(); setShowPasskeyLabel(false); setPasskeyLabel(''); }}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => completePasskeyRegistration(pendingRegOptions)}>Continue</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {passkeyPhase === 'registering' && (
        <div className="mfa-challenge-overlay">
          <div onClick={(e) => e.stopPropagation()}>
            <div className="mfa-challenge-modal">
              <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Registering</h2>
              <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px' }}>
                Waiting for passkey registration...
              </p>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div className="spinner" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MFA Challenge Modal (from useMfaChallenge hook) */}
      {mfaState && (
        <MfaChallengeUI
          isModal={true}
          challengeId={mfaState.challengeId}
          allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail}
          apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess}
          onCancel={onMfaCancel}
          title="Verify to continue"
        />
      )}
    </>
  );
}
