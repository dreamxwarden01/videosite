import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '../api';
import { useToast } from '../context/ToastContext';
import useStepupGuard from '../hooks/useStepupGuard';
import StepUpBlock from './StepUpBlock';
import { loadDraft, clearDraft } from '../stepupDraft';
import { stripToHost, isValidHost, splitHostUrl, joinHostUrl } from '../utils/hostname';

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
);

// Editable = external references videosite points at. Derived = videosite's own
// endpoints (from the site hostname), shown view-only to register at the SSO.
// type 'host' → protocol dropdown + bare host[:port] input (no scheme/path/
// space); type 'id' → free token with spaces stripped.
const EDITABLE_FIELDS = [
  { k: 'issuer', label: 'SSO issuer', type: 'host' },
  { k: 'client_id', label: 'Client ID', type: 'id' },
  { k: 'account_portal', label: 'Account portal URL', hint: '“manage your account” target', type: 'host', full: true },
];
const DERIVED_FIELDS = [
  { k: 'callback', label: 'Callback URL' },
  { k: 'backchannel', label: 'Back-channel events URL' },
  { k: 'jwks', label: 'Client JWKS URL' },
];
// Survives a step-up redirect that fires mid-modal (CSR generated / cert being
// pasted), so the callback restores the SAME CSR instead of regenerating a key.
const MTLS_DRAFT = 'sso:mtls';

// Server sends ISO UTC; render in the viewer's zone like "Sep 7, 2026 at
// 1:41:47 AM PDT" — Intl falls back to GMT+N where the zone has no short name.
const fmtTs = (s) => {
  try { return new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }); }
  catch { return s; }
};
const CERT_ERR = {
  expired: 'This certificate is already expired. Submit a current certificate.',
  key_mismatch: "Certificate doesn't match the generated key. Submit the CSR shown above.",
  parse_failed: "That doesn't look like a valid PEM certificate.",
  no_key: 'No key on file — generate a CSR first.',
  no_cert: 'Paste the issued certificate.',
};

