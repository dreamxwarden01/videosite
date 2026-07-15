import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { apiGet, setStepUpHandler } from '../api';
import Avatar from '../components/Avatar';
import { saveDraft, clearDraft, clearAllDrafts } from '../stepupDraft';

// SSO step-up (sudo) for videosite. The SSO runs the actual challenge; this provider
// only prompts the user, launches the redirect ceremony (/auth/stepup/start), and
// handles the return marker (?stepup=<outcome>). Two entry points:
//   • reactive — a 403 step_up_required from any api call opens the challenge modal.
//   • pre-check — useStepUp().precheck() before opening a write modal / gated view.
const StepUpContext = createContext(null);

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="20" height="20">
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    <rect x="9.5" y="11.5" width="5" height="4" rx="1" stroke="#fff" strokeWidth="1.6" />
    <path d="M10.5 11.5v-1a1.5 1.5 0 0 1 3 0v1" stroke="#fff" strokeWidth="1.6" />
  </svg>
);
const ShieldXIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="26" height="26">
    <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" stroke="#b45309" strokeWidth="2" strokeLinejoin="round" />
    <path d="M9.5 10.5l5 5M14.5 10.5l-5 5" stroke="#b45309" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

// The outcome the callback tags onto returnTo, mapped to an error card. 'done' and
// 'cancel' are handled inline (toast / silent); the rest surface a card.
const ERROR_CARDS = {
  account: {
    title: 'That was a different account',
    message: 'You verified as a different account than the one you’re signed in with here. Verify again, or cancel.',
  },
  failed: {
    title: 'Verification didn’t complete',
    message: 'We couldn’t confirm a fresh identity check. Try again, or cancel.',
  },
  error: {
    title: 'Verification didn’t complete',
    message: 'Something went wrong finishing verification. Try again, or cancel.',
  },
};

