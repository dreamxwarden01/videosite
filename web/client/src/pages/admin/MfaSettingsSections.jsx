import { useState, useEffect, useCallback, useRef } from 'react';
import { useToast } from '../../context/ToastContext';
import useStepupGuard from '../../hooks/useStepupGuard';
import StepUpBlock from '../../components/StepUpBlock';
import { apiPut } from '../../api';
import VsSaveBar from '../../components/VsSaveBar';

// The single "MFA" settings pane (step-up): the sudo-window durations (one-time +
// per-level persistent windows) and the per-scenario policy table, together. The
// former "pending challenge timeout" is gone (the SSO txn TTL governs the in-flight
// challenge) and the separate "levels" section is folded in here.

// Step-up scenarios (mirrors the server KNOWN_SCENARIOS).
const SCENARIOS = [
  { key: 'enrollment', label: 'Enrollment' },
  { key: 'user', label: 'User' },
  { key: 'roles', label: 'Roles' },
  { key: 'transcoding', label: 'Transcoding' },
  { key: 'settings', label: 'Settings' },
];

const LEVEL_LABELS = { 1: 'Level 1 (Authenticator + Passkey)', 2: 'Level 2 (Passkey only)' };

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
function toDisplay(seconds, unit) { return Math.round(seconds / UNIT_OPTIONS.find(u => u.value === unit).factor); }
function toSeconds(value, unit) { return Math.round(value * UNIT_OPTIONS.find(u => u.value === unit).factor); }
function convertUnit(currentValue, currentUnit, newUnit) {
  const seconds = toSeconds(currentValue, currentUnit);
  return Math.max(1, Math.ceil(seconds / UNIT_OPTIONS.find(u => u.value === newUnit).factor));
}