export default function SsoSettings() {
  const { showToast } = useToast();
  // The SSO connection + mTLS ride the 'settings' step-up scenario (they're gated
  // server-side too). Reads route through guardFetch (a lapsed RW window blocks the
  // pane); writes pre-check via guardAction.
  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('settings');
  const [config, setConfig] = useState(null);
  const [orig, setOrig] = useState({});
  const [savingConfig, setSavingConfig] = useState(false);
  const [mtls, setMtls] = useState(null);
  const [enforcePending, setEnforcePending] = useState(false);
  const [savingEnforce, setSavingEnforce] = useState(false);

  const [modal, setModal] = useState(null); // null | 'setup' | 'renew' | 'reset'
  const [resetBusy, setResetBusy] = useState(false);
  const [cn, setCn] = useState('');
  const [csr, setCsr] = useState('');
  const [certPaste, setCertPaste] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installErr, setInstallErr] = useState(null);
  const [genBusy, setGenBusy] = useState(false);

  // Transient "Copied!" feedback, keyed by which button was clicked.
  const [copiedKey, setCopiedKey] = useState(null);
  const copy = (text, key) => {
    navigator.clipboard.writeText(text || '').then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    }).catch(() => {});
  };

  const loadMtls = useCallback(async () => {
    const { data, ok } = await guardFetch('/api/sso/mtls');
    if (ok) { setMtls(data); setEnforcePending(!!data.enforce); }
  }, [guardFetch]);

  useEffect(() => {
    (async () => {
      const c = await guardFetch('/api/sso/config');
      if (c.ok) { setConfig(c.data); setOrig(c.data); }
      await loadMtls();
    })();
  }, [guardFetch, loadMtls]);

  // Restore an in-progress mTLS setup/renew modal after returning from a step-up
  // redirect. Rehydrating `csr` directly re-shows the CSR without calling
  // generateCsr again (which would mint a new key and orphan the submitted one).
  useEffect(() => {
    const d = loadDraft(MTLS_DRAFT);
    if (!d) return;
    setModal(d.modal || null); setCn(d.cn || ''); setCsr(d.csr || ''); setCertPaste(d.certPaste || '');
    // Keep the draft on an ERROR return: the error card's "Try again" is a fresh
    // redirect that doesn't re-save, so the draft must survive to the eventual
    // success. A clean ('done'/'cancel'/no-marker) return consumes it.
    const o = new URLSearchParams(window.location.search).get('stepup');
    if (o !== 'account' && o !== 'failed' && o !== 'error') clearDraft(MTLS_DRAFT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- connection ---
  const errors = {};
  if (config) {
    for (const f of EDITABLE_FIELDS) {
      const v = (config[f.k] || '').trim();
      if (f.type === 'id') {
        if (!v) errors[f.k] = 'Required';
        else if (/\s/.test(v)) errors[f.k] = 'Cannot contain spaces';
      } else {
        const host = splitHostUrl(v).host;
        if (!host) errors[f.k] = 'Required';
        else if (!isValidHost(host)) errors[f.k] = 'Enter a valid hostname or IP address (no spaces, slashes, or path)';
      }
    }
  }
  const hasErrors = Object.keys(errors).length > 0;
  const isDirty = config && EDITABLE_FIELDS.some((f) => config[f.k] !== orig[f.k]);

  const saveConfig = async () => {
    setSavingConfig(true);
    const body = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f.k, config[f.k]]));
    const { ok, status, data } = await apiFetch('/api/sso/config', { method: 'PUT', body });
    setSavingConfig(false);
    if (ok) { setOrig(config); showToast('SSO connection saved.', 'success'); }
    else if (status === 422) showToast('Some fields are invalid.');
    else if (data?.code !== 'step_up_required') showToast(data?.error || 'Failed to save.');
  };

  // One-click safe: the old key stays published for overlap and the SSO
  // re-fetches our JWKS when it sees the new kid.
  const [rotating, setRotating] = useState(false);
  const rotateKey = async () => {
    setRotating(true);
    const { ok, data } = await apiFetch('/api/sso/rotate-client-key', { method: 'POST' });
    setRotating(false);
    if (ok) { setConfig((c) => ({ ...c, client_key: data })); setOrig((c) => ({ ...c, client_key: data })); showToast('Client key rotated.', 'success'); }
    else if (data?.code !== 'step_up_required') showToast('Failed to rotate the client key.');
  };

  // --- mTLS ---
  const openSetup = () => { setModal('setup'); setCn(''); setCsr(''); setCertPaste(''); setInstallErr(null); };
  const openRenew = () => { setModal('renew'); setCertPaste(''); setInstallErr(null); };

  const generateCsr = async () => {
    setGenBusy(true);
    const { ok, data } = await apiFetch('/api/sso/mtls/csr', { method: 'POST', body: { cn } });
    setGenBusy(false);
    if (ok) { setCsr(data.csr); setCn(data.cn); } else if (data?.code !== 'step_up_required') showToast('Failed to generate CSR.');
  };

  const installCert = async () => {
    setInstalling(true); setInstallErr(null);
    const { ok, status, data } = await apiFetch('/api/sso/mtls/cert', { method: 'POST', body: { cert: certPaste } });
    setInstalling(false);
    // A valid cert auto-enables enforcement server-side (setup or renew); loadMtls() reflects it.
    if (ok) { setModal(null); await loadMtls(); showToast('Certificate installed — mTLS enabled.', 'success'); }
    else if (status === 422) setInstallErr(CERT_ERR[data?.error] || 'Certificate rejected.');
    else if (data?.code !== 'step_up_required') showToast('Failed to install certificate.');
  };

  // Applies immediately on flip — the knob is optimistic and loadMtls() snaps it
  // back if the save fails.
  const toggleEnforce = async (enabled) => {
    setEnforcePending(enabled);
    setSavingEnforce(true);
    const { ok, status, data } = await apiFetch('/api/sso/mtls/enforce', { method: 'PUT', body: { enabled } });
    setSavingEnforce(false);
    if (ok) { await loadMtls(); showToast(enabled ? 'mTLS enforcement enabled.' : 'mTLS enforcement disabled.', 'success'); }
    else if (data?.code === 'step_up_required') { await loadMtls(); }
    else { showToast(status === 422 && data?.error === 'expired' ? 'Renew the certificate before enabling.' : 'Failed to save.'); await loadMtls(); }
  };

  // Confirmed in a styled modal (like every other action on this page).
  const resetCert = async () => {
    setResetBusy(true);
    const { ok, data } = await apiFetch('/api/sso/mtls', { method: 'DELETE' });
    setResetBusy(false);
    setModal(null);
    if (ok) { await loadMtls(); showToast('Certificate reset.', 'success'); }
    else if (data?.code !== 'step_up_required') showToast('Failed to reset.');
  };

  const expired = mtls?.state === 'configured' && mtls.expired;
  // vs- pill tones: g green, y yellow, r red, n neutral.
  const pill = !mtls ? { c: 'n', t: '…' }
    : mtls.state === 'not_configured' ? { c: 'n', t: 'Not configured' }
    : expired ? { c: 'r', t: 'Expired' }
    : mtls.enforce ? { c: 'g', t: 'Enabled' } : { c: 'y', t: 'Disabled' };

  const subhead = { marginTop: 24, marginBottom: 10 };

  // A lapsed RW window blocks the whole SSO pane — the "verify to continue" reminder
  // fills the pane area, same as the other settings panes.
  if (blocked) return <StepUpBlock onVerify={verify} />;

  return (
    <>
      {/* ===== Single sign-on ===== */}
      <div className="vs-set-h-row">
        <h3 className="vs-set-h">Single sign-on (DreamSSO)</h3>
        <span className="vs-st-pill g">Connected</span>
      </div>
      <div className="vs-warn">
        Editing these can break sign-in for everyone until the matching change is made at the SSO. Change them only if you know exactly what you’re doing.
      </div>
      {!config ? <p className="vs-hint">Loading…</p> : (
        <>
          {EDITABLE_FIELDS.map((f) => {
            const bad = errors[f.k] ? ' err' : '';
            return (
              <div className="vs-field" style={{ maxWidth: f.full ? 460 : 420 }} key={f.k}>
                <label className="vs-label">{f.label}{f.hint && <span style={{ fontWeight: 400, color: '#9ca3af' }}> ({f.hint})</span>}</label>
                {f.type === 'host' ? (() => {
                  const { protocol, host } = splitHostUrl(config[f.k] || '');
                  return (
                    <div style={{ display: 'flex' }}>
                      <select className="vs-select" style={{ width: 96, borderRadius: '8px 0 0 8px', flexShrink: 0 }}
                        value={protocol} onChange={(e) => setConfig({ ...config, [f.k]: joinHostUrl(e.target.value, host) })}>
                        <option value="https">https://</option>
                        <option value="http">http://</option>
                      </select>
                      <input className={'vs-input' + bad} style={{ borderRadius: '0 8px 8px 0', borderLeft: 'none', fontFamily: 'monospace', fontSize: 12.5 }}
                        value={host} placeholder="sso.yourdomain.com"
                        onChange={(e) => setConfig({ ...config, [f.k]: joinHostUrl(protocol, stripToHost(e.target.value)) })} />
                    </div>
                  );
                })() : (
                  <input className={'vs-input' + bad} style={{ fontFamily: 'monospace', fontSize: 12.5 }} value={config[f.k] || ''}
                    onChange={(e) => setConfig({ ...config, [f.k]: e.target.value.replace(/\s+/g, '') })} />
                )}
                {errors[f.k] && <p className="vs-hint err">{errors[f.k]}</p>}
              </div>
            );
          })}
          <button className="vs-btn vs-btn-primary" disabled={savingConfig || hasErrors || !isDirty} onClick={() => guardAction(saveConfig)}>
            {savingConfig ? 'Saving…' : 'Save connection'}
          </button>

          <div className="vs-label" style={subhead}>videosite endpoints — register these at the SSO</div>
          {DERIVED_FIELDS.map((f) => (
            <div className="vs-field" style={{ maxWidth: 560 }} key={f.k}>
              <label className="vs-label">{f.label}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="vs-input" readOnly value={config[f.k] || ''} onClick={(e) => e.target.select()} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                <button type="button" className="vs-btn" onClick={() => copy(config[f.k], f.k)}>{copiedKey === f.k ? 'Copied!' : 'Copy'}</button>
              </div>
            </div>
          ))}

          <div className="vs-label" style={subhead}>Client signing key</div>
          <div className="vs-field" style={{ maxWidth: 560 }}>
            <label className="vs-label">Current key{config.client_key?.rotated_at ? ` (rotated ${fmtTs(config.client_key.rotated_at)})` : ''}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="vs-input" readOnly value={config.client_key?.kid || '—'} style={{ fontFamily: 'monospace', fontSize: 12 }} />
              <button type="button" className="vs-btn vs-btn-primary" disabled={rotating} onClick={() => guardAction(rotateKey)}>{rotating ? 'Rotating…' : 'Rotate'}</button>
            </div>
          </div>
        </>
      )}

      {/* ===== Service-to-service mTLS ===== */}
      <div className="vs-set-h-row" style={{ marginTop: 32 }}>
        <h3 className="vs-set-h">Service-to-service mTLS</h3>
        <span className={'vs-st-pill ' + pill.c}>{pill.t}</span>
      </div>
      <p className="vs-set-sub">
        A client certificate authenticates <b>all</b> of videosite’s server-to-server calls at the Cloudflare edge — the SSO back-channel, the email/worker routes, and anything added later.
      </p>
      {!mtls ? <p className="vs-hint">Loading…</p>
        : mtls.state === 'not_configured' ? (
          <button className="vs-btn vs-btn-primary" onClick={() => guardAction(openSetup)}>Set up mTLS</button>
        ) : (
          <>
            <div className="vs-st-tbl" style={{ maxWidth: 560, marginBottom: 16 }}>
              {[['Common name', mtls.cn || '—'], ['Issuer', mtls.issuer || '—'], ['Not valid before', fmtTs(mtls.not_before)], ['Not valid after', fmtTs(mtls.not_after)]].map(([k, v], i) => (
                <div className="vs-st-tr" key={k} style={i === 0 ? { borderTop: 'none' } : undefined}>
                  <span style={{ flex: '0 0 150px', color: '#6b7280' }}>{k}</span>
                  <span style={{ flex: 1, minWidth: 0, color: (k === 'Not valid after' && expired) ? '#c5221f' : undefined }}>{v}</span>
                </div>
              ))}
            </div>
            {expired && <div className="vs-warn">This certificate has expired. Renew it (the private key is kept) to re-enable mTLS.</div>}
            <div style={{ marginBottom: 16 }}>
              <div className="vs-switch-inline">
                <span className="vs-label" style={{ margin: 0 }}>Enable mTLS</span>
                <label className="vs-switch">
                  <input type="checkbox" checked={enforcePending} disabled={expired || savingEnforce}
                    onChange={(e) => { const v = e.target.checked; guardAction(() => toggleEnforce(v)); }} />
                  <span className="vs-switch-slider" />
                </label>
              </div>
              <p className="vs-hint">Present the client certificate on all S2S calls. Applies immediately.</p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className={'vs-btn' + (expired ? ' vs-btn-primary' : '')} onClick={() => guardAction(openRenew)}>Renew certificate</button>
              <button className="vs-btn vs-btn-danger" onClick={() => guardAction(() => setModal('reset'))}>Reset certificate</button>
            </div>
          </>
        )}

      {/* ===== reset confirm modal ===== */}
      {modal === 'reset' && (
        <div className="vs-scrim" onClick={() => (resetBusy ? null : setModal(null))}>
          <div className="vs-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="vs-modal-head">
              <h3 className="vs-modal-title">Reset mTLS?</h3>
              <button type="button" className="vs-modal-x" onClick={() => setModal(null)} disabled={resetBusy}><CloseIcon /></button>
            </div>
            <div className="vs-modal-body">
              <p style={{ margin: 0 }}>
                This permanently deletes the certificate, private key, and CSR, and turns enforcement off.
                You’ll need to set it up again from scratch.
              </p>
            </div>
            <div className="vs-modal-foot">
              <button type="button" className="vs-btn" onClick={() => setModal(null)} disabled={resetBusy}>Cancel</button>
              <button type="button" className="vs-btn vs-btn-danger" onClick={resetCert} disabled={resetBusy}>{resetBusy ? 'Resetting…' : 'Reset mTLS'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== cert setup / renew modal ===== */}
      {(modal === 'setup' || modal === 'renew') && (
        <div className="vs-scrim" onClick={() => { if (!installing && !genBusy) setModal(null); }}>
          <div className="vs-modal vs-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="vs-modal-head">
              <h3 className="vs-modal-title">{modal === 'setup' ? 'Set up mTLS certificate' : 'Renew mTLS certificate'}</h3>
              <button type="button" className="vs-modal-x" onClick={() => setModal(null)} disabled={installing || genBusy}><CloseIcon /></button>
            </div>
            <div className="vs-modal-body">
              {modal === 'setup' && !csr && (
                <>
                  <div className="vs-field" style={{ maxWidth: 420 }}>
                    <label className="vs-label">Common name (optional)</label>
                    <input className="vs-input" style={{ fontFamily: 'monospace', fontSize: 12.5 }} value={cn}
                      onChange={(e) => setCn(e.target.value)} placeholder="Leave blank to auto-generate" />
                  </div>
                  <button className="vs-btn vs-btn-primary" disabled={genBusy}
                    onClick={() => guardAction(generateCsr, { draftKey: MTLS_DRAFT, draft: { modal, cn, csr, certPaste } })}>
                    {genBusy ? 'Generating…' : 'Generate key & CSR'}
                  </button>
                </>
              )}
              {modal === 'setup' && csr && (
                <div className="vs-field">
                  <label className="vs-label">Submit this CSR to Cloudflare (CN {cn})</label>
                  <textarea className="vs-textarea vs-mono-area" rows="4" readOnly value={csr} onClick={(e) => e.target.select()} />
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="vs-btn vs-btn-sm" onClick={() => copy(csr, 'csr')}>{copiedKey === 'csr' ? 'Copied!' : 'Copy CSR'}</button>
                  </div>
                </div>
              )}
              {(modal === 'renew' || csr) && (
                <div className="vs-field" style={{ marginTop: 16 }}>
                  <label className="vs-label">Paste the {modal === 'renew' ? 'renewed' : 'issued'} certificate (PEM — a full chain is fine, any order)</label>
                  <textarea className="vs-textarea vs-mono-area" rows="4" value={certPaste}
                    onChange={(e) => { setCertPaste(e.target.value); setInstallErr(null); }}
                    placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'} />
                  {installErr && <p className="vs-hint err">{installErr}</p>}
                </div>
              )}
            </div>
            <div className="vs-modal-foot">
              <button type="button" className="vs-btn" onClick={() => setModal(null)} disabled={installing || genBusy}>Cancel</button>
              <button type="button" className="vs-btn vs-btn-primary" disabled={installing || !certPaste.trim() || (modal === 'setup' && !csr)}
                onClick={() => guardAction(installCert, { draftKey: MTLS_DRAFT, draft: { modal, cn, csr, certPaste } })}>
                {installing ? 'Validating…' : 'Save certificate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
