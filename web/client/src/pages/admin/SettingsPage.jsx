import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import SsoSettings from '../../components/SsoSettings';
import { useConfirm } from '../../components/ConfirmModal';
import useStepupGuard from '../../hooks/useStepupGuard';
import StepUpBlock, { CardLoading } from '../../components/StepUpBlock';
import { apiPut, apiPost, apiDelete } from '../../api';
import ProfileEditModal from '../../components/ProfileEditModal';
import VsSaveBar from '../../components/VsSaveBar';
import MfaSettingsSections from './MfaSettingsSections';
import { stripToHost, isValidHost } from '../../utils/hostname';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
);

// The Site-domain sections. The Security-domain (MFA) sections live in the
// lazily-mounted MfaSettingsSections child so their step-up guard stays
// independent. Rail groups are visual only — the whole surface gates on
// manageSite (the former manageSiteMFA permission was dropped).
// One flat rail (no Site/Security group headers). The MFA sections (windows +
// policy) are folded into a single "MFA" tab.
const SECTIONS = [
  ['general', 'General'],
  ['transcoding', 'Transcoding'],
  ['cloudflare', 'Cloudflare'],
  ['workers', 'Worker keys'],
  ['sso', 'SSO'],
  ['playback', 'Playback data'],
  ['mfa', 'MFA'],
];
const MFA_KEYS = new Set(['mfa']);
const PANE_KEYS = new Set(SECTIONS.map(([k]) => k));
// Panes backed by a lazy /api/admin/settings?pane=<key> slice GET. The SSO + MFA
// panes fetch (and step-up-guard) themselves; Playback has no read to protect.
const SLICE_PANES = new Set(['general', 'transcoding', 'cloudflare', 'workers']);