const handleDigitOnly = (e) => {
  if (e.ctrlKey || e.metaKey || ['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  if (!/^\d$/.test(e.key)) e.preventDefault();
};
const handleDigitPaste = (setter) => (e) => {
  e.preventDefault();
  const digits = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
  if (digits) setter(digits);
};

export default function MfaSettingsSections({ onDirty, onLock }) {
  const { showToast } = useToast();
  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('settings');

  const [loading, setLoading] = useState(true);
  const [savingWindows, setSavingWindows] = useState(false);
  const [savingPolicies, setSavingPolicies] = useState(false);

  // Windows: one-time (minutes) + per-level (value + unit).
  const [onetimeMin, setOnetimeMin] = useState('10');
  const [levelValues, setLevelValues] = useState({
    level_1: { value: '1', unit: 'hours' },
    level_2: { value: '10', unit: 'minutes' },
  });
  const originalWindows = useRef({ onetimeMin: '10', level_1: 3600, level_2: 600 });
  const [winErrors, setWinErrors] = useState({});
  const [winTouched, setWinTouched] = useState({});

  // Policies
  const [policies, setPolicies] = useState({});
  const [originalPolicies, setOriginalPolicies] = useState({});

  const fetchSettings = useCallback(async () => {
    try {
      const { data, ok } = await guardFetch('/api/admin/mfa/settings');
      if (ok && data) {
        const ot = Math.round(data.general.onetime_timeout_seconds / 60);
        setOnetimeMin(String(ot));
        const lvl = {};
        const l1 = data.general.level_1_timeout_seconds;
        const l2 = data.general.level_2_timeout_seconds;
        lvl.level_1 = { value: String(toDisplay(l1, bestUnit(l1))), unit: bestUnit(l1) };
        lvl.level_2 = { value: String(toDisplay(l2, bestUnit(l2))), unit: bestUnit(l2) };
        setLevelValues(lvl);
        originalWindows.current = { onetimeMin: String(ot), level_1: l1, level_2: l2 };

        const p = {};
        for (const s of SCENARIOS) p[s.key] = { ...data.policies[s.key] };
        setPolicies(p);
        setOriginalPolicies(JSON.parse(JSON.stringify(p)));
        setWinTouched({}); setWinErrors({});
      }
    } catch {
      showToast('Failed to load MFA settings.');
    } finally {
      setLoading(false);
    }
  }, [guardFetch]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // ---- Windows (one-time + level_1 + level_2), saved together ----
  const levelSeconds = (key) => toSeconds(parseInt(levelValues[key].value, 10) || 0, levelValues[key].unit);
  const validateWindows = () => {
    const errs = {};
    const ot = parseInt(onetimeMin, 10);
    if (!onetimeMin || isNaN(ot) || ot < 1 || ot > 60) errs.onetime = 'Must be 1–60 minutes';
    for (const key of ['level_1', 'level_2']) {
      const v = parseInt(levelValues[key].value, 10);
      if (!levelValues[key].value || isNaN(v) || v < 1) { errs[key] = 'Value must be at least 1'; continue; }
      const s = toSeconds(v, levelValues[key].unit);
      if (s < 60 || s > 31536000) errs[key] = 'Between 1 minute and 365 days';
    }
    if (!errs.level_1 && !errs.level_2 && levelSeconds('level_2') > levelSeconds('level_1')) {
      errs.level_2 = 'Must not exceed Level 1';
    }
    setWinErrors(errs);
    return Object.keys(errs).length === 0;
  };
  const winBlur = (field) => () => { setWinTouched(prev => ({ ...prev, [field]: true })); validateWindows(); };
  const hasWinErrors = Object.values(winErrors).some(Boolean);
  const isWindowsDirty = onetimeMin !== originalWindows.current.onetimeMin
    || levelSeconds('level_1') !== originalWindows.current.level_1
    || levelSeconds('level_2') !== originalWindows.current.level_2;
  const windowItems = [];
  if (onetimeMin !== originalWindows.current.onetimeMin) windowItems.push({ label: 'One-time' });
  if (levelSeconds('level_1') !== originalWindows.current.level_1) windowItems.push({ label: 'Level 1' });
  if (levelSeconds('level_2') !== originalWindows.current.level_2) windowItems.push({ label: 'Level 2' });

  const setLevelValue = (key, val) => setLevelValues(prev => ({ ...prev, [key]: { ...prev[key], value: val } }));
  const setLevelUnit = (key, newUnit) => {
    const cur = levelValues[key];
    const converted = convertUnit(parseInt(cur.value, 10) || 0, cur.unit, newUnit);
    setLevelValues(prev => ({ ...prev, [key]: { value: String(converted), unit: newUnit } }));
  };

  const handleSaveWindows = async () => {
    setWinTouched({ onetime: true, level_1: true, level_2: true });
    if (!validateWindows()) return;
    setSavingWindows(true);
    try {
      const body = {
        onetime_timeout_seconds: parseInt(onetimeMin, 10) * 60,
        level_1_timeout_seconds: levelSeconds('level_1'),
        level_2_timeout_seconds: levelSeconds('level_2'),
      };
      const { ok, data } = await apiPut('/api/admin/mfa/settings/general', body);
      if (ok) {
        showToast('Step-up windows saved.', 'success');
        originalWindows.current = { onetimeMin, level_1: body.level_1_timeout_seconds, level_2: body.level_2_timeout_seconds };
        setWinTouched({}); setWinErrors({});
      } else if (data?.code !== 'step_up_required') {
        showToast(data?.error || 'Failed to save windows.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingWindows(false); }
  };
  const discardWindows = () => {
    setOnetimeMin(originalWindows.current.onetimeMin);
    const lvl = {};
    for (const key of ['level_1', 'level_2']) {
      const secs = originalWindows.current[key];
      lvl[key] = { value: String(toDisplay(secs, bestUnit(secs))), unit: bestUnit(secs) };
    }
    setLevelValues(lvl);
    setWinTouched({}); setWinErrors({});
  };

  // ---- Policies ----
  const isPolicyDirty = (key) => {
    const cur = policies[key]; const orig = originalPolicies[key];
    if (!cur || !orig) return false;
    return cur.enabled !== orig.enabled || cur.level !== orig.level || cur.scope !== orig.scope || cur.reuse !== orig.reuse;
  };
  const updatePolicy = (key, field, value) => setPolicies(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  const dirtyScenarios = SCENARIOS.filter(s => isPolicyDirty(s.key));
  const policyItems = dirtyScenarios.map(s => ({ label: s.label }));

  // Commit the whole changed grid in ONE request. A step_up_required 403 is handled
  // by the global StepUpProvider (the challenge modal opens) — don't also toast it.
  const handleSavePolicies = async () => {
    setSavingPolicies(true);
    try {
      const body = { policies: {} };
      for (const s of dirtyScenarios) body.policies[s.key] = policies[s.key];
      const { ok, data } = await apiPut('/api/admin/mfa/settings/policies', body);
      if (!ok) {
        if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to save the policies.');
        return;
      }
      setOriginalPolicies(prev => {
        const next = { ...prev };
        for (const s of dirtyScenarios) next[s.key] = { ...policies[s.key] };
        return next;
      });
      showToast('Step-up policy saved.', 'success');
    } catch (err) { showToast(err.message); }
    finally { setSavingPolicies(false); }
  };
  const discardPolicies = () => setPolicies(JSON.parse(JSON.stringify(originalPolicies)));

  // Report dirty flags up so the rail can show an unsaved dot.
  useEffect(() => {
    if (!onDirty) return;
    onDirty({ mfa: isWindowsDirty || dirtyScenarios.length > 0 });
  }, [onDirty, isWindowsDirty, dirtyScenarios.length]);

  // Clear the rail's dirty dot AND lock on unmount — a pane switch re-mounts this
  // fresh, so any unsaved edits (and their dot) are gone, and a stale lock would
  // otherwise freeze the rail.
  useEffect(() => () => { if (onDirty) onDirty({ mfa: false }); if (onLock) onLock(false); }, [onDirty, onLock]);

  // Lock the parent's rail while a save is in flight.
  useEffect(() => {
    if (!onLock) return;
    onLock(savingWindows || savingPolicies);
  }, [onLock, savingWindows, savingPolicies]);

  return (
    <>
      {blocked ? (
        <StepUpBlock onVerify={verify} />
      ) : loading ? (
        <div className="vs-cv-empty" style={{ padding: '48px 16px' }}>Loading…</div>
      ) : (
        <>
          <h3 className="vs-set-h">Step-up windows</h3>
          <p className="vs-set-sub">How long a completed step-up stays valid before it must be repeated. Level windows apply to persistent-reuse scenarios; the one-time window applies to one-time scenarios.</p>
          <div className="vs-field" style={{ maxWidth: 280 }}>
            <label className="vs-label">One-time window (minutes)</label>
            <input type="text" inputMode="numeric" className={'vs-input' + (winTouched.onetime && winErrors.onetime ? ' err' : '')}
              value={onetimeMin} onChange={e => setOnetimeMin(e.target.value)}
              onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setOnetimeMin)} onBlur={winBlur('onetime')} />
            <p className={'vs-hint' + (winTouched.onetime && winErrors.onetime ? ' err' : '')}>
              {winTouched.onetime && winErrors.onetime ? winErrors.onetime : 'Range: 1–60 minutes.'}
            </p>
          </div>
          {['level_1', 'level_2'].map(key => {
            const lvl = levelValues[key];
            const showError = winTouched[key] && winErrors[key];
            return (
              <div className="vs-field" key={key} style={{ maxWidth: 360 }}>
                <label className="vs-label">{LEVEL_LABELS[key.slice(-1)]}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" inputMode="numeric" className={'vs-input' + (showError ? ' err' : '')}
                    value={lvl.value} onChange={e => setLevelValue(key, e.target.value)}
                    onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(v => setLevelValue(key, v))} onBlur={winBlur(key)} style={{ flex: 1 }} />
                  <select className="vs-select" value={lvl.unit} onChange={e => setLevelUnit(key, e.target.value)} style={{ width: 120 }}>
                    {UNIT_OPTIONS.map(u => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                </div>
                {showError && <p className="vs-hint err">{winErrors[key]}</p>}
              </div>
            );
          })}
          <VsSaveBar visible={isWindowsDirty} busy={savingWindows} items={windowItems}
            invalid={hasWinErrors} invalidNote="Fix the highlighted fields to save."
            onSave={() => guardAction(handleSaveWindows)} onDiscard={discardWindows} saveLabel="Save" />

          <h3 className="vs-set-h" style={{ marginTop: 32 }}>Policy by scenario</h3>
          <p className="vs-set-sub">Which actions require a fresh step-up. Level sets the accepted factor (2 = passkey only); scope gates reads too (RW) or writes only (W); reuse is the persistent window or one-time.</p>
          <div className="vs-st-tbl">
            <div className="vs-st-th">
              <span style={{ flex: '1.3', minWidth: 0 }}>Scenario</span>
              <span style={{ flex: '0 0 52px' }}>Enable</span>
              <span style={{ flex: 1 }}>Level</span>
              <span style={{ flex: 1 }}>Scope</span>
              <span style={{ flex: 1 }}>Reuse</span>
            </div>
            {SCENARIOS.map(s => {
              const p = policies[s.key] || { enabled: false, level: 1, scope: 'W', reuse: 'persistent' };
              return (
                <div className={'vs-st-tr' + (isPolicyDirty(s.key) ? ' changed' : '')} key={s.key}>
                  <span style={{ flex: '1.3', minWidth: 0, fontWeight: 500 }}>{s.label}</span>
                  <span style={{ flex: '0 0 52px' }}>
                    <label className="vs-switch">
                      <input type="checkbox" checked={p.enabled} onChange={e => updatePolicy(s.key, 'enabled', e.target.checked)} />
                      <span className="vs-switch-slider" />
                    </label>
                  </span>
                  <span style={{ flex: 1 }}>
                    <select className="vs-select vs-select-sm" value={p.level} onChange={e => updatePolicy(s.key, 'level', parseInt(e.target.value, 10))}>
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                    </select>
                  </span>
                  <span style={{ flex: 1 }}>
                    <select className="vs-select vs-select-sm" value={p.scope} onChange={e => updatePolicy(s.key, 'scope', e.target.value)}>
                      <option value="W">Write</option>
                      <option value="RW">Read + Write</option>
                    </select>
                  </span>
                  <span style={{ flex: 1 }}>
                    <select className="vs-select vs-select-sm" value={p.reuse} onChange={e => updatePolicy(s.key, 'reuse', e.target.value)}>
                      <option value="persistent">Persistent</option>
                      <option value="one-time">One-time</option>
                    </select>
                  </span>
                </div>
              );
            })}
          </div>
          <VsSaveBar visible={dirtyScenarios.length > 0} busy={savingPolicies} items={policyItems}
            onSave={() => guardAction(handleSavePolicies)} onDiscard={discardPolicies} saveLabel="Save policy" />
        </>
      )}
    </>
  );
}
