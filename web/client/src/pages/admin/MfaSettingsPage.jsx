import { useState, useEffect, useCallback } from 'react';
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

  // General settings
  const [challengeTimeoutMin, setChallengeTimeoutMin] = useState(15);
  const [otpTimeoutMin, setOtpTimeoutMin] = useState(5);

  // Level timeouts — stored as { value, unit } for each level
  const [levelValues, setLevelValues] = useState({
    level_0: { value: 7, unit: 'days' },
    level_1: { value: 1, unit: 'hours' },
    level_2: { value: 10, unit: 'minutes' },
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
        // mfa_login_enabled removed — login MFA controlled via policy table
        setChallengeTimeoutMin(Math.round(data.general.mfa_pending_challenge_timeout_seconds / 60));
        setOtpTimeoutMin(Math.round(data.general.mfa_otp_timeout_seconds / 60));

        // Levels
        const lvl = {};
        for (const key of ['level_0', 'level_1', 'level_2']) {
          const secs = data.levels[key];
          const unit = bestUnit(secs);
          lvl[key] = { value: toDisplay(secs, unit), unit };
        }
        setLevelValues(lvl);

        // Policies
        const p = {};
        for (const s of SCENARIOS) {
          p[s.key] = { ...data.policies[s.key] };
        }
        setPolicies(p);
        setOriginalPolicies(JSON.parse(JSON.stringify(p)));
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

  // ---- General ----

  const otpExceedsChallenge = otpTimeoutMin > challengeTimeoutMin;

  const handleSaveGeneral = async (e) => {
    e.preventDefault();
    if (otpExceedsChallenge) return;
    setSavingGeneral(true);
    try {
      const { ok, data } = await mfaFetch('/api/admin/mfa/settings/general', {
        method: 'PUT', body: {
          mfa_pending_challenge_timeout_seconds: challengeTimeoutMin * 60,
          mfa_otp_timeout_seconds: otpTimeoutMin * 60,
        }
      });
      if (ok) {
        showToast('General MFA settings saved.', 'success');
      } else {
        showToast(data?.error || 'Failed to save general settings.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setSavingGeneral(false);
    }
  };

  // ---- Levels ----

  const handleLevelValueChange = (key, val) => {
    setLevelValues(prev => ({
      ...prev,
      [key]: { ...prev[key], value: val },
    }));
  };

  const handleLevelUnitChange = (key, newUnit) => {
    setLevelValues(prev => {
      const cur = prev[key];
      const converted = convertUnit(cur.value, cur.unit, newUnit);
      return { ...prev, [key]: { value: converted, unit: newUnit } };
    });
  };

  const handleSaveLevels = async (e) => {
    e.preventDefault();
    setSavingLevels(true);
    try {
      const body = {};
      for (const key of ['level_0', 'level_1', 'level_2']) {
        const secs = toSeconds(levelValues[key].value, levelValues[key].unit);
        if (secs < 60 || secs > 31536000) {
          showToast(`${LEVEL_LABELS[key.slice(-1)]} timeout must be between 1 minute and 365 days.`);
          setSavingLevels(false);
          return;
        }
        body[key] = secs;
      }
      const { ok, data } = await mfaFetch('/api/admin/mfa/settings/levels', { method: 'PUT', body });
      if (ok) {
        showToast('Level timeouts saved.', 'success');
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
              type="number"
              id="challengeTimeout"
              className="form-control"
              value={challengeTimeoutMin}
              onChange={e => setChallengeTimeoutMin(parseInt(e.target.value, 10) || 0)}
              min={10}
              max={120}
              style={{ maxWidth: '200px' }}
            />
            <small className="text-muted" style={{ display: 'block' }}>Range: 10-120 minutes</small>
          </div>

          <div className="form-group">
            <label htmlFor="otpTimeout">OTP Code Timeout (minutes)</label>
            <input
              type="number"
              id="otpTimeout"
              className="form-control"
              value={otpTimeoutMin}
              onChange={e => setOtpTimeoutMin(parseInt(e.target.value, 10) || 0)}
              min={3}
              max={60}
              style={{ maxWidth: '200px' }}
            />
            <small className="text-muted" style={{ display: 'block' }}>Range: 3-60 minutes</small>
            {otpExceedsChallenge && (
              <div className="field-error" style={{ marginTop: '4px' }}>
                OTP timeout must not exceed the challenge timeout.
              </div>
            )}
          </div>

          <button type="submit" className="btn btn-primary" disabled={savingGeneral || otpExceedsChallenge}>
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
            Higher levels require stronger methods and typically have shorter timeouts.
          </p>
          <form onSubmit={handleSaveLevels}>
            {['level_0', 'level_1', 'level_2'].map(key => {
              const lvl = levelValues[key];
              const levelNum = key.slice(-1);
              return (
                <div className="form-group" key={key}>
                  <label>{LEVEL_LABELS[levelNum]}</label>
                  <div style={{ display: 'flex', gap: '8px', maxWidth: '300px' }}>
                    <input
                      type="number"
                      className="form-control"
                      value={lvl.value}
                      onChange={e => handleLevelValueChange(key, parseInt(e.target.value, 10) || 0)}
                      min={1}
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
                </div>
              );
            })}
            <button type="submit" className="btn btn-primary" disabled={savingLevels}>
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