export function StepUpProvider({ children }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [modal, setModal] = useState(null);     // { accepted } — challenge-required
  const [errCard, setErrCard] = useState(null); // 'account' | 'failed' | 'error'
  const [outcome, setOutcome] = useState(null); // last terminal outcome, for pages to read
  // The accepted method set for the current/last challenge (from the gate's 403 or a
  // pre-check). Carried into the redirect so the SSO prompts the right factor, and
  // reused by "Try again" on an error card.
  const acceptedRef = useRef(['totp', 'passkey']);
  // After the user cancels, don't let a REACTIVE 403 (e.g. a polled gated endpoint,
  // like the transcoding jobs poll) reopen the modal and nag them. The page's block
  // card + its Verify button (promptStepUp) is the re-entry; navigating also clears
  // the suppression. Explicit opens (promptStepUp/precheck) always win.
  const suppressRef = useRef(false);
  // A draft saved by a pre-check that opened the modal. It stays in sessionStorage
  // only if the user hits Continue (redirect); Cancel discards it, so a later fresh
  // mount never spuriously restores it.
  const pendingDraftKeyRef = useRef(null);

  const openChallenge = useCallback((accepted) => {
    const set = Array.isArray(accepted) && accepted.length ? accepted : ['totp', 'passkey'];
    acceptedRef.current = set;
    suppressRef.current = false;
    setModal({ accepted: set });
  }, []);

  const cancelModal = useCallback(() => {
    suppressRef.current = true;
    if (pendingDraftKeyRef.current) { clearDraft(pendingDraftKeyRef.current); pendingDraftKeyRef.current = null; }
    setModal(null);
  }, []);

  // Reactive: a 403 step_up_required opens the modal — unless the user just cancelled.
  useEffect(() => {
    setStepUpHandler((data) => { if (!suppressRef.current) openChallenge(data && data.accepted); });
    return () => setStepUpHandler(null);
  }, [openChallenge]);

  // A new page is a fresh chance to prompt — clear any cancel suppression on nav.
  useEffect(() => { suppressRef.current = false; }, [location.pathname]);

  // Launch the ceremony (Continue / Try again). returnTo = the current URL; the
  // ?stepup marker was already stripped on return, so it never accumulates.
  const beginStepUp = useCallback(() => {
    // Committing to the redirect — keep any pending draft in sessionStorage so the
    // page can restore its open modal on return.
    pendingDraftKeyRef.current = null;
    const returnTo = location.pathname + location.search;
    const required = (acceptedRef.current || ['totp', 'passkey']).join(',');
    window.location.href = '/auth/stepup/start?returnTo=' + encodeURIComponent(returnTo)
      + '&required=' + encodeURIComponent(required);
  }, [location.pathname, location.search]);

  // On return from the ceremony: read ?stepup=<outcome>, act, then strip the marker.
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const o = sp.get('stepup');
    if (!o) return;
    if (o === 'done') {
      setModal(null);
      setErrCard(null);
      setOutcome('done');
      showToast('Identity verified', 'success');
    } else if (o === 'cancel') {
      // Cancelled at the SSO (or the enroll card) — no card; the action stays blocked.
      setOutcome('cancel');
    } else if (Object.hasOwn(ERROR_CARDS, o)) {
      // own-property test — a bare `ERROR_CARDS[o]` would match inherited keys like
      // 'constructor'/'toString' and open a blank error card.
      setErrCard(o);
      setOutcome(o);
    }
    sp.delete('stepup');
    const clean = location.pathname + (sp.toString() ? '?' + sp.toString() : '') + location.hash;
    navigate(clean, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate, showToast]);

  // Pre-check (modal-open / gated-view mount). Resolves true when the current
  // session already satisfies a fresh step-up with a comfortable margin (so a slow
  // review can't lapse mid-action); otherwise saves any draft, opens the challenge
  // modal (Continue redirects), and resolves false.
  const precheck = useCallback(async ({ scenario, draftKey, draft } = {}) => {
    const url = '/auth/stepup/status' + (scenario ? '?scenario=' + encodeURIComponent(scenario) : '');
    const { data, ok } = await apiGet(url);
    // `?? 300` (not `|| 300`) so a legitimate buffer_seconds of 0 — sent by the
    // disabled-scenario short-circuit, and by very short windows — is honoured
    // instead of being replaced by the 5-min default (which would loop-challenge).
    const buffer = (data && data.buffer_seconds) ?? 300;
    if (ok && data && data.satisfied && data.seconds_left >= buffer) return true;
    // Committing to a redirect: wipe any stale draft an abandoned prior challenge
    // left behind, so only THIS action's draft can restore on return.
    clearAllDrafts();
    if (draftKey && draft !== undefined) { saveDraft(draftKey, draft); pendingDraftKeyRef.current = draftKey; }
    openChallenge(data && data.accepted);
    return false;
  }, [openChallenge]);

  // Esc cancels whichever card is open (capture + stopPropagation so an underlying
  // modal's own Esc handler doesn't also fire). Cancelling is safe — the gated
  // action simply stays blocked.
  useEffect(() => {
    if (!modal && !errCard) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelModal(); setErrCard(null); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [modal, errCard]);

  const label = user ? (user.display_name || user.username || user.email || 'your account') : 'your account';
  const org = (user && user.org_name) || 'Verify your identity';

  return (
    <StepUpContext.Provider value={{ precheck, beginStepUp, outcome, promptStepUp: openChallenge }}>
      {children}

      {modal && (
        // No backdrop dismiss — a privileged action shouldn't be abandoned by a stray
        // click. Cancel (or Esc) is the only way out.
        <div className="vs-scrim vs-su-scrim">
          <div className="vs-su-card" role="dialog" aria-modal="true" aria-label="Verify to continue">
            <div className="vs-su-brand">
              <span className="vs-su-badge"><ShieldIcon /></span>
              <span className="vs-su-wordmark">{org}</span>
            </div>
            <div className="vs-su-chip">
              <Avatar user={user} name={label} className="vs-su-av" />
              <span className="vs-su-name">{label}</span>
            </div>
            <h3 className="vs-su-title">Verify to continue</h3>
            <p className="vs-su-msg">This action needs a fresh identity check. You’ll verify with your passkey or authenticator app.</p>
            <button type="button" className="vs-btn vs-btn-primary vs-su-btn" onClick={beginStepUp}>Continue</button>
            <button type="button" className="vs-btn vs-su-btn" onClick={cancelModal}>Cancel</button>
          </div>
        </div>
      )}

      {!modal && errCard && (
        <div className="vs-scrim vs-su-scrim">
          <div className="vs-su-card" role="alertdialog" aria-modal="true">
            <div className="vs-su-state"><ShieldXIcon /></div>
            <h3 className="vs-su-title">{ERROR_CARDS[errCard].title}</h3>
            <p className="vs-su-msg">{ERROR_CARDS[errCard].message}</p>
            <button type="button" className="vs-btn vs-btn-primary vs-su-btn" onClick={() => { setErrCard(null); beginStepUp(); }}>Try again</button>
            <button type="button" className="vs-btn vs-su-btn" onClick={() => setErrCard(null)}>Cancel</button>
          </div>
        </div>
      )}
    </StepUpContext.Provider>
  );
}

export function useStepUp() {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used within StepUpProvider');
  return ctx;
}
