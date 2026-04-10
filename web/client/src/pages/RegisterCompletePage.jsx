import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import { useToast } from '../context/ToastContext';
import { apiPost, apiGet } from '../api';
import Header from '../components/Header';
import Turnstile from '../components/Turnstile';
import PasswordRules, { checkPasswordComplexity } from '../components/PasswordRules';

export default function RegisterCompletePage() {
  const { user, refresh } = useAuth();
  const { siteName, turnstileSiteKey } = useSite();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const email = searchParams.get('email') || '';
  const token = searchParams.get('token') || '';

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);
  const resetRef = useRef(null);

  // Validation states
  const [errors, setErrors] = useState({});
  const [validity, setValidity] = useState({
    username: false,
    displayName: false,
    password: false,
    confirmPassword: false,
  });

  // Page state
  const [pageError, setPageError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user) navigate('/profile', { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    document.title = `Complete Registration - ${siteName}`;
  }, [siteName]);

  // Validate token on page load
  useEffect(() => {
    if (!email || !token) {
      setPageError('Missing email or verification token.');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { data, ok } = await apiGet(`/api/register/validate-token?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`);
        if (!ok) {
          setPageError(data?.message || 'Invalid or expired registration link.');
        }
      } catch {
        setPageError('Unable to verify registration link.');
      }
      setLoading(false);
    })();
  }, [email, token]);

  // Field helpers
  const setFieldError = (field, msg) => {
    setErrors(prev => ({ ...prev, [field]: msg || undefined }));
  };

  const setFieldValid = (field, valid) => {
    setValidity(prev => ({ ...prev, [field]: valid }));
  };

  // Username: 3-20 chars, letters/digits/dashes/underscores only
  const handleUsernameBlur = () => {
    const val = username.trim();
    if (!val) { setFieldError('username', 'Username is required.'); setFieldValid('username', false); }
    else if (val.length < 3 || val.length > 20) { setFieldError('username', 'Username must be between 3 and 20 characters.'); setFieldValid('username', false); }
    else if (!/^[A-Za-z0-9_-]+$/.test(val)) { setFieldError('username', 'Only letters, digits, dashes, and underscores allowed.'); setFieldValid('username', false); }
    else { setFieldError('username', ''); setFieldValid('username', true); }
  };

  // Display name: 1-30 chars, letters/digits/spaces only
  const handleDisplayNameBlur = () => {
    const val = displayName.trim();
    if (!val) { setFieldError('displayName', 'Display name is required.'); setFieldValid('displayName', false); }
    else if (val.length > 30) { setFieldError('displayName', 'Display name must be 30 characters or fewer.'); setFieldValid('displayName', false); }
    else if (!/^[A-Za-z0-9 ]+$/.test(val)) { setFieldError('displayName', 'Only letters, digits, and spaces allowed.'); setFieldValid('displayName', false); }
    else { setFieldError('displayName', ''); setFieldValid('displayName', true); }
  };

  // Password
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

  // Confirm password
  const handleConfirmBlur = () => {
    if (!confirmPassword) { setFieldError('confirmPassword', 'Please confirm your password.'); setFieldValid('confirmPassword', false); }
    else if (confirmPassword !== password) { setFieldError('confirmPassword', 'Passwords do not match.'); setFieldValid('confirmPassword', false); }
    else { setFieldError('confirmPassword', ''); setFieldValid('confirmPassword', true); }
  };

  // Block spacebar in password fields
  const blockSpace = (e) => { if (e.key === ' ') e.preventDefault(); };

  const allValid = validity.username && validity.displayName && validity.password && validity.confirmPassword;
  const registerEnabled = allValid && (turnstileToken || !turnstileSiteKey) && !submitting;

  const handleRegister = async () => {
    if (submitting) return;
    setSubmitting(true);

    const tokenToSend = turnstileToken;
    setTurnstileToken(null);

    let gotError = false;

    try {
      const { data, status, ok } = await apiPost('/api/register/complete', {
        email,
        token,
        username: username.trim(),
        displayName: displayName.trim(),
        password,
        confirmPassword,
        turnstileToken: tokenToSend,
      });

      if (ok && data) {
        await refresh();
        navigate(data.redirectTo || '/profile', { replace: true });
        return;
      }

      gotError = true;

      if (status === 429) {
        showToast(data?.message || 'Too many requests. Please wait a moment and try again.');
      } else if (status === 403) {
        showToast(data?.message || 'Registration is currently closed.');
      } else if (status === 422 && data?.errors) {
        for (const [key, msg] of Object.entries(data.errors)) {
          if (key === '_general' || key === 'turnstile') {
            showToast(msg);
          } else {
            setFieldError(key, msg);
            setFieldValid(key, false);
          }
        }
      } else {
        showToast(data?.message || 'An error occurred. Please try again.');
      }
    } catch {
      gotError = true;
      showToast('Unable to reach the server. Please check your connection.');
    }

    if (gotError) resetRef.current?.();
    setSubmitting(false);
  };

  if (loading) {
    return (
      <>
        <Header hasSidebar={false} />
        <main className="container">
          <div className="login-page">
            <div className="card login-card" style={{ textAlign: 'center', padding: '40px' }}>
              <div className="spinner" style={{ margin: '0 auto' }}></div>
            </div>
          </div>
        </main>
      </>
    );
  }

  if (pageError) {
    return (
      <>
        <Header hasSidebar={false} />
        <main className="container">
          <div className="login-page">
            <div className="card login-card" style={{ textAlign: 'center' }}>
              <h2 style={{ marginBottom: '16px' }}>Registration Error</h2>
              <p style={{ color: '#dc3545', marginBottom: '20px' }}>{pageError}</p>
              <a href="/register" className="btn btn-primary" style={{ display: 'inline-block' }}>Start Over</a>
            </div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <Header hasSidebar={false} />
      <main className="container">
        <div className="login-page">
          <div className="card login-card">
            <h2 style={{ marginBottom: '20px', textAlign: 'center' }}>Complete Registration</h2>

            <div className="form-group">
              <label>Email Address</label>
              <input type="email" className="form-control" value={email} disabled style={{ background: '#e9ecef', color: '#6c757d' }} />
            </div>

            <div className="form-group">
              <label htmlFor="regUsername">Username</label>
              <input
                type="text"
                id="regUsername"
                className={`form-control${errors.username ? ' input-error' : ''}`}
                value={username}
                onChange={(e) => { const v = e.target.value; setUsername(v); setFieldError('username', ''); setFieldValid('username', v.trim().length >= 3 && v.trim().length <= 20 && /^[A-Za-z0-9_-]+$/.test(v.trim())); }}
                onBlur={handleUsernameBlur}
                autoFocus
              />
              {errors.username && <span className="field-error">{errors.username}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="regDisplayName">Display Name</label>
              <input
                type="text"
                id="regDisplayName"
                className={`form-control${errors.displayName ? ' input-error' : ''}`}
                value={displayName}
                onChange={(e) => { const v = e.target.value; setDisplayName(v); setFieldError('displayName', ''); setFieldValid('displayName', v.trim().length > 0 && v.trim().length <= 30 && /^[A-Za-z0-9 ]*$/.test(v)); }}
                onBlur={handleDisplayNameBlur}
              />
              {errors.displayName && <span className="field-error">{errors.displayName}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="regPassword">Password</label>
              <input
                type="password"
                id="regPassword"
                className={`form-control${errors.password ? ' input-error' : ''}`}
                value={password}
                onChange={(e) => { const v = e.target.value; setPassword(v); setFieldError('password', ''); const { error } = checkPasswordComplexity(v); setFieldValid('password', !error); }}
                onBlur={handlePasswordBlur}
                onKeyDown={blockSpace}
              />
              <PasswordRules password={password} />
            </div>

            <div className="form-group">
              <label htmlFor="regConfirmPassword">Confirm Password</label>
              <input
                type="password"
                id="regConfirmPassword"
                className={`form-control${errors.confirmPassword ? ' input-error' : ''}`}
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setFieldError('confirmPassword', ''); setFieldValid('confirmPassword', e.target.value.length > 0 && e.target.value === password); }}
                onBlur={handleConfirmBlur}
                onKeyDown={blockSpace}
              />
              {errors.confirmPassword && <span className="field-error">{errors.confirmPassword}</span>}
            </div>

            <Turnstile
              onToken={setTurnstileToken}
              onExpire={() => setTurnstileToken(null)}
              onError={() => setTurnstileToken(null)}
              resetRef={resetRef}
            />

            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              disabled={!registerEnabled}
              onClick={handleRegister}
            >
              {submitting ? 'Registering...' : 'Register'}
            </button>
          </div>
        </div>
      </main>
    </>
  );
}