export default function SettingsPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();

  // The site panes (general/transcoding/cloudflare/workers) share one 'settings'
  // step-up guard: their slice GETs route through guardFetch (a 403 blocks the pane
  // and the modal opens reactively); their writes pre-check via guardAction. The SSO
  // + MFA panes own their own guard. verify re-prompts from the in-pane block.
  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('settings');

  // The active pane comes from the URL (/admin/settings/:pane) so a step-up
  // returnTo lands back on the exact pane.
  const { pane } = useParams();
  const active = PANE_KEYS.has(pane) ? pane : 'general';

  const [mfaDirty, setMfaDirty] = useState({ mfa: false });
  const [mfaLocked, setMfaLocked] = useState(false); // MFA child has a save in flight
  const paneRef = useRef(null);
  useEffect(() => { if (paneRef.current) paneRef.current.scrollTop = 0; }, [active]);

  // Panes whose slice has loaded at least once — a first visit shows CardLoading,
  // a revisit keeps the (parent-held) content and just re-runs the gate.
  const [loaded, setLoaded] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [clearingStats, setClearingStats] = useState(false);

  // General
  const [siteName_, setSiteName] = useState('');
  const [siteProtocol, setSiteProtocol] = useState('https');
  const [siteHostname, setSiteHostname] = useState('');
  const [sessionInactivityDays, setSessionInactivityDays] = useState('3');
  const [sessionMaxDays, setSessionMaxDays] = useState('15');
  const [registrationDefaultRole, setRegistrationDefaultRole] = useState('');
  const [roles, setRoles] = useState([]);

  // HMAC
  const [hmacEnabled, setHmacEnabled] = useState(false);
  const [hmacHasKey, setHmacHasKey] = useState(false);
  const [hmacTokenValidity, setHmacTokenValidity] = useState('600');
  const [hmacSaving, setHmacSaving] = useState(false);
  const [generatedHmacKey, setGeneratedHmacKey] = useState(null);
  const [hmacKeyCopyLabel, setHmacKeyCopyLabel] = useState('Copy');
  const [playbackRuleCopyLabel, setPlaybackRuleCopyLabel] = useState('click to copy');
  const [posterRuleCopyLabel, setPosterRuleCopyLabel] = useState('click to copy');
  const [hmacInitMode, setHmacInitMode] = useState(false);
  const [r2PublicDomain, setR2PublicDomain] = useState('');

  // Worker Keys
  const [workerKeys, setWorkerKeys] = useState([]);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [generateModalOpen, setGenerateModalOpen] = useState(false);
  const [generateLabel, setGenerateLabel] = useState('');
  const [renameModalState, setRenameModalState] = useState(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [reactivateModalState, setReactivateModalState] = useState(null);
  const [reactivateSaving, setReactivateSaving] = useState(false);
  const [newWorkerKey, setNewWorkerKey] = useState(null);
  const [wkKeyIdCopyLabel, setWkKeyIdCopyLabel] = useState('Copy');
  const [wkSecretCopyLabel, setWkSecretCopyLabel] = useState('Copy');

  // Validation & dirty tracking
  const [errors, setErrors] = useState({});
  const originalValues = useRef({});

  // Transcoding profiles
  const [defaultProfiles, setDefaultProfiles] = useState([]);
  const [enhancedProfiles, setEnhancedProfiles] = useState([]);
  const [audioBitrateKbps, setAudioBitrateKbps] = useState('192');
  const [audioNormTarget, setAudioNormTarget] = useState('-20');
  const [audioNormPeak, setAudioNormPeak] = useState('-2');
  const [audioNormMaxGain, setAudioNormMaxGain] = useState('20');
  const [savingDefault, setSavingDefault] = useState(false);
  const [savingEnhanced, setSavingEnhanced] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [editingProfileTarget, setEditingProfileTarget] = useState(null);
  const originalTranscoding = useRef({});
  const [transcodingErrors, setTranscodingErrors] = useState({});
  const [transcodingTouched, setTranscodingTouched] = useState({});

  useEffect(() => {
    if (!siteName) return;
    document.title = `Settings - ${siteName}`;
  }, [siteName]);

  // Per-pane appliers — each writes only its own slice's state so re-fetching one
  // pane never clobbers another pane's unsaved edits.
  const applyGeneral = (data) => {
    const s = data.settings || {};
    setSiteName(s.site_name || 'VideoSite');
    setSiteProtocol(s.site_protocol || 'https');
    setSiteHostname(s.site_hostname || '');
    setSessionInactivityDays(s.session_inactivity_days || '3');
    setSessionMaxDays(s.session_max_days || '15');
    setRegistrationDefaultRole(s.registration_default_role ?? '');
    setRoles(data.roles || []);
    originalValues.current = {
      site_name: s.site_name || 'VideoSite',
      site_protocol: s.site_protocol || 'https',
      site_hostname: s.site_hostname || '',
      session_inactivity_days: s.session_inactivity_days || '3',
      session_max_days: s.session_max_days || '15',
      registration_default_role: s.registration_default_role ?? '',
    };
    setErrors({});
  };
  const applyCloudflare = (data) => {
    const cf = data.cloudflare || {};
    setHmacHasKey(cf.video_hmac_secret_configured || false);
    setHmacEnabled(!!cf.video_hmac_enabled);
    setHmacTokenValidity(cf.video_hmac_token_validity || '600');
    setR2PublicDomain(cf.r2_public_domain || '');
  };
  const applyWorkers = (data) => setWorkerKeys(data.workerKeys || []);
  const applyTranscoding = (data) => {
    setDefaultProfiles(data.defaultProfiles || []);
    setEnhancedProfiles(data.enhancedProfiles || []);
    const an = data.audioNormalization || {};
    setAudioNormTarget(an.target || '-20');
    setAudioNormPeak(an.peak || '-2');
    setAudioNormMaxGain(an.maxGain || '20');
    const abk = String(data.audioBitrateKbps ?? '192');
    setAudioBitrateKbps(abk);
    originalTranscoding.current = {
      defaultProfiles: JSON.stringify(data.defaultProfiles || []),
      enhancedProfiles: JSON.stringify(data.enhancedProfiles || []),
      target: an.target || '-20', peak: an.peak || '-2', maxGain: an.maxGain || '20', audioBitrateKbps: abk,
    };
    setTranscodingErrors({}); setTranscodingTouched({});
  };
  const APPLIERS = { general: applyGeneral, cloudflare: applyCloudflare, workers: applyWorkers, transcoding: applyTranscoding };

  // Lazy per-pane load. First visit applies data (and marks the pane loaded, so
  // CardLoading yields to content); a revisit only re-runs guardFetch so a lapsed
  // window re-blocks — it keeps the parent-held state (no clobber, no flash). The
  // verify redirect is a full reload, so a fresh window re-loads everything anyway.
  useEffect(() => {
    if (!SLICE_PANES.has(active)) return undefined;
    let cancelled = false;
    const firstLoad = !loaded.has(active);
    (async () => {
      try {
        const { data, ok } = await guardFetch('/api/admin/settings?pane=' + active);
        if (cancelled) return;
        if (ok && data) {
          if (firstLoad) {
            APPLIERS[active](data);
            setLoaded((prev) => { const n = new Set(prev); n.add(active); return n; });
          }
        } else if (data?.code !== 'step_up_required') {
          // A step-up 403 becomes the block card; any other failure (e.g. 500)
          // would otherwise leave the pane silently stuck on "Loading…".
          showToast('Failed to load settings.');
        }
      } catch {
        if (!cancelled) showToast('Failed to load settings.');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, guardFetch]);

  // Refresh the worker-key list after a mutation (create/pause/rename/…). Routed
  // through guardFetch so the gate/blocked state stays in sync.
  const reloadWorkers = async () => {
    const { data, ok } = await guardFetch('/api/admin/settings?pane=workers');
    if (ok && data) applyWorkers(data);
  };

  // --- Client-side validation effects ---
  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      if (!siteName_.trim()) next.site_name = 'Site name is required';
      else delete next.site_name;
      return next;
    });
  }, [siteName_]);

  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      if (!siteHostname.trim()) next.site_hostname = 'Hostname is required';
      else if (!isValidHost(siteHostname)) next.site_hostname = 'Enter a valid hostname or IP address (no spaces, slashes, or path)';
      else delete next.site_hostname;
      return next;
    });
  }, [siteHostname]);

  useEffect(() => {
    setErrors(prev => {
      const next = { ...prev };
      if (sessionInactivityDays === '') next.session_inactivity_days = 'This field is required';
      else {
        const v = Number(sessionInactivityDays);
        if (!Number.isInteger(v) || v < 1 || v > 365) next.session_inactivity_days = 'Must be between 1 and 365';
        else delete next.session_inactivity_days;
      }
      if (sessionMaxDays === '') next.session_max_days = 'This field is required';
      else {
        const v = Number(sessionMaxDays);
        if (!Number.isInteger(v) || v < 1 || v > 365) next.session_max_days = 'Must be between 1 and 365';
        else delete next.session_max_days;
      }
      if (!next.session_inactivity_days && !next.session_max_days && sessionInactivityDays !== '' && sessionMaxDays !== '') {
        if (Number(sessionInactivityDays) > Number(sessionMaxDays)) next.session_inactivity_days = 'Inactivity timeout cannot exceed max lifetime';
      }
      return next;
    });
  }, [sessionInactivityDays, sessionMaxDays]);

  const filteredRoles = useMemo(() => {
    const userLevel = user?.permission_level ?? 0;
    const origRoleId = originalValues.current.registration_default_role;
    return roles.filter(r => r.permission_level > userLevel || String(r.role_id) === String(origRoleId));
  }, [roles, user?.permission_level]);

  if (!user?.permissions?.manageSite) {
    return <p className="text-muted">Permission denied.</p>;
  }
  // Unknown pane in the URL → normalize to the first pane.
  if (!PANE_KEYS.has(pane)) {
    return <Navigate to="/admin/settings/general" replace />;
  }

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

  const orig = originalValues.current;
  const isDirty = siteName_ !== orig.site_name || siteProtocol !== orig.site_protocol || siteHostname !== orig.site_hostname
    || sessionInactivityDays !== orig.session_inactivity_days || sessionMaxDays !== orig.session_max_days
    || registrationDefaultRole !== orig.registration_default_role;
  const hasErrors = Object.values(errors).some(Boolean);

  const generalItems = [];
  if (siteName_ !== orig.site_name) generalItems.push({ label: 'Site name' });
  if (siteProtocol !== orig.site_protocol || siteHostname !== orig.site_hostname) generalItems.push({ label: 'Hostname' });
  if (sessionInactivityDays !== orig.session_inactivity_days) generalItems.push({ label: 'Inactivity timeout' });
  if (sessionMaxDays !== orig.session_max_days) generalItems.push({ label: 'Max lifetime' });
  if (registrationDefaultRole !== orig.registration_default_role) generalItems.push({ label: 'Default role' });

  const transcodingDirty = defaultProfiles && (
    JSON.stringify(defaultProfiles) !== originalTranscoding.current.defaultProfiles
    || JSON.stringify(enhancedProfiles) !== originalTranscoding.current.enhancedProfiles
    || audioNormTarget !== originalTranscoding.current.target || audioNormPeak !== originalTranscoding.current.peak
    || audioNormMaxGain !== originalTranscoding.current.maxGain || audioBitrateKbps !== originalTranscoding.current.audioBitrateKbps);

  const handleSaveGeneral = async () => {
    if (hasErrors) return;
    setSaving(true);
    try {
      const body = {};
      if (siteName_ !== orig.site_name) body.site_name = siteName_;
      if (siteProtocol !== orig.site_protocol) body.site_protocol = siteProtocol;
      if (siteHostname !== orig.site_hostname) body.site_hostname = siteHostname;
      if (sessionInactivityDays !== orig.session_inactivity_days) body.session_inactivity_days = sessionInactivityDays;
      if (sessionMaxDays !== orig.session_max_days) body.session_max_days = sessionMaxDays;
      if (registrationDefaultRole !== orig.registration_default_role) body.registration_default_role = registrationDefaultRole;
      if (Object.keys(body).length === 0) return;

      const { ok, data, status } = await apiPut('/api/admin/settings', body);
      if (ok) {
        showToast('Settings saved.', 'success');
        originalValues.current = {
          site_name: siteName_, site_protocol: siteProtocol, site_hostname: siteHostname,
          session_inactivity_days: sessionInactivityDays, session_max_days: sessionMaxDays,
          registration_default_role: registrationDefaultRole,
        };
        setErrors({});
      } else if (status === 422 && data?.errors) {
        setErrors(data.errors); showToast('Please fix the errors below.');
      } else if (data?.code !== 'step_up_required') {
        // a lapsed-window 403 opens the challenge modal reactively — don't also toast
        showToast(data?.error || 'Failed to save settings.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSaving(false); }
  };
  const discardGeneral = () => {
    setSiteName(orig.site_name); setSiteProtocol(orig.site_protocol); setSiteHostname(orig.site_hostname);
    setSessionInactivityDays(orig.session_inactivity_days); setSessionMaxDays(orig.session_max_days);
    setRegistrationDefaultRole(orig.registration_default_role); setErrors({});
  };

  // HMAC ---------------------------------------------------------------
  const handleToggleHmac = async () => {
    const newEnabled = !hmacEnabled;
    if (newEnabled) {
      if (!await confirm({ title: 'Enable HMAC validation?', message: 'You need an active Cloudflare Pro, Business, or Enterprise plan on your domain to use HMAC validation with custom WAF rules.', confirmLabel: 'Continue', danger: false })) return;
      if (!hmacHasKey) { await doGenerateHmac(true); return; }
    } else {
      if (!await confirm({ title: 'Disable HMAC validation?', message: 'Disable the related HMAC validation rule in your Cloudflare WAF first — otherwise all videos become inaccessible.', confirmLabel: 'Disable', danger: true })) return;
    }
    try {
      const { ok, data } = await apiPut('/api/admin/settings/video-hmac/toggle', { video_hmac_enabled: newEnabled });
      if (ok) setHmacEnabled(newEnabled);
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to toggle HMAC validation.');
    } catch (err) { showToast(err.message); }
  };
  const doGenerateHmac = async (isInit = false) => {
    if (!isInit && hmacHasKey) {
      if (!await confirm({ title: 'Generate a new HMAC key?', message: 'This invalidates all existing playback tokens.', confirmLabel: 'Generate new key', danger: true })) return;
    }
    try {
      const { ok, data } = await apiPost('/api/admin/settings/video-hmac/generate');
      if (ok && data?.secret) {
        setGeneratedHmacKey(data.secret);
        setHmacKeyCopyLabel('Copy'); setPlaybackRuleCopyLabel('click to copy'); setPosterRuleCopyLabel('click to copy');
        setHmacHasKey(true); setHmacInitMode(isInit);
      } else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to generate HMAC key.');
    } catch (err) { showToast(err.message); }
  };
  const handleGenerateHmac = () => doGenerateHmac(false);
  const handleCloseHmacModal = async () => {
    if (hmacInitMode) {
      try {
        const { ok, data } = await apiPut('/api/admin/settings/video-hmac/toggle', { video_hmac_enabled: true });
        if (ok) setHmacEnabled(true);
        else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to enable HMAC validation.');
      } catch (err) { showToast(err.message); }
    }
    setGeneratedHmacKey(null); setHmacInitMode(false);
  };
  const handleCopyHmacKey = () => {
    if (!generatedHmacKey) return;
    navigator.clipboard.writeText(generatedHmacKey).then(() => {
      setHmacKeyCopyLabel('Copied!'); setTimeout(() => setHmacKeyCopyLabel('Copy'), 1500);
    }).catch(() => {});
  };
  const buildWafRule = (secret) => {
    const host = r2PublicDomain || 'your-cdn-domain.com';
    const validity = hmacTokenValidity || '600';
    const playback = `(http.host eq "${host}") and not starts_with(http.request.uri.path, "/posters/") and not (\n    starts_with(http.request.uri.query, "verify=") and\n    is_timed_hmac_valid_v0(\n        "${secret}",\n        concat(\n            substring(http.request.uri.path, 0, 79),\n            "?",\n            substring(http.request.uri.query, 7, 200)\n        ),\n        ${validity},\n        http.request.timestamp.sec,\n        1,\n        "s"\n    )\n)`;
    const poster = `(http.host eq "${host}") and starts_with(http.request.uri.path, "/posters/") and not (\n    starts_with(http.request.uri.query, "verify=") and\n    is_timed_hmac_valid_v0(\n        "${secret}",\n        concat(\n            http.request.uri.path,\n            "?",\n            substring(http.request.uri.query, 7, 200)\n        ),\n        ${validity},\n        http.request.timestamp.sec,\n        1,\n        "s"\n    )\n)`;
    return { playback, poster };
  };
  const handleCopyPlaybackRule = () => {
    if (!generatedHmacKey) return;
    navigator.clipboard.writeText(buildWafRule(generatedHmacKey).playback).then(() => {
      setPlaybackRuleCopyLabel('copied!'); setTimeout(() => setPlaybackRuleCopyLabel('click to copy'), 1500);
    }).catch(() => {});
  };
  const handleCopyPosterRule = () => {
    if (!generatedHmacKey) return;
    navigator.clipboard.writeText(buildWafRule(generatedHmacKey).poster).then(() => {
      setPosterRuleCopyLabel('copied!'); setTimeout(() => setPosterRuleCopyLabel('click to copy'), 1500);
    }).catch(() => {});
  };
  const handleSaveHmacValidity = async () => {
    setHmacSaving(true);
    try {
      const { ok, data } = await apiPut('/api/admin/settings/video-hmac/validity', { video_hmac_token_validity: hmacTokenValidity });
      if (ok) showToast('Token validity updated.', 'success');
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to save token validity.');
    } catch (err) { showToast(err.message); }
    finally { setHmacSaving(false); }
  };

  // Worker keys --------------------------------------------------------
  const handleOpenGenerateModal = () => { setGenerateLabel(''); setGenerateModalOpen(true); };
  const handleConfirmGenerate = async () => {
    setGeneratingKey(true);
    try {
      const { ok, data } = await apiPost('/api/admin/settings/worker-keys', { label: generateLabel.trim() || null });
      if (!ok) { if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to generate worker key'); return; }
      setGenerateModalOpen(false);
      setNewWorkerKey({ keyId: data.keyId, secret: data.secret });
      setWkKeyIdCopyLabel('Copy'); setWkSecretCopyLabel('Copy');
    } catch (err) { showToast(err.message); }
    finally { setGeneratingKey(false); }
  };
  const handleCloseWorkerKeyModal = () => { setNewWorkerKey(null); reloadWorkers(); };
  const handlePauseWorkerKey = async (keyId) => {
    try {
      const { ok, data } = await apiPost(`/api/admin/settings/worker-keys/${keyId}/pause`);
      if (ok) { showToast('Worker key paused.', 'success'); reloadWorkers(); }
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to pause worker key.');
    } catch (err) { showToast(err.message); }
  };
  const handleResumeWorkerKey = async (keyId) => {
    try {
      const { ok, data } = await apiPost(`/api/admin/settings/worker-keys/${keyId}/resume`);
      if (ok) { showToast('Worker key resumed.', 'success'); reloadWorkers(); }
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to resume worker key.');
    } catch (err) { showToast(err.message); }
  };
  const handleOpenRenameModal = (wk) => { setRenameModalState({ keyId: wk.key_id, originalLabel: wk.label || '' }); setRenameLabel(wk.label || ''); };
  const handleConfirmRename = async () => {
    if (!renameModalState) return;
    setRenameSaving(true);
    try {
      const { ok, data } = await apiPost(`/api/admin/settings/worker-keys/${renameModalState.keyId}/rename`, { label: renameLabel.trim() });
      if (ok) { showToast('Worker key renamed.', 'success'); setRenameModalState(null); reloadWorkers(); }
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to rename worker key.');
    } catch (err) { showToast(err.message); }
    finally { setRenameSaving(false); }
  };
  const handleOpenReactivateModal = (keyId) => setReactivateModalState({ keyId });
  const handleConfirmReactivate = async () => {
    if (!reactivateModalState) return;
    setReactivateSaving(true);
    try {
      const { ok, data } = await apiPost(`/api/admin/settings/worker-keys/${reactivateModalState.keyId}/reactivate`);
      if (!ok) { if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to reactivate worker key'); return; }
      setReactivateModalState(null);
      setNewWorkerKey({ keyId: data.keyId, secret: data.secret });
      setWkKeyIdCopyLabel('Copy'); setWkSecretCopyLabel('Copy');
    } catch (err) { showToast(err.message); }
    finally { setReactivateSaving(false); }
  };
  const handleDeleteWorkerKey = async (keyId) => {
    if (!await confirm({ title: 'Delete worker key?', message: 'This can\'t be undone — any worker still running with this key loses its session and can\'t reauth.', confirmLabel: 'Delete', danger: true })) return;
    try {
      const { ok, data } = await apiDelete(`/api/admin/settings/worker-keys/${keyId}`);
      if (ok) { showToast('Worker key deleted.', 'success'); reloadWorkers(); }
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to delete worker key.');
    } catch (err) { showToast(err.message); }
  };
  const copyField = (value, setLabel) => {
    navigator.clipboard.writeText(value).then(() => { setLabel('Copied!'); setTimeout(() => setLabel('Copy'), 1500); }).catch(() => {});
  };

  const handleClearPlaybackStats = async () => {
    if (!await confirm({ title: 'Reset all playback statistics?', message: 'This permanently deletes every user\'s watch history and resume positions across every course — every student loses their "continue watching" progress. This can\'t be undone.', confirmLabel: 'Reset all', danger: true })) return;
    setClearingStats(true);
    try {
      const { ok, data } = await apiDelete('/api/admin/playback-stats');
      if (ok) showToast('All playback statistics cleared.', 'success');
      else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to clear statistics.');
    } catch (err) { showToast(err.message); }
    finally { setClearingStats(false); }
  };

  const saveTranscodingSet = async (which) => {
    const isDefault = which === 'default';
    const profiles = isDefault ? defaultProfiles : enhancedProfiles;
    if (profiles.length === 0) { showToast('At least one profile is required.'); return; }
    const setSaving = isDefault ? setSavingDefault : setSavingEnhanced;
    setSaving(true);
    try {
      const { ok, data } = await apiPut(`/api/admin/settings/transcoding-profiles/${which}`, { profiles });
      if (ok) {
        showToast(`${isDefault ? 'Default' : 'Enhanced'} profiles saved.`, 'success');
        originalTranscoding.current = { ...originalTranscoding.current, [isDefault ? 'defaultProfiles' : 'enhancedProfiles']: JSON.stringify(profiles) };
      } else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to save profiles.');
    } catch (err) { showToast(err.message); }
    finally { setSaving(false); }
  };
  const saveAudioSettings = async () => {
    const abkInt = parseInt(audioBitrateKbps, 10);
    if (!Number.isInteger(abkInt) || abkInt < 128 || abkInt > 320) {
      setTranscodingTouched(t => ({ ...t, audioBitrateKbps: true }));
      setTranscodingErrors(e => ({ ...e, audioBitrateKbps: 'Must be an integer between 128 and 320' }));
      showToast('Please fix the errors below.'); return;
    }
    setSavingDefault(true);
    try {
      const { ok, data } = await apiPut('/api/admin/settings/transcoding-profiles/default', {
        profiles: defaultProfiles, audioNormalization: { target: audioNormTarget, peak: audioNormPeak, maxGain: audioNormMaxGain }, audioBitrateKbps: abkInt,
      });
      if (ok) {
        showToast('Audio settings saved.', 'success');
        originalTranscoding.current = {
          ...originalTranscoding.current, defaultProfiles: JSON.stringify(defaultProfiles),
          target: audioNormTarget, peak: audioNormPeak, maxGain: audioNormMaxGain, audioBitrateKbps,
        };
      } else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to save.');
    } catch (err) { showToast(err.message); }
    finally { setSavingDefault(false); }
  };

  // --- Section navigation ---
  // Each pane is a URL (/admin/settings/:pane) so navigating is a router push. Block
  // it only while the MFA child has a save in flight (switching away would unmount
  // it mid-request). The step-up challenge modal now lives in the global provider,
  // so unmounting a pane can no longer strand it.
  const goSection = (key) => { if (mfaLocked || key === active) return; navigate('/admin/settings/' + key); };
  const dotFor = (key) => {
    if (MFA_KEYS.has(key)) return !!mfaDirty[key];
    if (!loaded.has(key)) return false; // originals aren't populated until the slice loads
    if (key === 'general') return isDirty;
    if (key === 'transcoding') return !!transcodingDirty;
    return false;
  };
  const activeIsMfa = MFA_KEYS.has(active);
  const activeIsSso = active === 'sso';

  const railItem = ([key, label]) => (
    <button key={key} type="button" className={'vs-set-nav' + (active === key ? ' on' : '')} onClick={() => goSection(key)}>
      <span>{label}</span>
      {dotFor(key) && <span className="vs-set-dot" title="Unsaved changes" />}
    </button>
  );

  // --- Site section renderers ---
  const renderGeneral = () => (
    <>
      <h3 className="vs-set-h">General</h3>
      <p className="vs-set-sub">Core identity and session lifetime for the site.</p>
      <div className="vs-field" style={{ maxWidth: 320 }}>
        <label className="vs-label">Site name</label>
        <input type="text" className={'vs-input' + (errors.site_name ? ' err' : '')} value={siteName_} onChange={e => setSiteName(e.target.value)} />
        {errors.site_name && <p className="vs-hint err">{errors.site_name}</p>}
      </div>
      <div className="vs-field" style={{ maxWidth: 420 }}>
        <label className="vs-label">Site hostname</label>
        <div style={{ display: 'flex' }}>
          <select className="vs-select" style={{ width: 104, borderRadius: '8px 0 0 8px', flexShrink: 0 }} value={siteProtocol} onChange={e => setSiteProtocol(e.target.value)}>
            <option value="https">https://</option>
            <option value="http">http://</option>
          </select>
          <input type="text" className={'vs-input' + (errors.site_hostname ? ' err' : '')} style={{ borderRadius: '0 8px 8px 0', borderLeft: 'none' }}
            value={siteHostname} onChange={e => setSiteHostname(stripToHost(e.target.value))} placeholder="stream.yourdomain.com" />
        </div>
        {errors.site_hostname && <p className="vs-hint err">{errors.site_hostname}</p>}
      </div>
      <div className="vs-field-row" style={{ maxWidth: 420 }}>
        <div className="vs-field">
          <label className="vs-label">Session inactivity timeout (days)</label>
          <input type="text" inputMode="numeric" className={'vs-input' + (errors.session_inactivity_days ? ' err' : '')}
            value={sessionInactivityDays} onChange={e => setSessionInactivityDays(e.target.value)} onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setSessionInactivityDays)} />
          {errors.session_inactivity_days && <p className="vs-hint err">{errors.session_inactivity_days}</p>}
        </div>
        <div className="vs-field">
          <label className="vs-label">Session max lifetime (days)</label>
          <input type="text" inputMode="numeric" className={'vs-input' + (errors.session_max_days ? ' err' : '')}
            value={sessionMaxDays} onChange={e => setSessionMaxDays(e.target.value)} onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setSessionMaxDays)} />
          {errors.session_max_days && <p className="vs-hint err">{errors.session_max_days}</p>}
        </div>
      </div>
      <div className="vs-field" style={{ maxWidth: 320 }}>
        <label className="vs-label">Default role</label>
        <select className={'vs-select' + (errors.registration_default_role ? ' err' : '')} value={registrationDefaultRole}
          onChange={e => { setRegistrationDefaultRole(e.target.value); setErrors(prev => { if (!prev.registration_default_role) return prev; const n = { ...prev }; delete n.registration_default_role; return n; }); }}>
          <option value="">No access</option>
          {filteredRoles.map(r => {
            const isProtected = r.permission_level <= (user?.permission_level ?? 0);
            return <option key={r.role_id} value={r.role_id}>{r.role_name}{isProtected ? ' (current)' : ''}</option>;
          })}
        </select>
        <p className="vs-hint">Fallback role reported to the SSO — used for new users and when a user’s role is removed. “No access” means such users cannot sign in.</p>
      </div>
      <VsSaveBar visible={isDirty} busy={saving} items={generalItems} invalid={hasErrors}
        invalidNote="Fix the highlighted fields to save." onSave={() => guardAction(handleSaveGeneral)} onDiscard={discardGeneral} saveLabel="Save" />
    </>
  );

  const profileTable = (profiles, setName, setter) => (
    <div className="vs-st-tbl">
      <div className="vs-st-th">
        <span style={{ flex: '1.2', minWidth: 0 }}>Name</span>
        <span style={{ flex: 1 }}>Resolution</span>
        <span style={{ flex: 1 }}>Bitrate</span>
        <span style={{ flex: '0 0 60px' }}>Max FPS</span>
        <span style={{ flex: '0 0 54px' }}>GOP</span>
        <span style={{ flex: '0 0 64px' }} />
      </div>
      {profiles.map((p, idx) => (
        <div className="vs-st-tr" key={p.profile_id || `${setName}-${idx}`}>
          <span style={{ flex: '1.2', minWidth: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          <span style={{ flex: 1, color: '#6b7280' }}>{p.width}×{p.height}</span>
          <span style={{ flex: 1, color: '#6b7280' }}>{p.video_bitrate_kbps} kbps</span>
          <span style={{ flex: '0 0 60px', color: '#6b7280' }}>{p.fps_limit} fps</span>
          <span style={{ flex: '0 0 54px', color: '#6b7280' }}>{p.gop_seconds}</span>
          <span style={{ flex: '0 0 64px', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="vs-ico-btn" title="Edit" onClick={() => { setEditingProfileTarget({ set: setName, idx }); setShowProfileModal(true); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
            {!p.is_system_profile && (
              <button className="vs-ico-btn dg" title="Delete" onClick={async () => {
                if (!await confirm({ title: 'Delete profile?', message: 'This removes the transcoding profile from this set.', confirmLabel: 'Delete', danger: true })) return;
                setter(prev => prev.filter((_, i) => i !== idx));
              }}><TrashIcon /></button>
            )}
          </span>
        </div>
      ))}
      {profiles.length === 0 && <div className="vs-st-empty">No profiles configured</div>}
    </div>
  );

  const renderTranscoding = () => (
    <>
      <h3 className="vs-set-h">Transcoding</h3>
      <p className="vs-set-sub">Site-wide encoding profiles. Courses choose between the default and enhanced sets via a per-course toggle, or override entirely with custom profiles.</p>

      <label className="vs-label" style={{ marginBottom: 8 }}>Default quality profiles</label>
      {profileTable(defaultProfiles, 'default', setDefaultProfiles)}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 24 }}>
        <button className="vs-btn" onClick={() => { setEditingProfileTarget({ set: 'default', idx: null }); setShowProfileModal(true); }}>Add profile</button>
        <button className="vs-btn vs-btn-primary" disabled={savingDefault || JSON.stringify(defaultProfiles) === originalTranscoding.current.defaultProfiles} onClick={() => guardAction(() => saveTranscodingSet('default'))}>
          {savingDefault ? 'Saving…' : 'Save default profiles'}
        </button>
      </div>

      <label className="vs-label" style={{ marginBottom: 4 }}>Enhanced quality profiles</label>
      <p className="vs-set-sub" style={{ marginBottom: 8 }}>Higher-bitrate set (1440p / 1080p / 720p). Courses opt in via the per-course toggle.</p>
      {profileTable(enhancedProfiles, 'enhanced', setEnhancedProfiles)}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 24 }}>
        <button className="vs-btn" onClick={() => { setEditingProfileTarget({ set: 'enhanced', idx: null }); setShowProfileModal(true); }}>Add profile</button>
        <button className="vs-btn vs-btn-primary" disabled={savingEnhanced || JSON.stringify(enhancedProfiles) === originalTranscoding.current.enhancedProfiles} onClick={() => guardAction(() => saveTranscodingSet('enhanced'))}>
          {savingEnhanced ? 'Saving…' : 'Save enhanced profiles'}
        </button>
      </div>

      <label className="vs-label" style={{ marginBottom: 4 }}>Audio settings</label>
      <div className="vs-field" style={{ maxWidth: 280, marginTop: 8 }}>
        <label className="vs-label">Audio bitrate (kbps)</label>
        <input type="text" inputMode="numeric" className={'vs-input' + (transcodingTouched.audioBitrateKbps && transcodingErrors.audioBitrateKbps ? ' err' : '')}
          value={audioBitrateKbps} onChange={e => setAudioBitrateKbps(e.target.value.replace(/\D/g, ''))} onKeyDown={handleDigitOnly} onPaste={handleDigitPaste(setAudioBitrateKbps)}
          onBlur={() => {
            setTranscodingTouched(t => ({ ...t, audioBitrateKbps: true }));
            const v = parseInt(audioBitrateKbps, 10);
            setTranscodingErrors(e => { const n = { ...e }; if (!Number.isInteger(v) || v < 128 || v > 320) n.audioBitrateKbps = 'Must be an integer between 128 and 320'; else delete n.audioBitrateKbps; return n; });
          }} />
        <p className={'vs-hint' + (transcodingTouched.audioBitrateKbps && transcodingErrors.audioBitrateKbps ? ' err' : '')}>
          {transcodingTouched.audioBitrateKbps && transcodingErrors.audioBitrateKbps ? transcodingErrors.audioBitrateKbps : 'Site-wide AAC-LC bitrate for all transcoded videos. Range 128–320.'}
        </p>
      </div>
      <p className="vs-set-sub" style={{ margin: '10px 0 8px' }}>Audio normalization is enabled by default for new courses. Individual courses can disable it.</p>
      <div className="vs-field-row" style={{ maxWidth: 480 }}>
        <div className="vs-field">
          <label className="vs-label">Target loudness (LUFS)</label>
          <input type="text" inputMode="numeric" className={'vs-input' + (transcodingTouched.target && transcodingErrors.target ? ' err' : '')}
            value={audioNormTarget} onChange={e => setAudioNormTarget(e.target.value.replace(/[^0-9.-]/g, ''))}
            onBlur={() => { setTranscodingTouched(t => ({ ...t, target: true })); const v = parseFloat(audioNormTarget); setTranscodingErrors(e => { const n = { ...e }; if (isNaN(v) || v < -50 || v > 0) n.target = 'Must be -50 to 0'; else delete n.target; return n; }); }} />
          {transcodingTouched.target && transcodingErrors.target && <p className="vs-hint err">{transcodingErrors.target}</p>}
        </div>
        <div className="vs-field">
          <label className="vs-label">True peak ceiling (dBFS)</label>
          <input type="text" inputMode="numeric" className={'vs-input' + (transcodingTouched.peak && transcodingErrors.peak ? ' err' : '')}
            value={audioNormPeak} onChange={e => setAudioNormPeak(e.target.value.replace(/[^0-9.-]/g, ''))}
            onBlur={() => { setTranscodingTouched(t => ({ ...t, peak: true })); const v = parseFloat(audioNormPeak); setTranscodingErrors(e => { const n = { ...e }; if (isNaN(v) || v < -20 || v > 0) n.peak = 'Must be -20 to 0'; else delete n.peak; return n; }); }} />
          {transcodingTouched.peak && transcodingErrors.peak && <p className="vs-hint err">{transcodingErrors.peak}</p>}
        </div>
        <div className="vs-field">
          <label className="vs-label">Max upward gain (dB)</label>
          <input type="text" inputMode="numeric" className={'vs-input' + (transcodingTouched.maxGain && transcodingErrors.maxGain ? ' err' : '')}
            value={audioNormMaxGain} onChange={e => setAudioNormMaxGain(e.target.value.replace(/[^0-9.-]/g, ''))}
            onBlur={() => { setTranscodingTouched(t => ({ ...t, maxGain: true })); const v = parseFloat(audioNormMaxGain); setTranscodingErrors(e => { const n = { ...e }; if (isNaN(v) || v < 0 || v > 40) n.maxGain = 'Must be 0 to 40'; else delete n.maxGain; return n; }); }} />
          {transcodingTouched.maxGain && transcodingErrors.maxGain && <p className="vs-hint err">{transcodingErrors.maxGain}</p>}
        </div>
      </div>
      <button className="vs-btn vs-btn-primary" style={{ marginTop: 4 }}
        disabled={savingDefault || Object.keys(transcodingErrors).length > 0 || (
          audioNormTarget === originalTranscoding.current.target && audioNormPeak === originalTranscoding.current.peak
          && audioNormMaxGain === originalTranscoding.current.maxGain && audioBitrateKbps === originalTranscoding.current.audioBitrateKbps)}
        onClick={() => guardAction(saveAudioSettings)}>
        {savingDefault ? 'Saving…' : 'Save audio settings'}
      </button>
    </>
  );

  const renderCloudflare = () => (
    <>
      <h3 className="vs-set-h">Cloudflare</h3>
      <p className="vs-set-sub">Signs playback URLs with HMAC-SHA256 for Cloudflare WAF token authentication.</p>
      <div className="vs-toggle" style={{ maxWidth: 480, marginBottom: 18 }}>
        <div className="vs-toggle-lbl">
          <label className="vs-label">HMAC validation</label>
          <p className="vs-hint" style={{ marginTop: 0 }}>{hmacEnabled ? 'Enabled' : 'Disabled'}</p>
        </div>
        <label className="vs-switch">
          <input type="checkbox" checked={hmacEnabled} onChange={() => guardAction(handleToggleHmac)} />
          <span className="vs-switch-slider" />
        </label>
      </div>
      <div className="vs-field" style={{ maxWidth: 480 }}>
        <label className="vs-label">HMAC secret key</label>
        <div><button type="button" className="vs-btn vs-btn-primary" onClick={() => guardAction(handleGenerateHmac)} disabled={!hmacEnabled}>{hmacHasKey ? 'Generate new key' : 'Initialize key'}</button></div>
        <p className="vs-hint">{hmacHasKey ? 'Generates a new key and shows it once. Changing the key immediately invalidates all active playback sessions.' : 'Generate a secret key to get started with HMAC validation.'}</p>
      </div>
      <div className="vs-field" style={{ maxWidth: 480 }}>
        <label className="vs-label">Token validity for client (seconds)</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="number" className="vs-input" value={hmacTokenValidity} onChange={e => setHmacTokenValidity(e.target.value)} min="600" step="1" style={{ maxWidth: 200 }} disabled={!hmacEnabled} />
          <button type="button" className="vs-btn vs-btn-primary" onClick={() => guardAction(handleSaveHmacValidity)} disabled={hmacSaving || !hmacEnabled}>{hmacSaving ? 'Saving…' : 'Save'}</button>
        </div>
        <p className="vs-hint">Tells the player when to proactively refresh the token (refreshes at half this value). Must be ≤ the lifetime configured in your Cloudflare WAF rule. Default: 600 seconds.</p>
      </div>
    </>
  );

  const wkStatus = (status) => {
    const s = status || 'active';
    const label = s.charAt(0).toUpperCase() + s.slice(1);
    const tone = s === 'active' ? 'g' : s === 'paused' ? 'y' : 'r';
    return <span className={'vs-st-pill ' + tone}>{label}</span>;
  };
  const renderWorkers = () => (
    <>
      <h3 className="vs-set-h">Worker access keys</h3>
      <p className="vs-set-sub">Credentials transcoding workers use to authenticate. Generated once, shown once.</p>
      <div style={{ marginBottom: 12 }}><button type="button" className="vs-btn vs-btn-primary" onClick={() => guardAction(handleOpenGenerateModal)}>Generate new key</button></div>
      <div className="vs-st-tbl">
        <div className="vs-st-th">
          <span style={{ flex: '1.2', minWidth: 0 }}>Key ID</span>
          <span style={{ flex: 1 }}>Label</span>
          <span style={{ flex: '0 0 84px' }}>Status</span>
          <span style={{ flex: 1 }}>Last used</span>
          <span style={{ flex: '0 0 200px' }} />
        </div>
        {workerKeys.map(wk => {
          const status = wk.status || 'active';
          return (
            <div className="vs-st-tr" key={wk.key_id}>
              <span style={{ flex: '1.2', minWidth: 0, fontFamily: 'monospace', fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wk.key_id}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wk.label || '—'}</span>
              <span style={{ flex: '0 0 84px' }}>{wkStatus(status)}</span>
              <span style={{ flex: 1, color: '#6b7280' }}>{wk.last_used_at ? new Date(wk.last_used_at).toLocaleString() : 'Never'}</span>
              <span style={{ flex: '0 0 200px', display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {status === 'active' && <button className="vs-btn vs-btn-sm" onClick={() => guardAction(() => handlePauseWorkerKey(wk.key_id))}>Pause</button>}
                {status === 'paused' && <button className="vs-btn vs-btn-sm" onClick={() => guardAction(() => handleResumeWorkerKey(wk.key_id))}>Resume</button>}
                {status === 'deactivated' && <button className="vs-btn vs-btn-sm" onClick={() => guardAction(() => handleOpenReactivateModal(wk.key_id))}>Reactivate</button>}
                {status !== 'deactivated' && <button className="vs-btn vs-btn-sm" onClick={() => guardAction(() => handleOpenRenameModal(wk))}>Rename</button>}
                <button className="vs-ico-btn dg" title="Delete" onClick={() => guardAction(() => handleDeleteWorkerKey(wk.key_id))}><TrashIcon /></button>
              </span>
            </div>
          );
        })}
        {workerKeys.length === 0 && <div className="vs-st-empty">No worker keys</div>}
      </div>
    </>
  );

  const renderPlayback = () => (
    <>
      <h3 className="vs-set-h">Playback data</h3>
      <p className="vs-set-sub">Per-course and per-student playback stats now live on each course page and on each user’s edit page. This is the site-wide reset.</p>
      <button type="button" className="vs-btn vs-btn-danger" onClick={() => guardAction(handleClearPlaybackStats)} disabled={clearingStats}>{clearingStats ? 'Clearing…' : 'Reset all playback stats'}</button>
      <p className="vs-set-sub" style={{ marginTop: 10 }}>Permanently deletes every user’s watch history <strong>and</strong> resume positions across all courses. This can’t be undone.</p>
    </>
  );

  const renderSite = () => {
    // A slice pane still loading its first fetch shows the plain "Loading…" card.
    if (SLICE_PANES.has(active) && !loaded.has(active)) return <CardLoading />;
    switch (active) {
      case 'transcoding': return renderTranscoding();
      case 'cloudflare': return renderCloudflare();
      case 'workers': return renderWorkers();
      case 'playback': return renderPlayback();
      default: return renderGeneral();
    }
  };

  return (
    <div className="vs-set-page">
      <div className="vs-set-head">
        <h1 className="vs-set-title">Settings</h1>
        <p className="vs-set-psub">Site configuration, integrations, and multi-factor policy.</p>
      </div>

      <div className="vs-set">
        <nav className="vs-set-rail">
          {SECTIONS.map(railItem)}
        </nav>
        {/* The MFA + SSO panes own their step-up guard; the site panes share this
            page's guard — a lapsed window turns the pane area into the "verify to
            continue" reminder, right of the rail, across all of them. */}
        <div className="vs-set-pane" ref={paneRef}>
          {activeIsMfa
            ? <MfaSettingsSections onDirty={setMfaDirty} onLock={setMfaLocked} />
            : activeIsSso
              ? <SsoSettings />
              : (blocked && SLICE_PANES.has(active))
                ? <StepUpBlock onVerify={verify} />
                : renderSite()}
        </div>
      </div>

      <ProfileEditModal
        isOpen={showProfileModal}
        profile={(() => {
          if (!editingProfileTarget || editingProfileTarget.idx === null) return null;
          const src = editingProfileTarget.set === 'enhanced' ? enhancedProfiles : defaultProfiles;
          return src[editingProfileTarget.idx];
        })()}
        onClose={() => { setShowProfileModal(false); setEditingProfileTarget(null); }}
        onSave={(profile) => {
          if (!editingProfileTarget) return;
          const setter = editingProfileTarget.set === 'enhanced' ? setEnhancedProfiles : setDefaultProfiles;
          const stamped = { ...profile, is_enhanced_profile: editingProfileTarget.set === 'enhanced' ? 1 : 0 };
          if (editingProfileTarget.idx !== null) setter(prev => prev.map((p, i) => i === editingProfileTarget.idx ? stamped : p));
          else setter(prev => [...prev, stamped]);
          setShowProfileModal(false); setEditingProfileTarget(null);
        }}
      />

      {/* HMAC Key Generated */}
      {generatedHmacKey && (
        <div className="vs-scrim" onClick={handleCloseHmacModal}>
          <div className="vs-modal vs-modal-wide" onClick={e => e.stopPropagation()}>
            <div className="vs-modal-head"><h3 className="vs-modal-title">HMAC secret key generated</h3></div>
            <div className="vs-modal-body">
              <div className="vs-field">
                <label className="vs-label">HMAC secret key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" className="vs-input" readOnly value={generatedHmacKey} onClick={e => e.target.select()} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  <button type="button" className="vs-btn" onClick={handleCopyHmacKey}>{hmacKeyCopyLabel}</button>
                </div>
              </div>
              <p className="vs-modal-warn">Save this key now — it won’t be shown again.</p>
              <div className="vs-field" style={{ marginTop: 14 }}>
                <label className="vs-label">Cloudflare WAF rule — playback (manifest + segments)</label>
                <textarea className="vs-textarea vs-mono-area" readOnly value={buildWafRule(generatedHmacKey).playback} onClick={e => e.target.select()} style={{ minHeight: 150 }} />
                <div style={{ textAlign: 'right', marginTop: 4 }}><span onClick={handleCopyPlaybackRule} className="vs-copylink">{playbackRuleCopyLabel}</span></div>
              </div>
              <div className="vs-field">
                <label className="vs-label">Cloudflare WAF rule — poster (per-file)</label>
                <textarea className="vs-textarea vs-mono-area" readOnly value={buildWafRule(generatedHmacKey).poster} onClick={e => e.target.select()} style={{ minHeight: 120 }} />
                <div style={{ textAlign: 'right', marginTop: 4 }}><span onClick={handleCopyPosterRule} className="vs-copylink">{posterRuleCopyLabel}</span></div>
              </div>
              <p className="vs-hint">Paste each as a <strong>separate</strong> Cloudflare WAF custom rule. Set the action to <strong>Block</strong> with a 403 response for both.</p>
            </div>
            <div className="vs-modal-foot"><button type="button" className="vs-btn vs-btn-primary" onClick={handleCloseHmacModal}>OK</button></div>
          </div>
        </div>
      )}

      {/* Generate Worker Key */}
      {generateModalOpen && (
        <div className="vs-scrim" onClick={() => !generatingKey && setGenerateModalOpen(false)}>
          <div className="vs-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="vs-modal-head"><h3 className="vs-modal-title">Generate worker key</h3><button type="button" className="vs-modal-x" onClick={() => !generatingKey && setGenerateModalOpen(false)}><CloseIcon /></button></div>
            <div className="vs-modal-body">
              <div className="vs-field">
                <label className="vs-label">Label (optional)</label>
                <input className="vs-input" value={generateLabel} onChange={e => setGenerateLabel(e.target.value)} placeholder="Transcoding Server 1" disabled={generatingKey} autoFocus />
              </div>
            </div>
            <div className="vs-modal-foot">
              <button type="button" className="vs-btn" onClick={() => setGenerateModalOpen(false)} disabled={generatingKey}>Cancel</button>
              <button type="button" className="vs-btn vs-btn-primary" onClick={handleConfirmGenerate} disabled={generatingKey}>{generatingKey ? 'Generating…' : 'Continue'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Worker Key */}
      {renameModalState && (
        <div className="vs-scrim" onClick={() => !renameSaving && setRenameModalState(null)}>
          <div className="vs-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="vs-modal-head"><h3 className="vs-modal-title">Rename worker key</h3><button type="button" className="vs-modal-x" onClick={() => !renameSaving && setRenameModalState(null)}><CloseIcon /></button></div>
            <div className="vs-modal-body">
              <div className="vs-field">
                <label className="vs-label">Label</label>
                <input className="vs-input" value={renameLabel} onChange={e => setRenameLabel(e.target.value)} placeholder="(leave blank to clear)" disabled={renameSaving} autoFocus />
              </div>
            </div>
            <div className="vs-modal-foot">
              <button type="button" className="vs-btn" onClick={() => setRenameModalState(null)} disabled={renameSaving}>Cancel</button>
              <button type="button" className="vs-btn vs-btn-primary" onClick={handleConfirmRename} disabled={renameSaving || renameLabel.trim() === (renameModalState.originalLabel || '').trim()}>{renameSaving ? 'Saving…' : 'Continue'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Reactivate Worker Key */}
      {reactivateModalState && (
        <div className="vs-scrim" onClick={() => !reactivateSaving && setReactivateModalState(null)}>
          <div className="vs-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="vs-modal-head"><h3 className="vs-modal-title">Reactivate worker key</h3><button type="button" className="vs-modal-x" onClick={() => !reactivateSaving && setReactivateModalState(null)}><CloseIcon /></button></div>
            <div className="vs-modal-body">
              <p style={{ margin: 0 }}>Reactivating will <strong>rotate the worker key secret</strong>. The previous secret will no longer authenticate — any worker still using it must be updated with the new secret.</p>
              <p className="vs-hint" style={{ marginTop: 12 }}>The new secret will be displayed once after you click Continue. Make sure to copy it before closing the next dialog.</p>
            </div>
            <div className="vs-modal-foot">
              <button type="button" className="vs-btn" onClick={() => setReactivateModalState(null)} disabled={reactivateSaving}>Cancel</button>
              <button type="button" className="vs-btn vs-btn-primary" onClick={handleConfirmReactivate} disabled={reactivateSaving}>{reactivateSaving ? 'Rotating…' : 'Continue'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Worker Key Created */}
      {newWorkerKey && (
        <div className="vs-scrim" onClick={handleCloseWorkerKeyModal}>
          <div className="vs-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="vs-modal-head"><h3 className="vs-modal-title">Worker key created</h3></div>
            <div className="vs-modal-body">
              <div className="vs-field">
                <label className="vs-label">Key ID</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" className="vs-input" readOnly value={newWorkerKey.keyId} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  <button type="button" className="vs-btn" onClick={() => copyField(newWorkerKey.keyId, setWkKeyIdCopyLabel)}>{wkKeyIdCopyLabel}</button>
                </div>
              </div>
              <div className="vs-field">
                <label className="vs-label">Secret</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="text" className="vs-input" readOnly value={newWorkerKey.secret} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                  <button type="button" className="vs-btn" onClick={() => copyField(newWorkerKey.secret, setWkSecretCopyLabel)}>{wkSecretCopyLabel}</button>
                </div>
              </div>
              <p className="vs-modal-warn">Save this secret now — it won’t be shown again.</p>
            </div>
            <div className="vs-modal-foot"><button type="button" className="vs-btn vs-btn-primary" onClick={handleCloseWorkerKeyModal}>OK</button></div>
          </div>
        </div>
      )}
      {/* The step-up challenge modal + error cards are rendered globally by the
          StepUpProvider — no per-page challenge UI here anymore. */}
    </div>
  );
}
