import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiPost } from '../api';
import Header from '../components/Header';
import Turnstile from '../components/Turnstile';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default function RegisterPage() {
  const { user } = useAuth();
  const { siteName, invitationRequired, turnstileSiteKey, refreshSiteSettings } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();

  // Step state
  const [step, setStep] = useState(1);

  // Step 1 fields
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailError, setEmailError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [emailValid, setEmailValid] = useState(false);
  const [codeValid, setCodeValid] = useState(!invitationRequired);
  const [submitting, setSubmitting] = useState(false);

  // Turnstile tokens
  const [token1, setToken1] = useState(null);
  const [token2, setToken2] = useState(null);
  const resetRef1 = useRef(null);
  const resetRef2 = useRef(null);

  // Resend countdown
  const [countdown, setCountdown] = useState(0);
  const [limitReached, setLimitReached] = useState(false);
  const countdownEndRef = useRef(0);
  const countdownTimerRef = useRef(null);

  // Step 2 turnstile: lazy init after countdown ends
  const [step2TurnstileReady, setStep2TurnstileReady] = useState(false);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Register - ${siteName}`;
  }, [siteName]);

  useEffect(() => {
    if (user) navigate('/profile', { replace: true });
  }, [user, navigate]);

  // Update invitation code validity when invitationRequired changes
  useEffect(() => {
    if (!invitationRequired) setCodeValid(true);
  }, [invitationRequired]);

  // Email blur validation
  const handleEmailBlur = () => {
    const val = email.trim();
    if (val && !isValidEmail(val)) {
      setEmailError('Please enter a valid email address.');
      setEmailValid(false);
    } else {
      setEmailError('');
      setEmailValid(val.length > 0);
    }
  };

  // Invitation code input — codes are 12 uppercase alphanumeric chars
  // (see generateInvitationCode in registrationService.js). Strip anything
  // outside that set as the user types so a paste with stray punctuation
  // or whitespace silently normalises instead of triggering a validation
  // error on submit.
  const handleCodeInput = (e) => {
    const val = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    setCode(val);
    setCodeError('');
    setCodeValid(/^[A-Z0-9]{12}$/.test(val));
  };

  const handleCodeBlur = () => {
    if (code.length > 0 && code.length !== 12) {
      setCodeError('Invitation code must be exactly 12 characters.');
      setCodeValid(false);
    }
  };

  const continueEnabled = emailValid && codeValid && (token1 || !turnstileSiteKey) && !submitting;

  // --- Resend countdown ---
  const startResendCountdown = useCallback((backoffSeconds) => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    setToken2(null);
    setStep2TurnstileReady(false);

    if (!backoffSeconds || backoffSeconds <= 0) {
      countdownEndRef.current = 0;
      setCountdown(0);
      setStep2TurnstileReady(true);
      return;
    }

    countdownEndRef.current = Date.now() + backoffSeconds * 1000;
    setCountdown(backoffSeconds);

    countdownTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((countdownEndRef.current - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        countdownEndRef.current = 0;
        setCountdown(0);
        setStep2TurnstileReady(true);
      } else {
        setCountdown(remaining);
      }
    }, 1000);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    };
  }, []);

  // Handle page visibility for countdown
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && step === 2 && countdownEndRef.current > 0) {
        const remaining = Math.ceil((countdownEndRef.current - Date.now()) / 1000);
        if (remaining <= 0) {
          if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
          countdownEndRef.current = 0;
          setCountdown(0);
          setStep2TurnstileReady(true);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [step]);

  const resendEnabled = !limitReached && countdown <= 0 && (token2 || !turnstileSiteKey) && !submitting;

  // --- Continue button (step 1) ---
  // Token-clear + widget reset happens ONLY on failure. Pre-emptive clears
  // before the fetch were causing the widget to flash even on success and
  // weren't needed (success navigates the user away). On 422/turnstile,
  // also re-fetch /api/settings/public if the local site key was null —
  // server tells us Turnstile just got enabled.
  const handleContinue = async () => {
    if (submitting) return;
    setSubmitting(true);

    let gotError = false;

    try {
      const body = { email: email.trim(), turnstileToken: token1 };
      if (invitationRequired) body.invitationCode = code;

      const { data, status, ok } = await apiPost('/api/register/start', body);

      if (ok && data) {
        setStep(2);
        startResendCountdown(data.resend_backoff || 0);
        setSubmitting(false);
        return;
      }

      gotError = true;

      if (status === 429) {
        if (data && data.canRetry && data.retryAfter) {
          showToast(data.message || `Please wait ${data.retryAfter} seconds.`);
        } else if (data?.message) {
          showToast(data.message);
        } else {
          showToast('Too many requests. Please wait a moment and try again.');
        }
      } else if (status === 403 && data?.errors?.turnstile) {
        // Turnstile failure (must be checked before the generic 403 branch
        // below so the registration-closed message doesn't shadow it).
        showToast(data.errors.turnstile);
        // Server says Turnstile is required but our local state didn't
        // know — refresh and the widget will mount on the next render.
        if (!turnstileSiteKey) await refreshSiteSettings();
      } else if (status === 403 && data) {
        showToast(data.message || 'Registration is currently closed.');
      } else if (status === 422 && data?.errors) {
        if (data.errors.email) { setEmailError(data.errors.email); setEmailValid(false); }
        if (data.errors.invitationCode) { setCodeError(data.errors.invitationCode); setCodeValid(false); }
      } else if (data?.message) {
        showToast(data.message);
      } else {
        showToast('An error occurred. Please try again.');
      }
    } catch {
      gotError = true;
      showToast('Unable to reach the server. Please check your connection.');
    }

    if (gotError) {
      setToken1(null);
      resetRef1.current?.();
    }
    setSubmitting(false);
  };

  // --- Resend button (step 2) ---
  const handleResend = async () => {
    if (submitting || countdown > 0) return;
    setSubmitting(true);

    let gotError = false;

    try {
      const body = { email: email.trim(), turnstileToken: token2 };
      if (invitationRequired) body.invitationCode = code;

      const { data, status, ok } = await apiPost('/api/register/start', body);

      if (ok && data) {
        showToast('Verification email resent.', 'success');
        startResendCountdown(data.resend_backoff || 0);
        // Defensive: when backoff > 0, the countdown unmounts the widget
        // so the next mount produces a fresh challenge automatically.
        // When backoff is 0 or omitted, the widget stays mounted —
        // explicit reset here ensures the user gets a fresh token even
        // in that edge case so a subsequent resend isn't sent with a
        // stale (server-consumed) token.
        resetRef2.current?.();
        setSubmitting(false);
        return;
      }

      gotError = true;

      if (status === 429) {
        if (data && !data.canRetry) {
          setLimitReached(true);
          showToast(data.message || 'Daily email limit reached.');
        } else if (data?.retryAfter) {
          startResendCountdown(data.retryAfter);
          showToast(data.message || 'Please wait before requesting another email.');
        } else {
          showToast('Too many requests. Please wait a moment and try again.');
        }
      } else if (status === 403 && data?.errors?.turnstile) {
        showToast(data.errors.turnstile);
        if (!turnstileSiteKey) await refreshSiteSettings();
      } else if (data?.message) {
        showToast(data.message);
      } else {
        showToast('Failed to resend email. Please try again.');
      }
    } catch {
      gotError = true;
      showToast('Unable to reach the server. Please check your connection.');
    }

    if (gotError) {
      setToken2(null);
      resetRef2.current?.();
    }
    setSubmitting(false);
  };

  return (
    <>
      <Header hasSidebar={false} />
      <main className="container">
        <div className="login-page">
          <div style={{ width: '100%', maxWidth: '400px' }}>
          <div className="card login-card" style={{ maxWidth: 'none' }}>
            {step === 1 ? (
              <>
                <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>Register</h2>
                <div className="form-group">
                  <label htmlFor="email">Email Address</label>
                  <input
                    type="email"
                    id="email"
                    className={`form-control${emailError ? ' input-error' : ''}`}
                    value={email}
                    onChange={(e) => { const v = e.target.value.replace(/\s/g, ''); setEmail(v); setEmailError(''); setEmailValid(isValidEmail(v.trim())); }}
                    onBlur={handleEmailBlur}
                    autoFocus
                  />
                  {emailError && <span className="field-error">{emailError}</span>}
                </div>
                {invitationRequired && (
                  <div className="form-group">
                    <label htmlFor="invitationCode">Invitation Code</label>
                    <input
                      type="text"
                      id="invitationCode"
                      className={`form-control${codeError ? ' input-error' : ''}`}
                      value={code}
                      onChange={handleCodeInput}
                      onBlur={handleCodeBlur}
                      maxLength={12}
                      style={{ textTransform: 'uppercase' }}
                    />
                    {codeError && <span className="field-error">{codeError}</span>}
                  </div>
                )}
                <Turnstile
                  onToken={setToken1}
                  onExpire={() => setToken1(null)}
                  onError={() => setToken1(null)}
                  resetRef={resetRef1}
                />
                <button
                  className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={!continueEnabled}
                  onClick={handleContinue}
                >
                  {submitting ? 'Sending...' : 'Continue'}
                </button>
              </>
            ) : (
              <>
                <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>Check Your Email</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '8px' }}>A verification email has been sent to</p>
                <p style={{ textAlign: 'center', fontWeight: '600', color: '#333', marginBottom: '8px' }}>{email.trim()}</p>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '24px' }}>Click the link in the email to continue your registration.</p>
                {step2TurnstileReady && (
                  <Turnstile
                    onToken={setToken2}
                    onExpire={() => setToken2(null)}
                    onError={() => setToken2(null)}
                    resetRef={resetRef2}
                  />
                )}
                <button
                  className="btn btn-secondary"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={!resendEnabled}
                  onClick={handleResend}
                >
                  {submitting ? 'Sending...' : limitReached ? 'Limit Reached' : countdown > 0 ? `Resend in ${countdown}s` : 'Resend Email'}
                </button>
              </>
            )}
          </div>
          {step === 1 && (
            <div className="card" style={{ marginTop: '12px', padding: '16px', textAlign: 'center' }}>
              <span style={{ color: '#6b7280', fontSize: '14px' }}>Already have an account? </span>
              <Link to="/login" style={{ fontSize: '14px', color: '#111', fontWeight: '600', textDecoration: 'none' }}>
                Sign in
              </Link>
            </div>
          )}
          </div>
        </div>
      </main>
    </>
  );
}
