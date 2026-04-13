import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiPost } from '../api';
import Header from '../components/Header';
import Turnstile from '../components/Turnstile';

export default function ResetPasswordPage() {
  const { user } = useAuth();
  const { siteName } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [phase, setPhase] = useState('form'); // 'form' | 'sent'
  const [sentEmail, setSentEmail] = useState('');

  // Turnstile
  const [turnstileToken, setTurnstileToken] = useState(null);
  const resetRef = useRef(null);

  useEffect(() => {
    if (user) navigate('/profile', { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    document.title = `Reset Password - ${siteName}`;
  }, [siteName]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    // Client-side email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      setEmailError('Please enter a valid email address.');
      return;
    }

    setEmailError('');
    setSubmitting(true);

    try {
      const { data, status } = await apiPost('/api/password-reset/request', {
        email: email.trim(),
        turnstileToken
      });

      if (status === 422 && data?.errors) {
        if (data.errors.turnstile) {
          showToast(data.errors.turnstile);
          if (resetRef.current) resetRef.current();
          setTurnstileToken(null);
        }
        if (data.errors.email) {
          setEmailError(data.errors.email);
        }
        setSubmitting(false);
        return;
      }

      // Cloudflare 429 (HTML, data is null)
      if (status === 429) {
        showToast('Too many requests. Please wait a moment and try again.');
        if (resetRef.current) resetRef.current();
        setTurnstileToken(null);
        setSubmitting(false);
        return;
      }

      // Show sent confirmation regardless of actual result
      setSentEmail(email.trim().toLowerCase());
      setPhase('sent');
    } catch {
      showToast('Unable to reach the server. Please check your connection.');
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
            {phase === 'form' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Reset Password</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px', fontSize: '14px' }}>
                  Enter your email address and we'll send you a link to reset your password.
                </p>
                <form onSubmit={handleSubmit}>
                  <div className="form-group">
                    <label htmlFor="resetEmail">Email Address</label>
                    <input
                      type="email"
                      id="resetEmail"
                      className="form-control"
                      required
                      autoFocus
                      autoComplete="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value.replace(/\s/g, '')); setEmailError(''); }}
                      placeholder="you@example.com"
                    />
                    {emailError && (
                      <div className="field-error" style={{ marginTop: '4px' }}>{emailError}</div>
                    )}
                  </div>
                  <Turnstile
                    onToken={setTurnstileToken}
                    onExpire={() => setTurnstileToken(null)}
                    onError={() => setTurnstileToken(null)}
                    resetRef={resetRef}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center' }}
                    disabled={submitting || !turnstileToken}
                  >
                    {submitting ? 'Sending...' : 'Continue'}
                  </button>
                </form>
              </>
            )}

            {phase === 'sent' && (
              <>
                <h2 style={{ marginBottom: '8px', textAlign: 'center' }}>Check Your Email</h2>
                <p style={{ textAlign: 'center', color: '#555', marginBottom: '20px', lineHeight: '1.6' }}>
                  If <strong>{sentEmail}</strong> is associated with an account, we've sent a link to reset your password.
                </p>
                <p style={{ textAlign: 'center', color: '#888', fontSize: '13px', marginBottom: '20px' }}>
                  Didn't receive an email? Check your spam folder or try again.
                </p>
                <Link
                  to="/login"
                  className="btn btn-primary"
                  style={{ display: 'block', width: '100%', textAlign: 'center', justifyContent: 'center', textDecoration: 'none' }}
                >
                  Return to sign in
                </Link>
              </>
            )}
          </div>
          {phase === 'form' && (
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
