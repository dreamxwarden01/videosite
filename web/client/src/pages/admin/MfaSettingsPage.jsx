import { useState, useEffect, useCallback, useRef } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import LoadingSpinner from '../../components/LoadingSpinner';

const SCENARIOS = [
  { key: 'login', label: 'Login' },
  { key: 'course', label: 'Course' },
  { key: 'enrollment', label: 'Enrollment' },
  { key: 'user', label: 'User' },
  { key: 'invitation_codes', label: 'Invitation Codes' },
  { key: 'roles', label: 'Roles' },
  { key: 'playback_stats', label: 'Playback Stats' },
  { key: 'transcoding', label: 'Transcoding' },
  { key: 'settings', label: 'Settings' },
  { key: 'mfa', label: 'MFA' },
];

const LEVEL_LABELS = {
  0: 'Level 0 (All methods)',
  1: 'Level 1 (Authenticator + Passkey)',
  2: 'Level 2 (Passkey only)',
};

const UNIT_OPTIONS = [
  { value: 'minutes', label: 'Minutes', factor: 60 },
  { value: 'hours', label: 'Hours', factor: 3600 },
  { value: 'days', label: 'Days', factor: 86400 },
];

function bestUnit(seconds) {
  if (seconds % 86400 === 0 && seconds >= 86400) return 'days';
  if (seconds % 3600 === 0 && seconds >= 3600) return 'hours';
  return 'minutes';
}

function toDisplay(seconds, unit) {
  const opt = UNIT_OPTIONS.find(u => u.value === unit);
  return Math.round(seconds / opt.factor);
}

function toSeconds(value, unit) {
  const opt = UNIT_OPTIONS.find(u => u.value === unit);
  return Math.round(value * opt.factor);
}

function convertUnit(currentValue, currentUnit, newUnit) {
  const seconds = toSeconds(currentValue, currentUnit);
  const newOpt = UNIT_OPTIONS.find(u => u.value === newUnit);
  const raw = seconds / newOpt.factor;
  return Math.max(1, Math.ceil(raw));
}

