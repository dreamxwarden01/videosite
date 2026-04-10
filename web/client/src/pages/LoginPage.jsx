import { useState, useEffect } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiPost } from '../api';
import Header from '../components/Header';
import MfaChallengeUI from '../components/MfaChallengeUI';

export default function LoginPage() {
  const { user, refresh } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Phase: 'credentials' | 'mfa-verify' | 'enrollment-loading' | 'enrollment-email' | 'enrollment-email-verify' | 'enrollment-verify'
  const [phase, setPhase] = useState('credentials');
  const [mfaData, setMfaData] = useState(null); // { challengeId, allowedMethods, maskedEmail, returnTo }
  const [returnTo, setReturnTo] = useState('/');
  const [loginChallengeId, setLoginChallengeId] = useState(null); // bmfa challenge from login for enrollment

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

  // If already logged in, redirect
  useEffect(() => {
    if (user) navigate('/profile', { replace: true });
  }, [user, navigate]);


  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const rt = searchParams.get('returnTo') || '/';

    try {
      const { data, status, ok } = await apiPost('/api/login', { username, password, returnTo: rt });

      if (status === 429) {
        showToast('Too many login attempts. Please wait a moment and try again.');
        setSubmitting(false);
        return;
      }

      if (ok && data) {
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
        await refresh();
        navigate(data.returnTo || '/', { replace: true });
        return;
      }

      showToast(data?.message || 'Login failed');
    } catch {
      showToast('Unable to reach the server. Please check your connection.');
    }

    setSubmitting(false);
  };

  // ---- MFA Verify (existing users with MFA) ----
  const handleMfaSuccess = async () => {
    await refresh();
    navigate(mfaData?.returnTo || '/', { replace: true });
  };

  const handleMfaCancel = () => {
    setPhase('credentials');
    setMfaData(null);
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
                <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>Sign In</h2>
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
                      onChange={(e) => setUsername(e.target.value)}
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
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={submitting}
                  >
                    {submitting ? 'Signing in...' : 'Sign In'}
                  </button>
                </form>
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
