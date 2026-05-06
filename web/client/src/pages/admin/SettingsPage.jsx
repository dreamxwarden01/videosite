import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import LoadingSpinner from '../../components/LoadingSpinner';
import ProfileEditModal from '../../components/ProfileEditModal';

export default function SettingsPage() {
  // turnstileSiteKey is pulled in to drive the disabled state of the
  // Turnstile-at-Worker toggle: when origin Turnstile isn't configured at
  // all (env vars missing → /api/settings/public returns null), the toggle
  // is moot and we grey it out with an inline note.
  const { siteName, turnstileSiteKey } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // General settings
  const [siteName_, setSiteName] = useState('');
  const [siteProtocol, setSiteProtocol] = useState('https');
  const [siteHostname, setSiteHostname] = useState('');
  const [sessionInactivityDays, setSessionInactivityDays] = useState('3');
  const [sessionMaxDays, setSessionMaxDays] = useState('15');

  // Registration
  const [enableRegistration, setEnableRegistration] = useState(false);
  const [requireInvitationCode, setRequireInvitationCode] = useState(true);
  const [registrationTokenValidity, setRegistrationTokenValidity] = useState('30');
  const [registrationDefaultRole, setRegistrationDefaultRole] = useState('2');
  const [roles, setRoles] = useState([]);

  // R2 public domain (read-only, from env, used by HMAC WAF rule)
  const [r2PublicDomain, setR2PublicDomain] = useState('');

  // HMAC
  const [hmacEnabled, setHmacEnabled] = useState(false);
  const [hmacHasKey, setHmacHasKey] = useState(false);
  const [hmacTokenValidity, setHmacTokenValidity] = useState('600');
  const [hmacSaving, setHmacSaving] = useState(false);
  const [generatedHmacKey, setGeneratedHmacKey] = useState(null);
  const [hmacKeyCopyLabel, setHmacKeyCopyLabel] = useState('Copy');
  const [hmacRuleCopyLabel, setHmacRuleCopyLabel] = useState('click to copy');
  const [hmacInitMode, setHmacInitMode] = useState(false);

  // Turnstile-at-Worker (sister section under the same Cloudflare card)
  const [workerTurnstileEnabled, setWorkerTurnstileEnabled] = useState(false);

  // Worker Keys
  const [workerKeys, setWorkerKeys] = useState([]);
  const [workerLabel, setWorkerLabel] = useState('');
  const [generatingKey, setGeneratingKey] = useState(false);

  // Validation & dirty tracking
  const [errors, setErrors] = useState({});
  const originalValues = useRef({});

  // Worker key modal
  const [newWorkerKey, setNewWorkerKey] = useState(null);
  const [wkKeyIdCopyLabel, setWkKeyIdCopyLabel] = useState('Copy');
  const [wkSecretCopyLabel, setWkSecretCopyLabel] = useState('Copy');

  // Transcoding profiles
  const [transcodingProfiles, setTranscodingProfiles] = useState([]);
  const [audioBitrateKbps, setAudioBitrateKbps] = useState('192');
  const [audioNormTarget, setAudioNormTarget] = useState('-20');
  const [audioNormPeak, setAudioNormPeak] = useState('-2');
  const [audioNormMaxGain, setAudioNormMaxGain] = useState('20');
  const [savingTranscoding, setSavingTranscoding] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editingProfileIdx, setEditingProfileIdx] = useState(null);
  const originalTranscoding = useRef({});
  const [transcodingErrors, setTranscodingErrors] = useState({});
  const [transcodingTouched, setTranscodingTouched] = useState({});

  useEffect(() => {
    if (!siteName) return;
    document.title = `Site Settings - ${siteName}`;
  }, [siteName]);

  const fetchSettings = useCallback(async () => {
    try {
      const { data, ok } = await mfaPageFetch('/api/admin/settings');
      if (ok && data) {
        const s = data.settings || {};
        setSiteName(s.site_name || 'VideoSite');
        setSiteProtocol(s.site_protocol || 'https');
        setSiteHostname(s.site_hostname || '');
        setSessionInactivityDays(s.session_inactivity_days || '3');
        setSessionMaxDays(s.session_max_days || '15');
        setEnableRegistration(s.enable_registration === 'true');
        setRequireInvitationCode(s.require_invitation_code !== 'false');
        setRegistrationTokenValidity(s.emailed_link_validity_minutes || '30');
        setRegistrationDefaultRole(s.registration_default_role || '2');
        setR2PublicDomain(data.r2PublicDomain || '');
        setHmacHasKey(data.hmacKeyConfigured || false);
        setHmacEnabled(s.hmac_enabled !== undefined ? s.hmac_enabled === 'true' : (data.hmacKeyConfigured || false));
        setHmacTokenValidity(s.hmac_token_validity || '600');
        setWorkerTurnstileEnabled(s.cloudflare_turnstile_worker_gate === 'true');
        setWorkerKeys(data.workerKeys || []);
        setRoles(data.roles || []);
        originalValues.current = {
          site_name: s.site_name || 'VideoSite',
          site_protocol: s.site_protocol || 'https',
          site_hostname: s.site_hostname || '',
          session_inactivity_days: s.session_inactivity_days || '3',
          session_max_days: s.session_max_days || '15',
          enable_registration: s.enable_registration === 'true',
          require_invitation_code: s.require_invitation_code !== 'false',
          emailed_link_validity_minutes: s.emailed_link_validity_minutes || '30',
          registration_default_role: s.registration_default_role || '2',
        };
        setErrors({});

        // Transcoding profiles
        setTranscodingProfiles(data.transcodingProfiles || []);
        const an = data.audioNormalization || {};
        setAudioNormTarget(an.target || '-20');
        setAudioNormPeak(an.peak || '-2');
        setAudioNormMaxGain(an.maxGain || '20');
        const abk = String(data.audioBitrateKbps ?? '192');
        setAudioBitrateKbps(abk);
        originalTranscoding.current = {
          profiles: JSON.stringify(data.transcodingProfiles || []),
          target: an.target || '-20',
          peak: an.peak || '-2',
          maxGain: an.maxGain || '20',
          audioBitrateKbps: abk
        };
        setTranscodingErrors({});
        setTranscodingTouched({});
      }
    } catch {
      showToast('Failed to load settings.');
    } finally {
      setLoading(false);
    }
  }, [mfaPageFetch]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings, mfaVerifiedKey]);

  // --- Client-side validation effects ---
  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      if (!siteName_.trim()) {
        next.site_name = 'Site name is required';
      } else {
        delete next.site_name;
      }
      return next;
    });
  }, [siteName_]);

  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      const trimmed = siteHostname.trim().replace(/^https?:\/\//, '').split('/')[0];
      if (!siteHostname.trim()) {
        next.site_hostname = 'Hostname is required';
      } else if (/\s/.test(trimmed)) {
        next.site_hostname = 'Hostname cannot contain spaces';
      } else {
        delete next.site_hostname;
      }
      return next;
    });
  }, [siteHostname]);

  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      // Session inactivity days
      if (sessionInactivityDays === '') {
        next.session_inactivity_days = 'This field is required';
      } else {
        const v = Number(sessionInactivityDays);
        if (!Number.isInteger(v) || v < 1 || v > 365) {
          next.session_inactivity_days = 'Must be between 1 and 365';
        } else {
          delete next.session_inactivity_days;
        }
      }
      // Session max days
      if (sessionMaxDays === '') {
        next.session_max_days = 'This field is required';
      } else {
        const v = Number(sessionMaxDays);
        if (!Number.isInteger(v) || v < 1 || v > 365) {
          next.session_max_days = 'Must be between 1 and 365';
        } else {
          delete next.session_max_days;
        }
      }
      // Cross-field: inactivity <= max
      if (!next.session_inactivity_days && !next.session_max_days && sessionInactivityDays !== '' && sessionMaxDays !== '') {
        if (Number(sessionInactivityDays) > Number(sessionMaxDays)) {
          next.session_inactivity_days = 'Inactivity timeout cannot exceed max lifetime';
        }
      }
      return next;
    });
  }, [sessionInactivityDays, sessionMaxDays]);

  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      if (registrationTokenValidity === '') {
        next.emailed_link_validity_minutes = 'This field is required';
      } else {
        const v = Number(registrationTokenValidity);
        if (!Number.isInteger(v) || v < 5 || v > 10080) {
          next.emailed_link_validity_minutes = 'Must be between 5 and 10080';
        } else {
          delete next.emailed_link_validity_minutes;
        }
      }
      return next;
    });
  }, [registrationTokenValidity]);

  // --- Role dropdown filtering (must be before early returns) ---
  const filteredRoles = useMemo(() => {
    const userLevel = user?.permission_level ?? 0;
    const origRoleId = originalValues.current.registration_default_role;
    return roles.filter(r =>
      r.permission_level > userLevel || String(r.role_id) === String(origRoleId)
    );
  }, [roles, user?.permission_level]);

  if (!user?.permissions?.manageSite) {
    return <p className="text-muted">Permission denied.</p>;
  }

  if (loading) return <LoadingSpinner />;

  // --- Digit-only input handler ---
  const handleDigitOnly = (e) => {
    if (e.ctrlKey || e.metaKey || ['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    if (!/^\d$/.test(e.key)) e.preventDefault();
  };
  const handleDigitPaste = (setter) => (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const digits = text.replace(/\D/g, '');
    if (digits) setter(digits);
  };

  // --- Dirty tracking ---
  const orig = originalValues.current;
  const isDirty = siteName_ !== orig.site_name
    || siteProtocol !== orig.site_protocol
    || siteHostname !== orig.site_hostname
    || sessionInactivityDays !== orig.session_inactivity_days
    || sessionMaxDays !== orig.session_max_days
    || enableRegistration !== orig.enable_registration
    || requireInvitationCode !== orig.require_invitation_code
    || registrationTokenValidity !== orig.emailed_link_validity_minutes
    || registrationDefaultRole !== orig.registration_default_role;
  const hasErrors = Object.values(errors).some(Boolean);

  // --- Save general settings (partial PUT) ---
  const handleSaveGeneral = async (e) => {
    e.preventDefault();
    if (hasErrors) return;
    setSaving(true);
    try {
      const body = {};
      if (siteName_ !== orig.site_name) body.site_name = siteName_;
      if (siteProtocol !== orig.site_protocol) body.site_protocol = siteProtocol;
      if (siteHostname !== orig.site_hostname) body.site_hostname = siteHostname;
      if (sessionInactivityDays !== orig.session_inactivity_days) body.session_inactivity_days = sessionInactivityDays;
      if (sessionMaxDays !== orig.session_max_days) body.session_max_days = sessionMaxDays;
      if (enableRegistration !== orig.enable_registration) body.enable_registration = enableRegistration;
      if (requireInvitationCode !== orig.require_invitation_code) body.require_invitation_code = requireInvitationCode;
      if (registrationTokenValidity !== orig.emailed_link_validity_minutes) body.emailed_link_validity_minutes = registrationTokenValidity;
      if (registrationDefaultRole !== orig.registration_default_role) body.registration_default_role = registrationDefaultRole;

      if (Object.keys(body).length === 0) return;

      const { ok, data, status } = await mfaFetch('/api/admin/settings', { method: 'PUT', body });
      if (ok) {
        showToast('Settings saved.', 'success');
        // Update original values to match saved state
        originalValues.current = {
          site_name: siteName_,
          site_protocol: siteProtocol,
          site_hostname: siteHostname,
          session_inactivity_days: sessionInactivityDays,
          session_max_days: sessionMaxDays,
          enable_registration: enableRegistration,
          require_invitation_code: requireInvitationCode,
          emailed_link_validity_minutes: registrationTokenValidity,
          registration_default_role: registrationDefaultRole,
        };
        setErrors({});
      } else if (status === 422 && data?.errors) {
        setErrors(data.errors);
        showToast('Please fix the errors below.');
      } else {
        showToast(data?.error || 'Failed to save settings.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSaving(false);
    }
  };

  // HMAC toggle
  const handleToggleHmac = async () => {
    const newEnabled = !hmacEnabled;
    if (newEnabled) {
      if (!await confirm('You must have an active Cloudflare Pro, Business, or Enterprise plan on your domain to use HMAC validation with custom WAF rules. Continue?')) return;
      if (!hmacHasKey) {
        // No key yet — generate one first, modal OK will enable
        await doGenerateHmac(true);
        return;
      }
    } else {
      if (!await confirm('You must disable the related HMAC validation rule from your Cloudflare WAF rules before turning this off, otherwise all videos will be inaccessible. Continue?')) return;
    }
    try {
      const { ok, data } = await mfaFetch('/api/admin/settings/hmac/toggle', { method: 'PUT', body: { hmac_enabled: newEnabled } });
      if (ok) {
        setHmacEnabled(newEnabled);
      } else {
        showToast(data?.error || 'Failed to toggle HMAC validation.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  // HMAC generate — isInit=true means first-time setup (auto-enable on modal close)
  const doGenerateHmac = async (isInit = false) => {
    if (!isInit && hmacHasKey) {
      if (!await confirm('Generate a new HMAC secret key? This will invalidate all existing playback tokens.')) return;
    }
    try {
      const { ok, data } = await mfaFetch('/api/admin/settings/hmac/generate', { method: 'POST' });
      if (ok && data?.secret) {
        setGeneratedHmacKey(data.secret);
        setHmacKeyCopyLabel('Copy');
        setHmacRuleCopyLabel('click to copy');
        setHmacHasKey(true);
        setHmacInitMode(isInit);
      } else {
        showToast(data?.error || 'Failed to generate HMAC key.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleGenerateHmac = () => doGenerateHmac(false);

  const handleCloseHmacModal = async () => {
    if (hmacInitMode) {
      // Auto-enable after first initialization
      try {
        const { ok, data } = await mfaFetch('/api/admin/settings/hmac/toggle', { method: 'PUT', body: { hmac_enabled: true } });
        if (ok) {
          setHmacEnabled(true);
        } else {
          showToast(data?.error || 'Failed to enable HMAC validation.');
        }
      } catch (err) {
        showToast(err.message);
      }
    }
    setGeneratedHmacKey(null);
    setHmacInitMode(false);
  };

  const handleCopyHmacKey = () => {
    if (!generatedHmacKey) return;
    navigator.clipboard.writeText(generatedHmacKey).then(() => {
      setHmacKeyCopyLabel('Copied!');
      setTimeout(() => setHmacKeyCopyLabel('Copy'), 1500);
    }).catch(() => {});
  };

  const buildWafRule = (secret) => {
    const host = r2PublicDomain || 'your-cdn-domain.com';
    const validity = hmacTokenValidity || '600';
    return `(http.host eq "${host}") and not (\n    starts_with(http.request.uri.query, "verify=") and\n    is_timed_hmac_valid_v0(\n        "${secret}",\n        concat(\n            substring(http.request.uri.path, 0, 79),\n            "?",\n            substring(http.request.uri.query, 7, 200)\n        ),\n        ${validity},\n        http.request.timestamp.sec,\n        1\n    )\n)`;
  };

  const handleCopyWafRule = () => {
    if (!generatedHmacKey) return;
    navigator.clipboard.writeText(buildWafRule(generatedHmacKey)).then(() => {
      setHmacRuleCopyLabel('copied!');
      setTimeout(() => setHmacRuleCopyLabel('click to copy'), 1500);
    }).catch(() => {});
  };

  const handleSaveHmacValidity = async () => {
    setHmacSaving(true);
    try {
      const { ok, data } = await mfaFetch('/api/admin/settings/hmac/validity', { method: 'PUT', body: { hmac_token_validity: hmacTokenValidity } });
      if (ok) {
        showToast('Token validity updated.', 'success');
      } else {
        showToast(data?.error || 'Failed to save token validity.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setHmacSaving(false);
    }
  };

  // Turnstile-at-Worker toggle. Coordination rule for both directions:
  // never end up in (toggle off + Worker deployed) — the Worker strips the
  // token, the origin still expects to see one, so every gated request
  // 403s. So the safe order is:
  //   - Enabling : toggle ON first, then deploy the Worker.
  //   - Disabling: undeploy the Worker first, then toggle OFF.
  // The intermediate state (toggle on + Worker not yet in front) is fine
  // functionally — it just means Turnstile isn't actually checked during
  // that brief window.
  const handleToggleWorkerTurnstile = async () => {
    const newEnabled = !workerTurnstileEnabled;
    if (newEnabled) {
      if (!await confirm('Order: enable this first, then deploy the cloudflare/workers/turnstile-gate Worker (with TURNSTILE_SECRET_KEY set on the Cloudflare dashboard). Origin will skip Turnstile verification on the five sign-in/registration endpoints. Continue?')) return;
    } else {
      if (!await confirm('Order: undeploy the cloudflare/workers/turnstile-gate Worker (or remove its routes) first, then disable this. Disabling while the Worker is still in front will break every gated request because the Worker strips the token, but origin will start expecting one again. Continue?')) return;
    }
    try {
      const { ok, data } = await mfaFetch('/api/admin/settings/turnstile-gate/toggle', { method: 'PUT', body: { enabled: newEnabled } });
      if (ok) {
        setWorkerTurnstileEnabled(newEnabled);
      } else {
        showToast(data?.error || 'Failed to toggle Turnstile worker gate.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  // Worker keys
  const handleGenerateWorkerKey = async (e) => {
    e.preventDefault();
    setGeneratingKey(true);
    try {
      const { ok, data } = await mfaFetch('/api/admin/settings/worker-keys', { method: 'POST', body: { label: workerLabel } });
      if (!ok) throw new Error(data?.error || 'Failed to generate worker key');

      setNewWorkerKey({ keyId: data.keyId, secret: data.secret });
      setWkKeyIdCopyLabel('Copy');
      setWkSecretCopyLabel('Copy');
      setWorkerLabel('');
    } catch (err) {
      showToast(err.message);
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleCloseWorkerKeyModal = () => {
    setNewWorkerKey(null);
    fetchSettings();
  };

  const handleRevokeWorkerKey = async (keyId) => {
    if (!await confirm('Revoke this worker key?')) return;
    try {
      const { ok, data } = await mfaFetch(`/api/admin/settings/worker-keys/${keyId}/revoke`, { method: 'PUT' });
      if (ok) {
        showToast('Worker key revoked.', 'success');
        fetchSettings();
      } else {
        showToast(data?.error || 'Failed to revoke worker key.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleDeleteWorkerKey = async (keyId) => {
    if (!await confirm('Permanently delete this worker key?')) return;
    try {
      const { ok, data } = await mfaFetch(`/api/admin/settings/worker-keys/${keyId}`, { method: 'DELETE' });
      if (ok) {
        showToast('Worker key deleted.', 'success');
        fetchSettings();
      } else {
        showToast(data?.error || 'Failed to delete worker key.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const copyField = (value, setLabel) => {
    navigator.clipboard.writeText(value).then(() => {
      setLabel('Copied!');
      setTimeout(() => setLabel('Copy'), 1500);
    }).catch(() => {});
  };

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <h1 className="mb-3">Site Settings</h1>

      {/* General + Registration + R2 */}
      <div className="card">
        <div className="card-header">
          <h2>General</h2>
        </div>
        <form onSubmit={handleSaveGeneral}>
            <div style={{ maxWidth: '600px' }}>
              <div className="form-group">
                <label htmlFor="site_name">Site Name</label>
                <input type="text" id="site_name" className={`form-control${errors.site_name ? ' input-error' : ''}`}
                  value={siteName_} onChange={e => setSiteName(e.target.value)}
                  style={{ maxWidth: '300px' }} />
                {errors.site_name && <span className="field-error">{errors.site_name}</span>}
              </div>
              <div className="form-group">
                <label htmlFor="site_hostname">Site Hostname</label>
                <div style={{ display: 'flex', gap: 0, maxWidth: '400px' }}>
                  <select id="site_protocol" className="form-control"
                    style={{ width: '100px', borderRadius: '6px 0 0 6px', flexShrink: 0 }}
                    value={siteProtocol} onChange={e => setSiteProtocol(e.target.value)}>
                    <option value="https">https://</option>
                    <option value="http">http://</option>
                  </select>
                  <input type="text" id="site_hostname" className={`form-control${errors.site_hostname ? ' input-error' : ''}`}
                    style={{ borderRadius: '0 6px 6px 0', borderLeft: 'none' }}
                    value={siteHostname}
                    onChange={e => setSiteHostname(e.target.value)}
                    onBlur={e => setSiteHostname(e.target.value.trim().replace(/^https?:\/\//, '').split('/')[0])}
                    placeholder="stream.yourdomain.com" />
                </div>
                {errors.site_hostname && <span className="field-error">{errors.site_hostname}</span>}
              </div>
              <div className="form-group">
                <label htmlFor="session_inactivity_days">Session Inactivity Timeout (days)</label>
                <input type="text" inputMode="numeric" id="session_inactivity_days"
                  className={`form-control${errors.session_inactivity_days ? ' input-error' : ''}`}
                  value={sessionInactivityDays} onChange={e => setSessionInactivityDays(e.target.value)}
                  onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setSessionInactivityDays)}
                  style={{ maxWidth: '200px' }} />
                {errors.session_inactivity_days && <span className="field-error">{errors.session_inactivity_days}</span>}
              </div>
              <div className="form-group">
                <label htmlFor="session_max_days">Session Max Lifetime (days)</label>
                <input type="text" inputMode="numeric" id="session_max_days"
                  className={`form-control${errors.session_max_days ? ' input-error' : ''}`}
                  value={sessionMaxDays} onChange={e => setSessionMaxDays(e.target.value)}
                  onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setSessionMaxDays)}
                  style={{ maxWidth: '200px' }} />
                {errors.session_max_days && <span className="field-error">{errors.session_max_days}</span>}
              </div>
              <div className="form-group">
                <label htmlFor="emailed_link_validity_minutes">Emailed Link Validity (minutes)</label>
                <input type="text" inputMode="numeric" id="emailed_link_validity_minutes"
                  className={`form-control${errors.emailed_link_validity_minutes ? ' input-error' : ''}`}
                  value={registrationTokenValidity} onChange={e => setRegistrationTokenValidity(e.target.value)}
                  onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setRegistrationTokenValidity)}
                  style={{ maxWidth: '200px' }} />
                {errors.emailed_link_validity_minutes && <span className="field-error">{errors.emailed_link_validity_minutes}</span>}
              </div>
              <small className="text-muted" style={{ display: 'block', marginTop: '-8px', marginBottom: '12px' }}>Applies to registration and password reset links</small>

              <h3 style={{ margin: '20px 0 12px' }}>Registration</h3>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={enableRegistration}
                    onChange={e => setEnableRegistration(e.target.checked)} />
                  Enable Registration
                </label>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={requireInvitationCode}
                    onChange={e => setRequireInvitationCode(e.target.checked)} />
                  Require Invitation Code
                </label>
              </div>
              <div className="form-group">
                <label htmlFor="registration_default_role">Default Role for New Users</label>
                <select id="registration_default_role" className={`form-control${errors.registration_default_role ? ' input-error' : ''}`}
                  style={{ maxWidth: '200px' }}
                  value={registrationDefaultRole} onChange={e => setRegistrationDefaultRole(e.target.value)}>
                  {filteredRoles.map(r => {
                    const isProtected = r.permission_level <= (user?.permission_level ?? 0);
                    return (
                      <option key={r.role_id} value={r.role_id}>
                        {r.role_name}{isProtected ? ' (current)' : ''}
                      </option>
                    );
                  })}
                </select>
                {errors.registration_default_role && <span className="field-error">{errors.registration_default_role}</span>}
              </div>
            </div>

          <button type="submit" className="btn btn-primary" disabled={saving || !isDirty || hasErrors}
            style={{ marginTop: '8px', opacity: (!isDirty || hasErrors) && !saving ? 0.5 : 1 }}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </form>
      </div>

      {/* Transcoding Profiles */}
      <div className="card mt-3">
        <div className="card-header">
          <h2>Transcoding Profiles</h2>
        </div>
        <div>
          <p className="text-muted" style={{ marginBottom: '16px' }}>
            Default encoding profiles for all courses. Individual courses can override these.
          </p>

          <div className="table-wrap" style={{ marginBottom: '16px' }}>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Resolution</th>
                  <th>Video Bitrate</th>
                  <th>Max FPS</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {transcodingProfiles.map((p, idx) => (
                  <tr key={p.profile_id || idx}>
                    <td>{p.name}</td>
                    <td>{p.width}x{p.height}</td>
                    <td>{p.video_bitrate_kbps} kbps</td>
                    <td>{p.fps_limit} fps</td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => { setEditingProfileIdx(idx); setShowProfileModal(true); }}>Edit</button>
                      <button className="btn btn-danger btn-sm" style={{ marginLeft: '4px' }} onClick={async () => {
                        if (!await confirm('Delete this profile?')) return;
                        setTranscodingProfiles(prev => prev.filter((_, i) => i !== idx));
                      }}>Delete</button>
                    </td>
                  </tr>
                ))}
                {transcodingProfiles.length === 0 && (
                  <tr><td colSpan="5" className="text-muted" style={{ textAlign: 'center', padding: '16px' }}>No profiles configured</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <button className="btn btn-secondary" style={{ marginBottom: '20px' }}
            onClick={() => { setEditingProfileIdx(null); setShowProfileModal(true); }}>
            Add Profile
          </button>

          <div className="form-group" style={{ maxWidth: '400px' }}>
            <label htmlFor="audioBitrateKbps">Audio Bitrate (kbps)</label>
            <input
              id="audioBitrateKbps"
              type="text"
              inputMode="numeric"
              className={`form-control${transcodingTouched.audioBitrateKbps && transcodingErrors.audioBitrateKbps ? ' input-error' : ''}`}
              value={audioBitrateKbps}
              onChange={e => setAudioBitrateKbps(e.target.value.replace(/\D/g, ''))}
              onKeyDown={handleDigitOnly}
              onPaste={handleDigitPaste(setAudioBitrateKbps)}
              onBlur={() => {
                setTranscodingTouched(t => ({ ...t, audioBitrateKbps: true }));
                const v = parseInt(audioBitrateKbps, 10);
                setTranscodingErrors(e => {
                  const n = { ...e };
                  if (!Number.isInteger(v) || v < 128 || v > 320) n.audioBitrateKbps = 'Must be an integer between 128 and 320';
                  else delete n.audioBitrateKbps;
                  return n;
                });
              }}
              style={{ maxWidth: '200px' }}
            />
            {transcodingTouched.audioBitrateKbps && transcodingErrors.audioBitrateKbps && (
              <span className="field-error">{transcodingErrors.audioBitrateKbps}</span>
            )}
            <small className="text-muted" style={{ display: 'block', marginTop: '4px' }}>
              Site-wide AAC-LC bitrate used for all transcoded videos. Range 128–320.
            </small>
          </div>

          <h3 style={{ marginBottom: '12px' }}>Audio Normalization Defaults</h3>
          <p className="text-muted text-sm" style={{ marginBottom: '12px' }}>
            Audio normalization is enabled by default for new courses. Individual courses can disable it.
          </p>

          <div style={{ maxWidth: '400px' }}>
            <div className="form-group">
              <label>Target Loudness (LUFS)</label>
              <input type="text" inputMode="numeric" className={`form-control${transcodingTouched.target && transcodingErrors.target ? ' input-error' : ''}`}
                value={audioNormTarget}
                onChange={e => { setAudioNormTarget(e.target.value.replace(/[^0-9.-]/g, '')); }}
                onBlur={() => {
                  setTranscodingTouched(t => ({ ...t, target: true }));
                  const v = parseFloat(audioNormTarget);
                  setTranscodingErrors(e => {
                    const n = { ...e };
                    if (isNaN(v) || v < -50 || v > 0) n.target = 'Must be -50 to 0';
                    else delete n.target;
                    return n;
                  });
                }}
              />
              {transcodingTouched.target && transcodingErrors.target && <span className="field-error">{transcodingErrors.target}</span>}
            </div>
            <div className="form-group">
              <label>True Peak Ceiling (dBFS)</label>
              <input type="text" inputMode="numeric" className={`form-control${transcodingTouched.peak && transcodingErrors.peak ? ' input-error' : ''}`}
                value={audioNormPeak}
                onChange={e => { setAudioNormPeak(e.target.value.replace(/[^0-9.-]/g, '')); }}
                onBlur={() => {
                  setTranscodingTouched(t => ({ ...t, peak: true }));
                  const v = parseFloat(audioNormPeak);
                  setTranscodingErrors(e => {
                    const n = { ...e };
                    if (isNaN(v) || v < -20 || v > 0) n.peak = 'Must be -20 to 0';
                    else delete n.peak;
                    return n;
                  });
                }}
              />
              {transcodingTouched.peak && transcodingErrors.peak && <span className="field-error">{transcodingErrors.peak}</span>}
            </div>
            <div className="form-group">
              <label>Max Upward Gain (dB)</label>
              <input type="text" inputMode="numeric" className={`form-control${transcodingTouched.maxGain && transcodingErrors.maxGain ? ' input-error' : ''}`}
                value={audioNormMaxGain}
                onChange={e => { setAudioNormMaxGain(e.target.value.replace(/[^0-9.-]/g, '')); }}
                onBlur={() => {
                  setTranscodingTouched(t => ({ ...t, maxGain: true }));
                  const v = parseFloat(audioNormMaxGain);
                  setTranscodingErrors(e => {
                    const n = { ...e };
                    if (isNaN(v) || v < 0 || v > 40) n.maxGain = 'Must be 0 to 40';
                    else delete n.maxGain;
                    return n;
                  });
                }}
              />
              {transcodingTouched.maxGain && transcodingErrors.maxGain && <span className="field-error">{transcodingErrors.maxGain}</span>}
            </div>
          </div>

          <button className="btn btn-primary" style={{ marginTop: '8px' }}
            disabled={savingTranscoding || Object.keys(transcodingErrors).length > 0 || (
              JSON.stringify(transcodingProfiles) === originalTranscoding.current.profiles
              && audioNormTarget === originalTranscoding.current.target
              && audioNormPeak === originalTranscoding.current.peak
              && audioNormMaxGain === originalTranscoding.current.maxGain
              && audioBitrateKbps === originalTranscoding.current.audioBitrateKbps
            )}
            onClick={async () => {
              if (transcodingProfiles.length === 0) { showToast('At least one profile is required.'); return; }
              const abkInt = parseInt(audioBitrateKbps, 10);
              if (!Number.isInteger(abkInt) || abkInt < 128 || abkInt > 320) {
                setTranscodingTouched(t => ({ ...t, audioBitrateKbps: true }));
                setTranscodingErrors(e => ({ ...e, audioBitrateKbps: 'Must be an integer between 128 and 320' }));
                showToast('Please fix the errors below.');
                return;
              }
              setSavingTranscoding(true);
              try {
                const { ok, data } = await mfaFetch('/api/admin/settings/transcoding-profiles', {
                  method: 'PUT',
                  body: {
                    profiles: transcodingProfiles,
                    audioNormalization: { target: audioNormTarget, peak: audioNormPeak, maxGain: audioNormMaxGain },
                    audioBitrateKbps: abkInt
                  }
                });
                if (ok) {
                  showToast('Transcoding settings saved.', 'success');
                  originalTranscoding.current = {
                    profiles: JSON.stringify(transcodingProfiles),
                    target: audioNormTarget, peak: audioNormPeak, maxGain: audioNormMaxGain,
                    audioBitrateKbps: audioBitrateKbps
                  };
                } else {
                  showToast(data?.error || 'Failed to save.');
                }
              } catch (err) { showToast(err.message); }
              finally { setSavingTranscoding(false); }
            }}
          >
            {savingTranscoding ? 'Saving...' : 'Save Transcoding Settings'}
          </button>
        </div>
      </div>

      <ProfileEditModal
        isOpen={showProfileModal}
        profile={editingProfileIdx !== null ? transcodingProfiles[editingProfileIdx] : null}
        onClose={() => { setShowProfileModal(false); setEditingProfileIdx(null); }}
        onSave={(profile) => {
          if (editingProfileIdx !== null) {
            setTranscodingProfiles(prev => prev.map((p, i) => i === editingProfileIdx ? profile : p));
          } else {
            setTranscodingProfiles(prev => [...prev, profile]);
          }
          setShowProfileModal(false);
          setEditingProfileIdx(null);
        }}
      />

      {/* Cloudflare — HMAC playback signing + Turnstile-at-Worker gate */}
      <div className="card mt-3">
        <div className="card-header">
          <h2>Cloudflare</h2>
        </div>
        <div style={{ maxWidth: '600px' }}>
          {/* ── HMAC Validation ─────────────────────────────────────── */}
          <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6b7280', marginTop: 0, marginBottom: '12px' }}>
            HMAC Validation
          </h3>
          <p className="text-muted" style={{ marginBottom: '12px' }}>
            Signs playback URLs with HMAC-SHA256 for Cloudflare WAF token authentication.
          </p>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '14px', fontWeight: 500 }}>
                {hmacEnabled ? 'Enabled' : 'Disabled'}
              </span>
              <div
                role="switch"
                aria-checked={hmacEnabled}
                tabIndex={0}
                onClick={handleToggleHmac}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleToggleHmac(); } }}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  backgroundColor: hmacEnabled ? '#16a34a' : '#d1d5db',
                  position: 'relative', transition: 'background-color 0.2s', cursor: 'pointer',
                }}
              >
                <div style={{
                  width: '18px', height: '18px', borderRadius: '50%', backgroundColor: '#fff',
                  position: 'absolute', top: '3px', left: hmacEnabled ? '23px' : '3px',
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
            </label>
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label>HMAC Secret Key</label>
            <div>
              <button type="button" className="btn btn-primary btn-sm"
                onClick={handleGenerateHmac} disabled={!hmacEnabled}>
                {hmacHasKey ? 'Generate New Key' : 'Initialize Key'}
              </button>
            </div>
            <small className="text-muted">
              {hmacHasKey
                ? 'Generates a new key and shows it once. Changing the key immediately invalidates all active playback sessions.'
                : 'Generate a secret key to get started with HMAC validation.'}
            </small>
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label htmlFor="hmacTokenValidity">Token Validity for Client (seconds)</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input type="number" id="hmacTokenValidity" className="form-control"
                value={hmacTokenValidity} onChange={e => setHmacTokenValidity(e.target.value)}
                min="600" step="1" style={{ flex: 1, maxWidth: '200px' }}
                disabled={!hmacEnabled} />
              <button type="button" className="btn btn-primary btn-sm"
                onClick={handleSaveHmacValidity} disabled={hmacSaving || !hmacEnabled}>
                {hmacSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
            <small className="text-muted">
              Tells the player when to proactively refresh the token (refreshes at half this value).
              Must be &le; the lifetime configured in your Cloudflare WAF rule. Default: 600 seconds.
            </small>
          </div>

          <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid #e5e7eb' }} />

          {/* ── Turnstile Verification at Worker ────────────────────── */}
          <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6b7280', marginTop: 0, marginBottom: '12px' }}>
            Turnstile Verification at Worker
          </h3>
          <p className="text-muted" style={{ marginBottom: '12px' }}>
            Lets a Cloudflare Worker validate Turnstile tokens at the edge instead of the origin.
            The five sign-in/registration endpoints will skip their own siteverify call and trust
            that the Worker has already verified the token.
          </p>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '14px', fontWeight: 500 }}>
                {workerTurnstileEnabled ? 'Enabled' : 'Disabled'}
              </span>
              <div
                role="switch"
                aria-checked={workerTurnstileEnabled}
                aria-disabled={!turnstileSiteKey}
                tabIndex={turnstileSiteKey ? 0 : -1}
                onClick={() => { if (turnstileSiteKey) handleToggleWorkerTurnstile(); }}
                onKeyDown={e => { if (turnstileSiteKey && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleToggleWorkerTurnstile(); } }}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  backgroundColor: workerTurnstileEnabled ? '#16a34a' : '#d1d5db',
                  position: 'relative', transition: 'background-color 0.2s',
                  cursor: turnstileSiteKey ? 'pointer' : 'not-allowed',
                  opacity: turnstileSiteKey ? 1 : 0.5,
                }}
              >
                <div style={{
                  width: '18px', height: '18px', borderRadius: '50%', backgroundColor: '#fff',
                  position: 'absolute', top: '3px', left: workerTurnstileEnabled ? '23px' : '3px',
                  transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
            </label>
          </div>

          <small className="text-muted" style={{ display: 'block', marginTop: '8px' }}>
            Set <code>TURNSTILE_SECRET_KEY</code> on the Cloudflare dashboard for the
            <code> turnstile-gate</code> Worker before deploying. Coordination order: turn this
            <strong> on</strong> <em>before</em> deploying the Worker, and <strong>off</strong>
            <em> after</em> undeploying. (Off + Worker still in front breaks every gated request — the
            Worker strips the token while the origin expects to see one.)
          </small>
          {!turnstileSiteKey && (
            <small className="text-muted" style={{ display: 'block', marginTop: '8px', color: '#b45309' }}>
              Configure <code>TURNSTILE_SITE_KEY</code> and <code>TURNSTILE_SECRET_KEY</code> at the
              origin first — this toggle has no effect while site-wide Turnstile is unconfigured.
            </small>
          )}
        </div>
      </div>

      {/* Worker Keys */}
      <div className="card mt-3">
        <div className="card-header">
          <h2>Worker Access Keys</h2>
        </div>

        <form onSubmit={handleGenerateWorkerKey} className="mb-3" style={{ maxWidth: '400px' }}>
          <div className="form-group">
            <label htmlFor="workerLabel">Label (optional)</label>
            <input type="text" id="workerLabel" className="form-control"
              value={workerLabel} onChange={e => setWorkerLabel(e.target.value)}
              placeholder="e.g. Transcoding Server 1" />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={generatingKey}>
            {generatingKey ? 'Generating...' : 'Generate New Key'}
          </button>
        </form>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Key ID</th>
                <th>Label</th>
                <th>Status</th>
                <th>Last Used</th>
                <th>Created</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {workerKeys.map(wk => (
                <tr key={wk.key_id}>
                  <td><code>{wk.key_id}</code></td>
                  <td>{wk.label || '-'}</td>
                  <td>
                    <span className={`status ${wk.is_active ? 'status-finished' : 'status-error'}`}>
                      {wk.is_active ? 'Active' : 'Revoked'}
                    </span>
                  </td>
                  <td>{wk.last_used_at ? new Date(wk.last_used_at).toLocaleString() : 'Never'}</td>
                  <td>{new Date(wk.created_at).toLocaleDateString()}</td>
                  <td>
                    {wk.is_active ? (
                      <button className="btn btn-danger btn-sm" onClick={() => handleRevokeWorkerKey(wk.key_id)}>Revoke</button>
                    ) : (
                      <button className="btn btn-danger btn-sm" onClick={() => handleDeleteWorkerKey(wk.key_id)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
              {workerKeys.length === 0 && (
                <tr>
                  <td colSpan="6" className="text-muted" style={{ textAlign: 'center' }}>No worker keys</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* HMAC Key Generated Modal */}
      {generatedHmacKey && (
        <div className="content-overlay active" onClick={handleCloseHmacModal}>
          <div className="wk-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '620px' }}>
            <div className="wk-modal-header"><h3>HMAC Secret Key Generated</h3></div>
            <div className="wk-modal-body">
              <div className="wk-field">
                <label>HMAC Secret Key</label>
                <div className="wk-field-row">
                  <input type="text" readOnly value={generatedHmacKey}
                    onClick={e => e.target.select()} style={{ cursor: 'text' }} />
                  <button type="button" className="btn btn-sm" onClick={handleCopyHmacKey}>{hmacKeyCopyLabel}</button>
                </div>
              </div>
              <p className="wk-warning">Save this key now — it won't be shown again.</p>

              <div className="wk-field" style={{ marginTop: '16px' }}>
                <label>Cloudflare WAF Rule Expression</label>
                <textarea readOnly value={buildWafRule(generatedHmacKey)}
                  onClick={e => e.target.select()}
                  style={{ width: '100%', minHeight: '200px', fontFamily: 'monospace', fontSize: '12px', padding: '10px', border: '1px solid #d1d5db', borderRadius: '6px', resize: 'vertical', cursor: 'text', background: '#f9fafb', boxSizing: 'border-box' }} />
                <div style={{ textAlign: 'right', marginTop: '4px' }}>
                  <span onClick={handleCopyWafRule}
                    style={{ color: '#9ca3af', fontSize: '13px', cursor: 'pointer' }}>
                    {hmacRuleCopyLabel}
                  </span>
                </div>
              </div>
              <p className="text-muted" style={{ fontSize: '13px', marginTop: '8px' }}>
                Set the action to <strong>Block</strong> with a 403 response.
              </p>
            </div>
            <div className="wk-modal-footer">
              <button type="button" className="btn btn-primary btn-sm" onClick={handleCloseHmacModal}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* Worker Key Created Modal */}
      {newWorkerKey && (
        <div className="content-overlay active" onClick={handleCloseWorkerKeyModal}>
          <div className="wk-modal" onClick={e => e.stopPropagation()}>
            <div className="wk-modal-header"><h3>Worker Key Created</h3></div>
            <div className="wk-modal-body">
              <div className="wk-field">
                <label>Key ID</label>
                <div className="wk-field-row">
                  <input type="text" readOnly value={newWorkerKey.keyId} />
                  <button type="button" className="btn btn-sm"
                    onClick={() => copyField(newWorkerKey.keyId, setWkKeyIdCopyLabel)}>{wkKeyIdCopyLabel}</button>
                </div>
              </div>
              <div className="wk-field">
                <label>Secret</label>
                <div className="wk-field-row">
                  <input type="text" readOnly value={newWorkerKey.secret} />
                  <button type="button" className="btn btn-sm"
                    onClick={() => copyField(newWorkerKey.secret, setWkSecretCopyLabel)}>{wkSecretCopyLabel}</button>
                </div>
              </div>
              <p className="wk-warning">Save this secret now — it won't be shown again.</p>
            </div>
            <div className="wk-modal-footer">
              <button type="button" className="btn btn-primary btn-sm" onClick={handleCloseWorkerKeyModal}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>

    {mfaState && (
      <MfaChallengeUI isModal={true}
        challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
        maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
        onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
    )}
    <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </MfaPageGuard>
  );
}