export default function MfaSettingsPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingLevels, setSavingLevels] = useState(false);

  // General settings (stored as strings to avoid "0" flash on empty input)
  const [challengeTimeoutMin, setChallengeTimeoutMin] = useState('15');
  const [onetimeTimeoutMin, setOnetimeTimeoutMin] = useState('10');
  const [otpTimeoutMin, setOtpTimeoutMin] = useState('5');

  // Original values for dirty tracking
  const originalGeneral = useRef({});
  const originalLevelSeconds = useRef({});

  // Validation state
  const [generalErrors, setGeneralErrors] = useState({});
  const [generalTouched, setGeneralTouched] = useState({});
  const [levelErrors, setLevelErrors] = useState({});
  const [levelTouched, setLevelTouched] = useState({});

  // Level timeouts — stored as { value (string), unit } for each level
  const [levelValues, setLevelValues] = useState({
    level_0: { value: '7', unit: 'days' },
    level_1: { value: '1', unit: 'hours' },
    level_2: { value: '10', unit: 'minutes' },
  });

  // Policies — each row: { enabled, level, scope, reuse }
  const [policies, setPolicies] = useState({});
  const [originalPolicies, setOriginalPolicies] = useState({});
  const [savingPolicy, setSavingPolicy] = useState(null);

  // MFA challenge for "mfa" scenario policy changes
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  // MFA page guard for RW scope
  const {
    mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch,
    handlePageMfaSuccess: handlePageMfaSuccess_,
    handlePageMfaCancel: handlePageMfaCancel_,
    retryVerification, mfaVerifiedKey
  } = useMfaPageGuard();

  const handlePageMfaSuccess = (...args) => { handlePageMfaSuccess_(...args); fetchSettings(); };
  const handlePageMfaCancel = handlePageMfaCancel_;

  useEffect(() => {
    document.title = `MFA Settings - ${siteName}`;
  }, [siteName]);

  const fetchSettings = useCallback(async () => {
    try {
      const { data, ok } = await mfaPageFetch('/api/admin/mfa/settings');
      if (ok && data) {
        // General
        const ct = Math.round(data.general.mfa_pending_challenge_timeout_seconds / 60);
        const ot = Math.round(data.general.mfa_onetime_challenge_timeout_seconds / 60);
        const otp = Math.round(data.general.mfa_otp_timeout_seconds / 60);
        setChallengeTimeoutMin(String(ct));
        setOnetimeTimeoutMin(String(ot));
        setOtpTimeoutMin(String(otp));
        originalGeneral.current = { challengeTimeoutMin: String(ct), onetimeTimeoutMin: String(ot), otpTimeoutMin: String(otp) };

        // Levels
        const lvl = {};
        for (const key of ['level_0', 'level_1', 'level_2']) {
          const secs = data.levels[key];
          const unit = bestUnit(secs);
          lvl[key] = { value: String(toDisplay(secs, unit)), unit };
        }
        setLevelValues(lvl);
        originalLevelSeconds.current = { ...data.levels };

        // Policies
        const p = {};
        for (const s of SCENARIOS) {
          p[s.key] = { ...data.policies[s.key] };
        }
        setPolicies(p);
        setOriginalPolicies(JSON.parse(JSON.stringify(p)));

        // Reset validation state
        setGeneralTouched({});
        setGeneralErrors({});
        setLevelTouched({});
        setLevelErrors({});
      }
    } catch {
      showToast('Failed to load MFA settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings, mfaVerifiedKey]);

  if (!user?.permissions?.manageSiteMFA) {
    return <p className="text-muted">Permission denied.</p>;
  }

  if (loading) return <LoadingSpinner />;

  // ---- Digit-only input handlers ----

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

  // ---- General validation ----

  const validateGeneral = (ct = challengeTimeoutMin, ot = onetimeTimeoutMin, otp = otpTimeoutMin) => {
    const errs = {};
    const ctVal = parseInt(ct, 10);
    const otVal = parseInt(ot, 10);
    const otpVal = parseInt(otp, 10);

    if (!ct || isNaN(ctVal) || ctVal < 10 || ctVal > 120) errs.challengeTimeout = 'Must be 10-120 minutes';
    if (!ot || isNaN(otVal) || otVal < 1 || otVal > 60) errs.onetimeTimeout = 'Must be 1-60 minutes';
    if (!otp || isNaN(otpVal) || otpVal < 3 || otpVal > 60) errs.otpTimeout = 'Must be 3-60 minutes';

    if (!errs.onetimeTimeout && !errs.challengeTimeout && otVal > ctVal) {
      errs.onetimeTimeout = 'Must not exceed Pending Challenge Timeout';
    }
    if (!errs.otpTimeout && !errs.challengeTimeout && otpVal > ctVal) {
      errs.otpTimeout = 'Must not exceed Pending Challenge Timeout';
    }

    setGeneralErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleGeneralBlur = (field) => () => {
    setGeneralTouched(prev => ({ ...prev, [field]: true }));
    validateGeneral();
  };

  const hasGeneralErrors = Object.values(generalErrors).some(Boolean);
  const isGeneralDirty = challengeTimeoutMin !== originalGeneral.current.challengeTimeoutMin
    || onetimeTimeoutMin !== originalGeneral.current.onetimeTimeoutMin
    || otpTimeoutMin !== originalGeneral.current.otpTimeoutMin;

  const handleSaveGeneral = async (e) => {
    e.preventDefault();
    // Touch all fields so errors show
    setGeneralTouched({ challengeTimeout: true, onetimeTimeout: true, otpTimeout: true });
    if (!validateGeneral()) return;
    setSavingGeneral(true);
    try {
      const { ok, data } = await mfaFetch('/api/admin/mfa/settings/general', {
        method: 'PUT', body: {
          mfa_pending_challenge_timeout_seconds: parseInt(challengeTimeoutMin, 10) * 60,
          mfa_onetime_challenge_timeout_seconds: parseInt(onetimeTimeoutMin, 10) * 60,
          mfa_otp_timeout_seconds: parseInt(otpTimeoutMin, 10) * 60,
        }
      });
      if (ok) {
        showToast('General MFA settings saved.', 'success');
        originalGeneral.current = { challengeTimeoutMin, onetimeTimeoutMin, otpTimeoutMin };
        setGeneralTouched({});
        setGeneralErrors({});
      } else {
        showToast(data?.error || 'Failed to save general settings.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingGeneral(false);
    }
  };

  // ---- Levels validation ----

  const validateLevels = (vals = levelValues) => {
    const errs = {};
    const secs = {};
    for (const key of ['level_0', 'level_1', 'level_2']) {
      const v = parseInt(vals[key].value, 10);
      if (!vals[key].value || isNaN(v) || v < 1) {
        errs[key] = 'Value must be at least 1';
        secs[key] = 0;
        continue;
      }
      const s = toSeconds(v, vals[key].unit);
      secs[key] = s;
      if (s < 60 || s > 31536000) {
        errs[key] = 'Must be between 1 minute and 365 days';
      }
    }
    // Ordering: level_2 <= level_1 <= level_0
    if (!errs.level_1 && !errs.level_0 && secs.level_1 > secs.level_0) {
      errs.level_1 = 'Must not exceed Level 0 timeout';
    }
    if (!errs.level_2 && !errs.level_1 && secs.level_2 > secs.level_1) {
      errs.level_2 = 'Must not exceed Level 1 timeout';
    }
    if (!errs.level_2 && !errs.level_0 && secs.level_2 > secs.level_0) {
      errs.level_2 = 'Must not exceed Level 0 timeout';
    }

    setLevelErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleLevelBlur = (key) => () => {
    setLevelTouched(prev => ({ ...prev, [key]: true }));
    validateLevels();
  };

  const hasLevelErrors = Object.values(levelErrors).some(Boolean);
  const currentLevelSeconds = {
    level_0: toSeconds(parseInt(levelValues.level_0.value, 10) || 0, levelValues.level_0.unit),
    level_1: toSeconds(parseInt(levelValues.level_1.value, 10) || 0, levelValues.level_1.unit),
    level_2: toSeconds(parseInt(levelValues.level_2.value, 10) || 0, levelValues.level_2.unit),
  };
  const isLevelsDirty = currentLevelSeconds.level_0 !== originalLevelSeconds.current.level_0
    || currentLevelSeconds.level_1 !== originalLevelSeconds.current.level_1
    || currentLevelSeconds.level_2 !== originalLevelSeconds.current.level_2;

  const handleLevelValueChange = (key, val) => {
    setLevelValues(prev => ({
      ...prev,
      [key]: { ...prev[key], value: val },
    }));
  };

  const handleLevelUnitChange = (key, newUnit) => {
    setLevelValues(prev => {
      const cur = prev[key];
      const converted = convertUnit(parseInt(cur.value, 10) || 0, cur.unit, newUnit);
      return { ...prev, [key]: { value: String(converted), unit: newUnit } };
    });
    // Re-validate after unit change if any field has been touched
    if (Object.keys(levelTouched).length > 0) {
      setTimeout(() => validateLevels(), 0);
    }
  };

  const handleSaveLevels = async (e) => {
    e.preventDefault();
    // Touch all fields
    setLevelTouched({ level_0: true, level_1: true, level_2: true });
    if (!validateLevels()) return;
    setSavingLevels(true);
    try {
      const body = {};
      for (const key of ['level_0', 'level_1', 'level_2']) {
        body[key] = toSeconds(parseInt(levelValues[key].value, 10), levelValues[key].unit);
      }
      const { ok, data } = await mfaFetch('/api/admin/mfa/settings/levels', { method: 'PUT', body });
      if (ok) {
        showToast('Level timeouts saved.', 'success');
        originalLevelSeconds.current = { ...body };
        setLevelTouched({});
        setLevelErrors({});
      } else {
        showToast(data?.error || 'Failed to save level timeouts.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingLevels(false);
    }
  };

  // ---- Policies ----

  const isPolicyDirty = (key) => {
    const cur = policies[key];
    const orig = originalPolicies[key];
    if (!cur || !orig) return false;
    return cur.enabled !== orig.enabled ||
      cur.level !== orig.level ||
      cur.scope !== orig.scope ||
      cur.reuse !== orig.reuse;
  };

  const updatePolicy = (key, field, value) => {
    setPolicies(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const handleSavePolicy = async (scenarioKey) => {
    setSavingPolicy(scenarioKey);
    try {
      const policy = policies[scenarioKey];
      const url = `/api/admin/mfa/settings/policy/${scenarioKey}`;
      const { ok, data } = await mfaFetch(url, { method: 'PUT', body: policy });
      if (ok) {
        showToast(`Policy for "${scenarioKey}" saved.`, 'success');
        setOriginalPolicies(prev => ({
          ...prev,
          [scenarioKey]: { ...policy },
        }));
      } else {
        showToast(data?.error || 'Failed to save policy.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingPolicy(null);
    }
  };

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <h1 className="mb-3">MFA Settings</h1>

      {/* Card 1: General MFA Settings */}
      <div className="card">
        <div className="card-header">
          <h2>General MFA Settings</h2>
        </div>
        <form onSubmit={handleSaveGeneral} style={{ maxWidth: '600px' }}>
          <div className="form-group">
            <label htmlFor="challengeTimeout">Pending Challenge Timeout (minutes)</label>
            <input
              type="text" inputMode="numeric"
              id="challengeTimeout"
              className={`form-control${generalTouched.challengeTimeout && generalErrors.challengeTimeout ? ' input-error' : ''}`}
              value={challengeTimeoutMin}
              onChange={e => setChallengeTimeoutMin(e.target.value)}
              onKeyDown={handleDigitOnly}
              onPaste={handleDigitPaste(setChallengeTimeoutMin)}
              onBlur={handleGeneralBlur('challengeTimeout')}
              style={{ maxWidth: '200px' }}
            />
            <small className="text-muted" style={{ display: 'block' }}>Range: 10-120 minutes</small>
            {generalTouched.challengeTimeout && generalErrors.challengeTimeout && (
              <div className="field-error" style={{ marginTop: '4px' }}>{generalErrors.challengeTimeout}</div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="onetimeTimeout">One-Time Challenge Timeout (minutes)</label>
            <input
              type="text" inputMode="numeric"
              id="onetimeTimeout"
              className={`form-control${generalTouched.onetimeTimeout && generalErrors.onetimeTimeout ? ' input-error' : ''}`}
              value={onetimeTimeoutMin}
              onChange={e => setOnetimeTimeoutMin(e.target.value)}
              onKeyDown={handleDigitOnly}
              onPaste={handleDigitPaste(setOnetimeTimeoutMin)}
              onBlur={handleGeneralBlur('onetimeTimeout')}
              style={{ maxWidth: '200px' }}
            />
            <small className="text-muted" style={{ display: 'block' }}>Range: 1-60 minutes</small>
            {generalTouched.onetimeTimeout && generalErrors.onetimeTimeout && (
              <div className="field-error" style={{ marginTop: '4px' }}>{generalErrors.onetimeTimeout}</div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="otpTimeout">OTP Code Timeout (minutes)</label>
            <input
              type="text" inputMode="numeric"
              id="otpTimeout"
              className={`form-control${generalTouched.otpTimeout && generalErrors.otpTimeout ? ' input-error' : ''}`}
              value={otpTimeoutMin}
              onChange={e => setOtpTimeoutMin(e.target.value)}
              onKeyDown={handleDigitOnly}
              onPaste={handleDigitPaste(setOtpTimeoutMin)}
              onBlur={handleGeneralBlur('otpTimeout')}
              style={{ maxWidth: '200px' }}
            />
            <small className="text-muted" style={{ display: 'block' }}>Range: 3-60 minutes</small>
            {generalTouched.otpTimeout && generalErrors.otpTimeout && (
              <div className="field-error" style={{ marginTop: '4px' }}>{generalErrors.otpTimeout}</div>
            )}
          </div>

          <button type="submit" className="btn btn-primary" disabled={savingGeneral || !isGeneralDirty || hasGeneralErrors}>
            {savingGeneral ? 'Saving...' : 'Save General Settings'}
          </button>
        </form>
      </div>

      {/* Card 2: Verification Level Timeouts */}
      <div className="card mt-3">
        <div className="card-header">
          <h2>Verification Level Timeouts</h2>
        </div>
        <div style={{ maxWidth: '600px' }}>
          <p className="text-muted" style={{ marginBottom: '16px' }}>
            After a user completes MFA verification, the approval is remembered for the duration specified here.
            Higher levels require stronger methods and must have shorter or equal timeouts.
          </p>
          <form onSubmit={handleSaveLevels}>
            {['level_0', 'level_1', 'level_2'].map(key => {
              const lvl = levelValues[key];
              const levelNum = key.slice(-1);
              const showError = levelTouched[key] && levelErrors[key];
              return (
                <div className="form-group" key={key}>
                  <label>{LEVEL_LABELS[levelNum]}</label>
                  <div style={{ display: 'flex', gap: '8px', maxWidth: '300px' }}>
                    <input
                      type="text" inputMode="numeric"
                      className={`form-control${showError ? ' input-error' : ''}`}
                      value={lvl.value}
                      onChange={e => handleLevelValueChange(key, e.target.value)}
                      onKeyDown={handleDigitOnly}
                      onPaste={handleDigitPaste((v) => handleLevelValueChange(key, v))}
                      onBlur={handleLevelBlur(key)}
                      style={{ flex: 1 }}
                    />
                    <select
                      className="form-control"
                      value={lvl.unit}
                      onChange={e => handleLevelUnitChange(key, e.target.value)}
                      style={{ width: '120px' }}
                    >
                      {UNIT_OPTIONS.map(u => (
                        <option key={u.value} value={u.value}>{u.label}</option>
                      ))}
                    </select>
                  </div>
                  {showError && (
                    <div className="field-error" style={{ marginTop: '4px' }}>{levelErrors[key]}</div>
                  )}
                </div>
              );
            })}
            <button type="submit" className="btn btn-primary" disabled={savingLevels || !isLevelsDirty || hasLevelErrors}>
              {savingLevels ? 'Saving...' : 'Save Level Timeouts'}
            </button>
          </form>
        </div>
      </div>

      {/* Card 3: MFA Policy by Scenario */}
      <div className="card mt-3">
        <div className="card-header">
          <h2>MFA Policy by Scenario</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Enable</th>
                <th>Verification Level</th>
                <th>Protected Scope</th>
                <th>Reuse Policy</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {SCENARIOS.map(s => {
                const p = policies[s.key] || { enabled: false, level: 0, scope: 'W', reuse: 'persistent' };
                const isLogin = s.key === 'login';
                const dirty = isPolicyDirty(s.key);
                const isSaving = savingPolicy === s.key;

                return (
                  <tr key={s.key}>
                    <td>{s.label}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={p.enabled}
                        onChange={e => updatePolicy(s.key, 'enabled', e.target.checked)}
                      />
                    </td>
                    <td>
                      <select
                        className="form-control"
                        value={p.level}
                        onChange={e => updatePolicy(s.key, 'level', parseInt(e.target.value, 10))}
                        disabled={isLogin || !p.enabled}
                        style={{ minWidth: '80px' }}
                      >
                        <option value={0}>0</option>
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="form-control"
                        value={p.scope}
                        onChange={e => updatePolicy(s.key, 'scope', e.target.value)}
                        disabled={isLogin || !p.enabled}
                        style={{ minWidth: '80px' }}
                      >
                        <option value="W">Write</option>
                        <option value="RW">Read + Write</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="form-control"
                        value={p.reuse}
                        onChange={e => updatePolicy(s.key, 'reuse', e.target.value)}
                        disabled={!p.enabled}
                        style={{ minWidth: '100px' }}
                      >
                        <option value="persistent">Persistent</option>
                        <option value="one-time">One-time</option>
                      </select>
                    </td>
                    <td>
                      {dirty && (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleSavePolicy(s.key)}
                          disabled={isSaving}
                        >
                          {isSaving ? 'Saving...' : 'Confirm'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {mfaState && (
        <MfaChallengeUI isModal={true}
          challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </div>
    </MfaPageGuard>
  );
}
