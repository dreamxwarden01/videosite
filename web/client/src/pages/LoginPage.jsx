import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiPost } from '../api';
import Header from '../components/Header';
import MfaChallengeUI from '../components/MfaChallengeUI';
import Turnstile from '../components/Turnstile';

// Best-effort cleanup hint to the user's credential manager that a
// credential ID we just received isn't recognized server-side. Chrome /
// Edge / Google Password Manager / 1Password / Bitwarden act on this;
// Apple Keychain partially; Firefox + hardware keys ignore. Always wrap
// in feature detection — this method is WebAuthn L3 (2024+).
function signalUnknownCredential(credentialId) {
  if (!credentialId) return;
  if (typeof PublicKeyCredential === 'undefined') return;
  if (typeof PublicKeyCredential.signalUnknownCredential !== 'function') return;
  PublicKeyCredential.signalUnknownCredential({
    rpId: window.location.hostname,
    credentialId
  }).catch(() => { /* best-effort, never block login UX */ });
}

// WebAuthn supported at all? Used to hide the "Sign in with a passkey"
// button on browsers that wouldn't be able to honor it (very rare in 2026
// but a clean degradation).
function isWebAuthnSupported() {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined';
}

export default function LoginPage() {
  const { user, refresh } = useAuth();
  const { siteName, turnstileSiteKey, refreshSiteSettings } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Turnstile state — shared by both the password Sign In and the
  // "Sign in with a passkey" button. Both submit paths send the same
  // token, and a single widget is rendered between the password input
  // and the Sign In button so the visual ownership of the CAPTCHA
  // applies to whichever button the user clicks.
  const [turnstileToken, setTurnstileToken] = useState(null);
  const turnstileResetRef = useRef(null);
  // Both buttons are gated together: when Turnstile is enabled and we
  // don't yet have a token, neither button is clickable. When Turnstile
  // is off site-wide (turnstileSiteKey null), the gate is false and
  // buttons stay enabled exactly as before.
  const turnstileGate = !!turnstileSiteKey && !turnstileToken;

  // Tracks whether login was completed on this page (prevents useEffect redirect race)
  const loginCompleted = useRef(false);

  // Phase: 'credentials' | 'mfa-verify' | 'enrollment-loading' | 'enrollment-email' | 'enrollment-email-verify' | 'enrollment-verify' | 'passkey' | 'passkey-error'
  const [phase, setPhase] = useState('credentials');
  const [mfaData, setMfaData] = useState(null); // { challengeId, allowedMethods, maskedEmail, returnTo }
  const [returnTo, setReturnTo] = useState('/');
  const [loginChallengeId, setLoginChallengeId] = useState(null); // bmfa challenge from login for enrollment

  // Passkey error message shown on the 'passkey-error' phase. Set by
  // attemptPasskeyLogin before transitioning. Plain string for now; we
  // could add a richer shape later (e.g. with a "remove passkey from
  // device" link) but the message itself already explains the next step.
  const [passkeyError, setPasskeyError] = useState('');

  // Enrollment email setup state
  const [enrollEmail, setEnrollEmail] = useState('');
  const [enrollEmailSubmitting, setEnrollEmailSubmitting] = useState(false);
  const [enrollEmailError, setEnrollEmailError] = useState('');
  const [enrollChallengeId, setEnrollChallengeId] = useState(null);
  const [enrollMaskedEmail, setEnrollMaskedEmail] = useState('');
  const [enrollOtpMinutes, setEnrollOtpMinutes] = useState(5);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollCodeSubmitting, setEnrollCodeSubmitting] = useState(false);
  const [enrollCodeError, setEnrollCodeError] = useState('');
  const [enrollResending, setEnrollResending] = useState(false);

  useEffect(() => {
    document.title = `Sign In - ${siteName}`;
  }, [siteName]);

  // If already logged in (not from a login just completed on this page),
  // redirect to home. We deliberately ignore returnTo here — the user landed
  // on /login while already authenticated (second tab, browser back, etc.),
  // not from a deep-link guard, so dropping them on / is the safer default.
  useEffect(() => {
    if (user && !loginCompleted.current) navigate('/', { replace: true });
  }, [user, navigate]);


  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const rt = searchParams.get('returnTo') || '/';
    let gotError = false;
    let turnstileFailedWithStaleSiteKey = false;

    try {
      const { data, status, ok } = await apiPost('/api/login', {
        username,
        password,
        returnTo: rt,
        turnstileToken,
      });

      if (status === 429) {
        showToast('Too many login attempts. Please wait a moment and try again.');
        gotError = true;
      } else if (ok && data) {
        // MFA verification (user has MFA enabled)
        if (data.requireMFA) {
          setMfaData({
            challengeId: data.challengeId,
            allowedMethods: data.allowedMethods,
            maskedEmail: data.maskedEmail,
            returnTo: data.returnTo || '/'
          });
          setPhase('mfa-verify');
          setSubmitting(false);
          return;
        }

        // MFA enrollment (user must set up MFA)
        if (data.requireMFASetup) {
          setReturnTo(data.returnTo || '/');
          setLoginChallengeId(data.challengeId);
          setPhase('enrollment-loading');
          startEnrollment(data.challengeId);
          setSubmitting(false);
          return;
        }

        // Normal login — no MFA
        loginCompleted.current = true;
        await refresh();
        navigate(data.returnTo || '/', { replace: true });
        return;
      } else if (status === 422 && data?.errors?.turnstile) {
        showToast(data.errors.turnstile);
        gotError = true;
        // Server requires Turnstile but we cached it as off — refresh
        // settings so the widget mounts on the next render.
        if (!turnstileSiteKey) turnstileFailedWithStaleSiteKey = true;
      } else {
        showToast(data?.message || 'Login failed');
        gotError = true;
      }
    } catch {
      showToast('Unable to reach the server. Please check your connection.');
      gotError = true;
    }

    if (gotError) {
      setTurnstileToken(null);
      turnstileResetRef.current?.();
      if (turnstileFailedWithStaleSiteKey) await refreshSiteSettings();
    }
    setSubmitting(false);
  };

  // ---- MFA Verify (existing users with MFA) ----
  const handleMfaSuccess = async () => {
    loginCompleted.current = true;
    await refresh();
    navigate(mfaData?.returnTo || '/', { replace: true });
  };

  const handleMfaCancel = () => {
    setPhase('credentials');
    setMfaData(null);
  };

  // ---- Passkey "quick sign in" (username-less, single round trip) ----
  //
  // 1. POST /api/auth/passkey/options → { challengeHandle, options }
  // 2. startAuthentication shows the OS picker; user selects + verifies
  // 3. POST /api/auth/passkey/verify with { challengeHandle, credential }
  // 4. On 200: session cookie is set server-side, refresh user, navigate
  //
  // Errors map to the 'passkey-error' phase with a tailored message.
  // User cancellation (NotAllowedError / AbortError) is silent — back to
  // the credentials view, no toast, no error.
  const attemptPasskeyLogin = async () => {
    setPasskeyError('');
    setPhase('passkey');
    const rt = searchParams.get('returnTo') || '/';

    let assertion;
    try {
      // /options carries the Turnstile token. /verify doesn't need one
      // because it's already gated by a one-shot Redis challenge handle
      // that only /options can mint.
      const { data: optsData, status: optsStatus, ok: optsOk } = await apiPost('/api/auth/passkey/options', {
        turnstileToken,
      });

      // Turnstile token is one-shot consumed by /options regardless of
      // whether the rest of the flow succeeds. Refresh the widget RIGHT
      // NOW so any subsequent attempt (after OS-picker cancel, after a
      // /verify failure, or even after this same call's error branches
      // below) has a fresh token waiting on the credentials view. The
      // user is still looking at the passkey loading overlay during the
      // OS prompt, so the widget refresh is invisible to them.
      setTurnstileToken(null);
      turnstileResetRef.current?.();

      // 429 first — covers Cloudflare's HTML 429 (where data is null
      // because apiFetch only parses JSON content types). Without this
      // explicit branch, the code-based checks below would all fail and
      // fall through to a generic passkey-error.
      if (optsStatus === 429) {
        showToast('Too many sign-in attempts. Please wait a moment and try again.');
        setPhase('credentials');
        return;
      }

      // Turnstile rejection — surface as a toast on the credentials view
      // (so the user can see the refreshed widget) instead of dropping
      // into the passkey-error phase.
      if (optsStatus === 422 && optsData?.errors?.turnstile) {
        showToast(optsData.errors.turnstile);
        if (!turnstileSiteKey) await refreshSiteSettings();
        setPhase('credentials');
        return;
      }

      if (!optsOk || !optsData || !optsData.options) {
        setPasskeyError('Couldn’t start passkey sign-in. Please try again.');
        setPhase('passkey-error');
        return;
      }
      assertion = await startAuthentication({ optionsJSON: optsData.options });

      const { data, status, ok } = await apiPost('/api/auth/passkey/verify', {
        challengeHandle: optsData.challengeHandle,
        credential: assertion,
        returnTo: rt
      });

      if (ok) {
        loginCompleted.current = true;
        await refresh();
        navigate(data?.returnTo || '/', { replace: true });
        return;
      }

      // 429 first — same Cloudflare-HTML reasoning as above. Widget was
      // already refreshed when /options completed, so no extra reset
      // needed here; we just hand control back to credentials.
      if (status === 429) {
        showToast('Too many sign-in attempts. Please wait a moment and try again.');
        setPhase('credentials');
        return;
      }

      // Translate server error codes into user-facing messages + cleanup
      // hints. The credentialId is echoed back on 404 so we can fire
      // signalUnknownCredential without holding a reference across the
      // round trip ourselves.
      const code = data?.error;
      if (status === 404 && code === 'unknown_credential') {
        signalUnknownCredential(data?.credentialId || assertion?.id);
        setPasskeyError(
          'This passkey isn’t recognized for any account here. ' +
          'You can sign in with your password instead, or remove this ' +
          'passkey from your device’s password manager.'
        );
      } else if (status === 410 && code === 'revoked') {
        // No cleanup signal — admin may unrevoke.
        setPasskeyError('This passkey has been revoked. Please sign in with your password.');
      } else if (status === 401 && code === 'inactive_user') {
        setPasskeyError('This account is deactivated.');
      } else if (status === 401 && code === 'verification_failed') {
        setPasskeyError('Couldn’t verify your passkey. Try again or sign in with your password.');
      } else {
        setPasskeyError('Sign-in failed. Please try again or use your password.');
      }
      setPhase('passkey-error');
    } catch (err) {
      // User cancelled the OS picker, or no credential available, or the
      // browser refused the call. NotAllowedError covers cancellation +
      // "no available credentials"; AbortError covers timeout / abort.
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'AbortError') {
        setPhase('credentials');
        return;
      }
      setPasskeyError('Sign-in failed. Please try again or use your password.');
      setPhase('passkey-error');
    }
  };

  // ---- Enrollment flow ----
  const startEnrollment = async (challId) => {
    try {
      const { data, ok } = await apiPost('/api/auth/mfa/enrollment/start', { challengeId: challId || loginChallengeId });
      if (!ok || !data) {
        showToast('Failed to start MFA enrollment.');
        setPhase('credentials');
        return;
      }

      if (data.phase === 'set-email') {
        setPhase('enrollment-email');
      } else if (data.phase === 'verify') {
        setMfaData({
          challengeId: data.challengeId,
          allowedMethods: data.allowedMethods,
          maskedEmail: data.maskedEmail,
          returnTo
        });
        setPhase('enrollment-verify');
      }
    } catch {
      showToast('Failed to start MFA enrollment.');
      setPhase('credentials');
    }
  };

  // ---- Enrollment: set email ----
  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    if (enrollEmailSubmitting) return;
    setEnrollEmailError('');
    setEnrollEmailSubmitting(true);

    try {
      const { data, ok, status } = await apiPost('/api/auth/mfa/enrollment/email/start', { email: enrollEmail, challengeId: loginChallengeId });
      if (status === 401) {
        showToast('Session expired. Please sign in again.');
        handleEnrollmentCancel();
        setEnrollEmailSubmitting(false);
        return;
      }
      if (ok && data?.success) {
        setEnrollChallengeId(data.challengeId);
        setEnrollMaskedEmail(data.maskedNewEmail);
        setEnrollOtpMinutes(data.otpValidityMinutes || 5);
        setPhase('enrollment-email-verify');
      } else {
        setEnrollEmailError(data?.error || 'Failed to send verification code.');
      }
    } catch {
      setEnrollEmailError('Unable to reach the server.');
    }

    setEnrollEmailSubmitting(false);
  };

  // ---- Enrollment: verify email OTP ----
  const handleEmailCodeSubmit = async (e) => {
    e.preventDefault();
    if (enrollCodeSubmitting || enrollCode.length !== 6) return;
    setEnrollCodeError('');
    setEnrollCodeSubmitting(true);

    try {
      const { data, ok, status } = await apiPost('/api/auth/mfa/enrollment/email/confirm', {
        challengeId: enrollChallengeId,
        code: enrollCode
      });

      if (status === 401) {
        showToast('Session expired. Please sign in again.');
        handleEnrollmentCancel();
        setEnrollCodeSubmitting(false);
        return;
      }

      if (ok && data?.success) {
        showToast('Email verified and MFA enabled.', 'success');
        loginCompleted.current = true;
        await refresh();
        navigate(returnTo, { replace: true });
        return;
      }

      if (data?.mustResend) {
        setEnrollCodeError('Too many attempts. Please request a new code.');
      } else {
        setEnrollCodeError(data?.error || 'Invalid code. Please try again.');
      }
      setEnrollCode('');
    } catch {
      setEnrollCodeError('Unable to reach the server.');
    }

    setEnrollCodeSubmitting(false);
  };

  const handleEmailResend = async () => {
    if (enrollResending) return;
    setEnrollResending(true);
    setEnrollCodeError('');

    try {
      const { data, ok, status } = await apiPost('/api/auth/mfa/enrollment/email/resend', {
        challengeId: enrollChallengeId
      });
      if (status === 401) {
        showToast('Session expired. Please sign in again.');
        handleEnrollmentCancel();
        setEnrollResending(false);
        return;
      }
      if (ok) {
        showToast('A new code has been sent.', 'success');
        if (data.otpValidityMinutes) setEnrollOtpMinutes(data.otpValidityMinutes);
      } else {
        showToast(data?.error || 'Failed to resend code.');
      }
    } catch {
      showToast('Unable to reach the server.');
    }

    setEnrollResending(false);
  };

  // ---- Enrollment: MFA challenge verify (user has email/methods) ----
  const handleEnrollmentVerifySuccess = async () => {
    showToast('MFA enabled successfully.', 'success');
    loginCompleted.current = true;
    await refresh();
    navigate(returnTo, { replace: true });
  };

  const handleEnrollmentCancel = () => {
    setPhase('credentials');
    setMfaData(null);
    setLoginChallengeId(null);
    setEnrollEmail('');
    setEnrollCode('');
    setEnrollChallengeId(null);
  };

  const policyNote = (
    <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px', fontSize: '14px' }}>
      Your account requires multi-factor authentication to be enabled due to security policy.
    </p>
  );

  return (
    <>
      <Header hasSidebar={false} />
      <main className="container">
        <div className="login-page">
          <div style={{ width: '100%', maxWidth: '400px' }}>
          <div className="card login-card" style={{ maxWidth: 'none' }}>
            {phase === 'credentials' && (
              <>
                <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>Welcome</h2>
                <form onSubmit={handleSubmit}>
                  <div className="form-group">
                    <label htmlFor="username">Username or Email Address</label>
                    <input
                      type="text"
                      id="username"
                      className="form-control"
                      required
                      autoFocus
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
                    />
                  </div>
                  <div className="form-group">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                      <label htmlFor="password" style={{ marginBottom: 0 }}>Password</label>
                      <Link to="/reset-password" tabIndex={-1} style={{ fontSize: '13px', color: '#6b7280', fontWeight: 'normal', textDecoration: 'none' }}>
                        Forgot password?
                      </Link>
                    </div>
                    <input
                      type="password"
                      id="password"
                      className="form-control"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value.replace(/\s/g, ''))}
                    />
                  </div>
                  {/* Turnstile widget gates BOTH the password Sign In button
                      and the "Sign in with a passkey" button below. The
                      widget itself only renders when turnstileSiteKey is
                      set; otherwise this block produces nothing and the
                      buttons stay enabled. */}
                  <Turnstile
                    onToken={setTurnstileToken}
                    onExpire={() => setTurnstileToken(null)}
                    onError={() => setTurnstileToken(null)}
                    resetRef={turnstileResetRef}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={submitting || turnstileGate}
                  >
                    {submitting ? 'Signing in...' : 'Sign In'}
                  </button>
                </form>

                {/* Passkey "quick sign in" — only show on browsers that
                    actually support WebAuthn. Hidden on truly ancient ones
                    rather than showing a dead button. */}
                {isWebAuthnSupported() && (
                  <>
                    <div className="login-or-divider">or</div>
                    <button
                      type="button"
                      className="btn btn-passkey"
                      style={{ width: '100%' }}
                      onClick={attemptPasskeyLogin}
                      disabled={submitting || turnstileGate}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                        {/* Person silhouette (slightly slimmed) + vertical key
                            on the right with two equal teeth at the bottom. */}
                        <circle cx="7.5" cy="6" r="2.3" stroke="currentColor" strokeWidth="1.6" fill="none"/>
                        <path d="M3.5 16c0-2.8 1.8-4.5 4-4.5s4 1.7 4 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                        <circle cx="15.2" cy="7" r="2" stroke="currentColor" strokeWidth="1.6" fill="none"/>
                        <path d="M15.2 9 v7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                        <path d="M15.2 13 h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                        <path d="M15.2 15 h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                      </svg>
                      Sign in with a passkey
                    </button>
                  </>
                )}
              </>
            )}

            {phase === 'passkey' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Use your passkey</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '8px' }}>
                  Your device will prompt you to verify your identity
                </p>
                <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '24px' }}>
                  Use your fingerprint, face, or security key to continue
                </p>

                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
                  <div className="spinner" />
                </div>

                <button
                  className="btn btn-secondary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  onClick={() => setPhase('credentials')}
                >
                  Back
                </button>
              </>
            )}

            {phase === 'passkey-error' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Sign-in failed</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '24px' }}>
                  {passkeyError || 'Something went wrong when trying to verify with your passkey.'}
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={attemptPasskeyLogin}
                  >
                    Try again
                  </button>
                  {/* White (not grey) "go back" — visually consistent with
                      the passkey entry button on the credentials view, so
                      the secondary action doesn't compete with the blue
                      primary "Try again" above. Reuses .btn-passkey since
                      it's already the project's white-outlined button
                      style; the SVG slot is just empty. */}
                  <button
                    className="btn btn-passkey"
                    style={{ width: '100%' }}
                    onClick={() => { setPasskeyError(''); setPhase('credentials'); }}
                  >
                    Sign in with password
                  </button>
                </div>
              </>
            )}

            {phase === 'mfa-verify' && mfaData && (
              <MfaChallengeUI
                challengeId={mfaData.challengeId}
                allowedMethods={mfaData.allowedMethods}
                maskedEmail={mfaData.maskedEmail}
                apiBase="/api/auth/mfa"
                onSuccess={handleMfaSuccess}
                onCancel={handleMfaCancel}
                isModal={false}
                title="Verify your identity"
              />
            )}

            {phase === 'enrollment-loading' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Enable MFA</h2>
                {policyNote}
                <div style={{ textAlign: 'center', padding: '20px' }}>
                  <div className="loading-spinner" />
                  <p className="text-muted" style={{ marginTop: '12px' }}>Loading...</p>
                </div>
              </>
            )}

            {phase === 'enrollment-email' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Add Email Address</h2>
                {policyNote}
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '16px', fontSize: '13px' }}>
                  Your account does not have an email address. Please add one to enable MFA.
                </p>
                <form onSubmit={handleEmailSubmit}>
                  <div className="form-group">
                    <label htmlFor="enrollEmail">Email Address</label>
                    <input
                      type="email"
                      id="enrollEmail"
                      className="form-control"
                      required
                      autoFocus
                      value={enrollEmail}
                      onChange={(e) => { setEnrollEmail(e.target.value); setEnrollEmailError(''); }}
                      placeholder="you@example.com"
                    />
                    {enrollEmailError && (
                      <div className="field-error" style={{ marginTop: '4px' }}>{enrollEmailError}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={handleEnrollmentCancel}
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={enrollEmailSubmitting || !enrollEmail}
                    >
                      {enrollEmailSubmitting ? 'Sending...' : 'Send Verification Code'}
                    </button>
                  </div>
                </form>
              </>
            )}

            {phase === 'enrollment-email-verify' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Verify Email</h2>
                {policyNote}
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '16px', fontSize: '13px' }}>
                  We sent a 6-digit code to <strong>{enrollMaskedEmail}</strong>.
                  Enter it below to verify your email. The code expires in {enrollOtpMinutes} minutes.
                </p>
                <form onSubmit={handleEmailCodeSubmit}>
                  <div className="form-group">
                    <label htmlFor="enrollCode">Verification Code</label>
                    <input
                      type="text"
                      id="enrollCode"
                      className="form-control"
                      value={enrollCode}
                      onChange={(e) => { setEnrollCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setEnrollCodeError(''); }}
                      placeholder="6-digit code"
                      maxLength={6}
                      autoComplete="off"
                      autoFocus
                      style={{ maxWidth: '200px' }}
                    />
                    {enrollCodeError && (
                      <div className="field-error" style={{ marginTop: '4px' }}>{enrollCodeError}</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={handleEnrollmentCancel}
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={enrollCodeSubmitting || enrollCode.length !== 6}
                    >
                      {enrollCodeSubmitting ? 'Verifying...' : 'Verify & Enable MFA'}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="btn btn-link"
                    style={{ marginTop: '8px', fontSize: '13px', width: '100%', justifyContent: 'center' }}
                    onClick={handleEmailResend}
                    disabled={enrollResending}
                  >
                    {enrollResending ? 'Sending...' : 'Resend code'}
                  </button>
                </form>
              </>
            )}

            {phase === 'enrollment-verify' && mfaData && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Enable MFA</h2>
                {policyNote}
                <MfaChallengeUI
                  challengeId={mfaData.challengeId}
                  allowedMethods={mfaData.allowedMethods}
                  maskedEmail={mfaData.maskedEmail}
                  apiBase="/api/auth/mfa/enrollment"
                  onSuccess={handleEnrollmentVerifySuccess}
                  onCancel={handleEnrollmentCancel}
                  isModal={false}
                  title=""
                />
              </>
            )}
          </div>
          {phase === 'credentials' && (
            <div className="card" style={{ marginTop: '12px', padding: '16px', textAlign: 'center' }}>
              <span style={{ color: '#6b7280', fontSize: '14px' }}>Don't have an account? </span>
              <Link to="/register" style={{ fontSize: '14px', color: '#111', fontWeight: '600', textDecoration: 'none' }}>
                Sign up
              </Link>
            </div>
          )}
          </div>
        </div>
      </main>
    </>
  );
}
