import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiGet, apiPost } from '../api';
import Header from '../components/Header';
import MfaChallengeUI from '../components/MfaChallengeUI';
import PasswordRules, { checkPasswordComplexity } from '../components/PasswordRules';

export default function ResetPasswordConfirmPage() {
  const { user, refresh } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const token = searchParams.get('token') || '';

  // Phase: 'validating' | 'form' | 'mfa' | 'error'
  const [phase, setPhase] = useState('validating');

  // Form state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});

  // MFA state
  const [mfaData, setMfaData] = useState(null);

  useEffect(() => {
    if (user) navigate('/profile', { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    document.title = `Reset Password - ${siteName}`;
  }, [siteName]);

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setPhase('error');
      return;
    }

    (async () => {
      try {
        const { ok } = await apiGet(`/api/password-reset/validate-token?token=${encodeURIComponent(token)}`);
        setPhase(ok ? 'form' : 'error');
      } catch {
        setPhase('error');
      }
    })();
  }, [token]);

  // Password validation
  const { error: pwError } = checkPasswordComplexity(password);
  const confirmError = confirmPassword && password !== confirmPassword ? 'Passwords do not match.' : '';
  const formValid = password && !pwError && confirmPassword && !confirmError;

  const handlePasswordBlur = () => {
    setTouched(prev => ({ ...prev, password: true }));
    if (confirmPassword) setTouched(prev => ({ ...prev, confirmPassword: true }));
  };
  const handleConfirmBlur = () => {
    setTouched(prev => ({ ...prev, confirmPassword: true }));
  };

  const submitReset = useCallback(async () => {
    setErrors({});
    setSubmitting(true);

    try {
      const { data, ok, status } = await apiPost('/api/password-reset/confirm', {
        token,
        password,
        confirmPassword
      });

      if (ok && data?.success) {
        showToast('Password reset successfully.', 'success');
        await refresh();
        navigate('/', { replace: true });
        return;
      }

      if (data?.requireMFA) {
        setMfaData({
          challengeId: data.challengeId,
          allowedMethods: data.allowedMethods,
          maskedEmail: data.maskedEmail
        });
        setPhase('mfa');
        setSubmitting(false);
        return;
      }

      if (status === 422 && data?.errors) {
        if (data.errors.token) {
          setPhase('error');
        } else {
          setErrors(data.errors);
        }
        setSubmitting(false);
        return;
      }

      showToast(data?.message || 'Failed to reset password.');
    } catch {
      showToast('Unable to reach the server. Please check your connection.');
    }

    setSubmitting(false);
  }, [token, password, confirmPassword, refresh, navigate, showToast]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (submitting || !formValid) return;
    submitReset();
  };

  const handleMfaSuccess = async () => {
    // MFA verified — re-submit password reset with mfaChallengeId
    const savedChallengeId = mfaData?.challengeId;
    setPhase('form');
    setMfaData(null);
    setSubmitting(true);

    try {
      const { data, ok } = await apiPost('/api/password-reset/confirm', {
        token,
        password,
        confirmPassword,
        mfaChallengeId: savedChallengeId
      });

      if (ok && data?.success) {
        showToast('Password reset successfully.', 'success');
        await refresh();
        navigate('/', { replace: true });
        return;
      }

      if (data?.errors?.token) {
        setPhase('error');
      } else {
        showToast(data?.message || data?.error || 'Failed to reset password.');
        setPhase('form');
      }
    } catch {
      showToast('Unable to reach the server.');
      setPhase('form');
    }

    setSubmitting(false);
  };

  const handleMfaCancel = () => {
    setPhase('form');
    setMfaData(null);
  };

  return (
    <>
      <Header hasSidebar={false} />
      <main className="container">
        <div className="login-page">
          <div style={{ width: '100%', maxWidth: '400px' }}>
          <div className="card login-card" style={{ maxWidth: 'none' }}>
            {phase === 'validating' && (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <div className="loading-spinner" />
                <p className="text-muted" style={{ marginTop: '12px' }}>Validating reset link...</p>
              </div>
            )}

            {phase === 'form' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Set New Password</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px', fontSize: '14px' }}>
                  Enter your new password below.
                </p>
                <form onSubmit={handleSubmit}>
                  <div className="form-group">
                    <label htmlFor="newPassword">New Password</label>
                    <input
                      type="password"
                      id="newPassword"
                      className={`form-control${touched.password && pwError ? ' input-error' : ''}`}
                      autoFocus
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value.replace(/\s/g, ''))}
                      onBlur={handlePasswordBlur}
                    />
                    <PasswordRules password={password} />
                    {errors.password && (
                      <div className="field-error" style={{ marginTop: '4px' }}>{errors.password}</div>
                    )}
                  </div>
                  <div className="form-group">
                    <label htmlFor="confirmNewPassword">Confirm New Password</label>
                    <input
                      type="password"
                      id="confirmNewPassword"
                      className={`form-control${touched.confirmPassword && confirmError ? ' input-error' : ''}`}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value.replace(/\s/g, ''))}
                      onBlur={handleConfirmBlur}
                    />
                    {touched.confirmPassword && (confirmError || errors.confirmPassword) && (
                      <div className="field-error" style={{ marginTop: '4px' }}>{confirmError || errors.confirmPassword}</div>
                    )}
                  </div>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={submitting || !formValid}
                  >
                    {submitting ? 'Resetting...' : 'Reset Password'}
                  </button>
                </form>
              </>
            )}

            {phase === 'mfa' && mfaData && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Verify Your Identity</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '16px', fontSize: '14px' }}>
                  Your account requires additional verification to complete the password reset.
                </p>
                <MfaChallengeUI
                  challengeId={mfaData.challengeId}
                  allowedMethods={mfaData.allowedMethods}
                  maskedEmail={mfaData.maskedEmail}
                  apiBase="/api/password-reset/mfa"
                  onSuccess={handleMfaSuccess}
                  onCancel={handleMfaCancel}
                  isModal={false}
                  title=""
                />
              </>
            )}

            {phase === 'error' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Link Expired</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px', lineHeight: '1.6' }}>
                  This password reset link is invalid or has expired. Please request a new one.
                </p>
                <Link
                  to="/reset-password"
                  className="btn btn-primary"
                  style={{ display: 'block', width: '100%', textAlign: 'center', justifyContent: 'center', textDecoration: 'none' }}
                >
                  Request a new link
                </Link>
              </>
            )}
          </div>
          {(phase === 'form' || phase === 'error') && (
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
