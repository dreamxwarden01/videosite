import { useState, useEffect, useRef, useCallback } from 'react';
import { apiPost } from '../api';
import { startAuthentication } from '@simplewebauthn/browser';

/* ------------------------------------------------------------------ */
/*  6-digit OTP input row                                             */
/* ------------------------------------------------------------------ */
function OtpInput({ value, onChange, disabled, hasError, onClearError, onSubmit }) {
  const inputsRef = useRef([]);

  const focusIndex = (i) => {
    inputsRef.current[i]?.focus();
  };

  const pendingSubmit = useRef(false);

  useEffect(() => {
    if (pendingSubmit.current && onSubmit && value.join('').length === 6) {
      pendingSubmit.current = false;
      onSubmit();
    }
  }, [value, onSubmit]);

  const handleChange = (e, i) => {
    if (hasError && onClearError) onClearError();
    const char = e.target.value.replace(/\D/g, '').slice(-1);
    const next = [...value];
    next[i] = char;
    onChange(next);
    if (char && i < 5) {
      focusIndex(i + 1);
    } else if (char && i === 5) {
      pendingSubmit.current = true;
    }
  };

  const handleKeyDown = (e, i) => {
    if (e.key === 'Backspace') {
      if (value[i]) {
        const next = [...value];
        next[i] = '';
        onChange(next);
      } else if (i > 0) {
        const next = [...value];
        next[i - 1] = '';
        onChange(next);
        focusIndex(i - 1);
      }
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      focusIndex(i - 1);
    } else if (e.key === 'ArrowRight' && i < 5) {
      focusIndex(i + 1);
    } else if (e.key === 'Enter') {
      if (onSubmit && value.join('').length === 6) {
        e.preventDefault();
        onSubmit();
      }
    }
  };

  const handlePaste = (e, fromIndex) => {
    e.preventDefault();
    if (hasError && onClearError) onClearError();
    const pasted = (e.clipboardData || window.clipboardData || { getData: () => '' })
      .getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length && i < 6; i++) next[i] = pasted[i];
    if (pasted.length === 6) pendingSubmit.current = true;
    onChange(next);
    focusIndex(Math.min(pasted.length, 5));
  };

  // Mobile browsers sometimes deliver pasted content via onChange with multiple chars
  const handleInput = (e, i) => {
    const raw = e.target.value.replace(/\D/g, '');
    if (raw.length > 1) {
      // Multi-char input (likely paste on mobile)
      if (hasError && onClearError) onClearError();
      const next = ['', '', '', '', '', ''];
      for (let j = 0; j < raw.length && j < 6; j++) next[j] = raw[j];
      if (raw.length >= 6) pendingSubmit.current = true;
      onChange(next);
      focusIndex(Math.min(raw.length, 5));
      return true;
    }
    return false;
  };

  const handleChangeWrapped = (e, i) => {
    if (handleInput(e, i)) return;
    handleChange(e, i);
  };

  return (
    <div className="otp-inputs" onClick={() => { if (hasError && onClearError) onClearError(); }}>
      {Array.from({ length: 6 }, (_, i) => (
        <input
          key={i}
          ref={(el) => { inputsRef.current[i] = el; }}
          className={`otp-input${hasError ? ' otp-input-error' : ''}`}
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={value[i] || ''}
          onChange={(e) => handleChangeWrapped(e, i)}
          onKeyDown={(e) => handleKeyDown(e, i)}
          onPaste={(e) => handlePaste(e, i)}
          disabled={disabled}
          autoFocus={i === 0}
          autoComplete="one-time-code"
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  MfaChallengeUI                                                     */
/* ------------------------------------------------------------------ */
const RESEND_COOLDOWN = 60;

export default function MfaChallengeUI({
  challengeId,
  allowedMethods,
  maskedEmail,
  apiBase = '/api/mfa',
  onSuccess,
  onCancel,
  isModal = false,
  title = 'Verify your identity',
}) {
  // Always show method selection — user must choose explicitly
  const [step, setStep] = useState('select');

  // OTP digits (shared between email + authenticator)
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failCount, setFailCount] = useState(0);

  // Resend cooldown for email step
  const [resendCountdown, setResendCountdown] = useState(0);
  const [otpValidityMinutes, setOtpValidityMinutes] = useState(null);
  const [otpError, setOtpError] = useState(false);
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0);
  const otpInputsRef = useRef(null);
  const countdownEndRef = useRef(0);
  const countdownTimerRef = useRef(null);
  const rateLimitEndRef = useRef(0);
  const rateLimitTimerRef = useRef(null);

  // Email send state on method select screen
  const [emailSending, setEmailSending] = useState(false);
  const [emailDailyLimitReached, setEmailDailyLimitReached] = useState(false);
  const [inlineError, setInlineError] = useState('');
  const [otpAlreadySent, setOtpAlreadySent] = useState(false);

  /* ---------- helpers ---------- */

  const resetOtp = (showError = false) => {
    setDigits(['', '', '', '', '', '']);
    if (showError) setOtpError(true);
    // Focus first input after reset
    setTimeout(() => {
      const firstInput = document.querySelector('.otp-inputs input');
      if (firstInput) firstInput.focus();
    }, 50);
    setError('');
  };

  const startResendTimer = useCallback((seconds = RESEND_COOLDOWN) => {
    if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
    countdownEndRef.current = Date.now() + seconds * 1000;
    setResendCountdown(seconds);

    countdownTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((countdownEndRef.current - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setResendCountdown(0);
      } else {
        setResendCountdown(remaining);
      }
    }, 1000);
  }, []);

  const startRateLimitTimer = useCallback((seconds) => {
    if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current);
    rateLimitEndRef.current = Date.now() + seconds * 1000;
    setRateLimitCountdown(seconds);
    rateLimitTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((rateLimitEndRef.current - Date.now()) / 1000);
      if (remaining <= 0) {
        clearInterval(rateLimitTimerRef.current);
        rateLimitTimerRef.current = null;
        setRateLimitCountdown(0);
        setError('');
      } else {
        setRateLimitCountdown(remaining);
      }
    }, 1000);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      if (rateLimitTimerRef.current) clearInterval(rateLimitTimerRef.current);
    };
  }, []);

  /* ---------- send OTP (email) ---------- */

  const sendOtp = useCallback(async () => {
    try {
      const { ok, data, status } = await apiPost(`${apiBase}/send-otp`, { challengeId });
      if (ok) {
        if (data?.otpValidityMinutes) setOtpValidityMinutes(data.otpValidityMinutes);
        setOtpAlreadySent(true);
        startResendTimer();
        return { ok: true };
      }
      if (status === 429) {
        if (data && typeof data.retryAfter === 'number') {
          startResendTimer(data.retryAfter);
          return { ok: false, retryAfter: data.retryAfter, error: data.error };
        }
        if (data && data.retryAfter === null) {
          // Daily limit
          setEmailDailyLimitReached(true);
          return { ok: false, dailyLimit: true };
        }
        // Cloudflare non-JSON 429
        startResendTimer(30);
        return { ok: false, retryAfter: 30, error: 'Too many requests.' };
      }
      return { ok: false, error: data?.error || data?.message || 'Failed to send code.' };
    } catch {
      return { ok: false, error: 'Unable to reach the server.' };
    }
  }, [apiBase, challengeId, startResendTimer]);


  /* ---------- verify ---------- */

  const handleVerify = async (method, code) => {
    setLoading(true);
    setError('');
    try {
      const body = { challengeId, method, code };
      const { ok, data, status } = await apiPost(`${apiBase}/verify`, body);

      if (ok) {
        onSuccess(challengeId);
        return;
      }

      if (status === 429) {
        const retrySeconds = data?.retryAfterSeconds || 30;
        setError(`Too many attempts. Try again in ${retrySeconds}s`);
        startRateLimitTimer(retrySeconds);
        resetOtp(true);
        setLoading(false);
        return;
      }

      const newFails = failCount + 1;
      setFailCount(newFails);

      if (data?.mustResend) {
        setError('Code expired. Please request a new code.');
        resetOtp(true);
      } else if (newFails >= 5 && method === 'email') {
        setError('Too many attempts. Please request a new code.');
        resetOtp(true);
        sendOtp();
      } else {
        setError(data?.message || 'Verification failed. Please try again.');
        resetOtp(true);
      }
    } catch {
      setError('Unable to reach the server.');
    }
    setLoading(false);
  };

  const handleOtpVerify = (method) => {
    const code = digits.join('');
    if (code.length !== 6) {
      setError('Please enter all 6 digits.');
      return;
    }
    handleVerify(method, code);
  };

  /* ---------- resend ---------- */

  const handleResend = async () => {
    if (resendCountdown > 0) return;
    resetOtp();
    setFailCount(0);
    const result = await sendOtp();
    if (!result.ok && result.error) setError(result.error);
  };

  /* ---------- passkey ---------- */

  const attemptPasskey = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { ok: optOk, data: optData } = await apiPost(`${apiBase}/passkey/auth-options`, { challengeId });
      if (!optOk || !optData) {
        setStep('passkey-error');
        setLoading(false);
        return;
      }

      const credential = await startAuthentication({ optionsJSON: optData });

      const { ok, data } = await apiPost(`${apiBase}/verify`, {
        challengeId,
        method: 'passkey',
        code: credential,
      });

      if (ok) {
        onSuccess(challengeId);
        return;
      }

      setError(data?.message || '');
      setStep('passkey-error');
    } catch {
      setStep('passkey-error');
    }
    setLoading(false);
  }, [apiBase, challengeId, onSuccess]);

  // Auto-trigger passkey when entering passkey step
  useEffect(() => {
    if (step === 'passkey') {
      attemptPasskey();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /* ---------- navigation ---------- */

  const goToSelect = () => {
    resetOtp();
    setFailCount(0);
    setError('');
    setLoading(false);
    setInlineError('');
    // Preserve resend cooldown timer — don't clear countdownTimerRef/resendCountdown
    if (rateLimitTimerRef.current) {
      clearInterval(rateLimitTimerRef.current);
      rateLimitTimerRef.current = null;
    }
    setRateLimitCountdown(0);
    setStep('select');
  };

  const goToMethod = async (method) => {
    if (method === 'email') {
      if (otpAlreadySent) {
        // Returning to OTP entry — no re-send, existing code still valid
        resetOtp();
        setFailCount(0);
        setError('');
        setStep('email');
        return;
      }
      // First time: send OTP, only transition on success
      setEmailSending(true);
      setInlineError('');
      const result = await sendOtp();
      setEmailSending(false);
      if (result.ok) {
        resetOtp();
        setFailCount(0);
        setError('');
        setStep('email');
      } else if (result.dailyLimit) {
        // emailDailyLimitReached already set by sendOtp
      } else if (result.retryAfter) {
        // Timer already running, button shows countdown
      } else if (result.error) {
        setInlineError(result.error);
      }
      return;
    }
    // Non-email methods: immediate transition
    resetOtp();
    setFailCount(0);
    setError('');
    setLoading(false);
    if (rateLimitTimerRef.current) {
      clearInterval(rateLimitTimerRef.current);
      rateLimitTimerRef.current = null;
    }
    setRateLimitCountdown(0);
    setStep(method);
  };

  const handleBack = () => {
    if (step === 'select') {
      onCancel();
    } else {
      goToSelect();
    }
  };

  /* ================================================================ */
  /*  Render steps                                                     */
  /* ================================================================ */

  let content;

  if (step === 'select') {
    content = (
      <>
        <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>{title}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {allowedMethods.includes('email') && (() => {
            // Grey out: daily limit, actively sending, or 429 backoff before first successful send
            const disabled = emailDailyLimitReached || emailSending || (!otpAlreadySent && resendCountdown > 0);
            let subtitle;
            if (emailDailyLimitReached) subtitle = 'Daily limit reached';
            else if (emailSending) subtitle = 'Sending code...';
            else if (!otpAlreadySent && resendCountdown > 0) subtitle = `Please wait ${resendCountdown}s before requesting a code`;
            else if (resendCountdown > 0) subtitle = `Code sent — resend in ${resendCountdown}s`;
            else subtitle = otpAlreadySent ? `Send a new code to ${maskedEmail}` : `Send a code to ${maskedEmail}`;
            return (
              <button className="mfa-method-option" onClick={() => goToMethod('email')} disabled={disabled} style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}}>
                <strong>Email verification</strong>
                <span className="text-muted text-sm">{subtitle}</span>
              </button>
            );
          })()}
          {allowedMethods.includes('authenticator') && (
            <button className="mfa-method-option" onClick={() => goToMethod('authenticator')}>
              <strong>Authenticator app</strong>
              <span className="text-muted text-sm">Enter a code from your authenticator</span>
            </button>
          )}
          {allowedMethods.includes('passkey') && (
            <button className="mfa-method-option" onClick={() => goToMethod('passkey')}>
              <strong>Security key or passkey</strong>
              <span className="text-muted text-sm">Use your passkey or security key</span>
            </button>
          )}
        </div>
        {inlineError && <div className="field-error" style={{ textAlign: 'center', marginBottom: '12px' }}>{inlineError}</div>}
        <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={onCancel}>
          Cancel
        </button>
      </>
    );
  } else if (step === 'email') {
    content = emailDailyLimitReached ? (
      <>
        <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Check your email</h2>
        <p style={{ textAlign: 'center', color: '#555', marginBottom: '24px' }}>
          You've reached the daily email verification limit. Please try again tomorrow.
        </p>
        <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={handleBack}>
          Back
        </button>
      </>
    ) : (
      <>
        <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Check your email</h2>
        <p style={{ textAlign: 'center', color: '#555', marginBottom: '4px' }}>
          We sent a code to {maskedEmail}
        </p>
        <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '20px' }}>
          The code expires in {otpValidityMinutes || 5} minutes
        </p>

        <OtpInput value={digits} onChange={setDigits} disabled={loading} hasError={otpError} onClearError={() => setOtpError(false)} onSubmit={() => handleOtpVerify('email')} />

        {error && <div className="field-error" style={{ textAlign: 'center', marginTop: '8px' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px', marginBottom: '20px' }}>
          <button
            className="btn btn-sm btn-secondary"
            disabled={resendCountdown > 0 || loading}
            onClick={handleResend}
            type="button"
          >
            {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={handleBack} disabled={loading}>
            Back
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={loading || digits.join('').length !== 6}
            onClick={() => handleOtpVerify('email')}
          >
            {loading ? 'Verifying...' : 'Verify'}
          </button>
        </div>
      </>
    );
  } else if (step === 'authenticator') {
    content = (
      <>
        <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Enter authenticator code</h2>
        <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px' }}>
          Open your authenticator app and enter the 6-digit code
        </p>

        <OtpInput value={digits} onChange={setDigits} disabled={loading || rateLimitCountdown > 0} hasError={otpError} onClearError={() => setOtpError(false)} onSubmit={() => handleOtpVerify('authenticator')} />

        {(error || rateLimitCountdown > 0) && (
          <div className="field-error" style={{ textAlign: 'center', marginTop: '8px' }}>
            {rateLimitCountdown > 0
              ? `Too many attempts. Try again in ${rateLimitCountdown}s`
              : error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button className="btn btn-secondary" style={{ flex: 1, justifyContent: 'center' }} onClick={handleBack} disabled={loading}>
            Back
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
            disabled={loading || digits.join('').length !== 6 || rateLimitCountdown > 0}
            onClick={() => handleOtpVerify('authenticator')}
          >
            {loading ? 'Verifying...' : rateLimitCountdown > 0 ? `Wait (${rateLimitCountdown}s)` : 'Verify'}
          </button>
        </div>
      </>
    );
  } else if (step === 'passkey') {
    content = (
      <>
        <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Use your passkey</h2>
        <p style={{ textAlign: 'center', color: '#555', marginBottom: '8px' }}>
          Your device will prompt you to verify your identity
        </p>
        <p style={{ textAlign: 'center', color: '#6b7280', fontSize: '13px', marginBottom: '24px' }}>
          Use your fingerprint, face, or security key to continue
        </p>

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
            <div className="spinner" />
          </div>
        )}

        <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={handleBack} disabled={loading}>
          Back
        </button>
      </>
    );
  } else if (step === 'passkey-error') {
    content = (
      <>
        <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Verification failed</h2>
        <p style={{ textAlign: 'center', color: '#555', marginBottom: '24px' }}>
          Something went wrong when trying to verify with your passkey.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => goToMethod('passkey')}
          >
            Try again
          </button>
          <button
            className="btn btn-secondary"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={goToSelect}
          >
            {allowedMethods.length > 1 ? 'Use a different method' : 'Back'}
          </button>
        </div>
      </>
    );
  }

  /* ---------- wrap in card / modal ---------- */

  if (isModal) {
    return (
      <div className="mfa-challenge-overlay">
        <div className="mfa-challenge-modal" onClick={(e) => e.stopPropagation()}>{content}</div>
      </div>
    );
  }

  return <div>{content}</div>;
}
