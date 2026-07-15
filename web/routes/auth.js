// OIDC relying-party auth routes. Replaces the old password-login flow:
// videosite no longer authenticates anyone — primary login is the DreamSSO.
//   GET  /auth/login    -> PKCE+state+nonce, 302 to the SSO /authorize
//   GET  /auth/callback -> exchange code, verify id_token, find/JIT user, set sid
//   GET  /auth/error    -> standalone failure page with a Retry button
//   POST /auth/logout   -> kill the local session, return the SSO end_session URL
const express = require('express');
const router = express.Router();
const oidc = require('../lib/oidc');
const { createSession, deleteSession, deleteSessionsBySsoSid, getSessionMaxDays, stampSessionStepup } = require('../config/session');
const { STEPUP_METHODS, STEPUP_PRECHECK_BUFFER_MS, STEPUP_WINDOW_MS, stepupState, scenarioPolicy, stepupMethodsForLevel, windowSecondsFor } = require('../middleware/stepup');
const { SESSION_COOKIE, getClientIp } = require('../middleware/auth');
const { findOrCreateBySub, updateUser } = require('../services/userService');
const { roleIdExists } = require('../services/roleService');

const FLOW_COOKIE = 'oidc_flow';
// Dockerfile sets NODE_ENV=production and the site is HTTPS (Caddy), so cookies
// are Secure in normal operation. OIDC_COOKIE_SECURE=false is an escape hatch
// for a plain-HTTP dev run.
const cookieSecure = process.env.OIDC_COOKIE_SECURE !== 'false';

function sanitizeReturnTo(rt) {
  if (!rt || typeof rt !== 'string') return '/';
  // Reject protocol-relative ('//'), absolute ('://'), and the backslash variant
  // ('/\\evil.com' — browsers treat '\' as '/', so it resolves off-origin and
  // encodeUrl leaves '\' unescaped in the Location header).
  if (!rt.startsWith('/') || rt.startsWith('//') || rt.includes('://') || rt.includes('\\')) return '/';
  return rt;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Standalone sign-in error page (not the SPA): code/detail + a Retry button.
function renderAuthErrorPage(code, detail) {
  return `<!DOCTYPE html><meta charset="utf-8"><title>Sign-in failed</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1f2330">
  <h1 style="font-size:20px;margin-bottom:4px">Couldn't sign you in</h1>
  <p style="color:#5b6472">Something went wrong while completing sign-in. You can try again.</p>
  <pre style="background:#f4f5f7;border:1px solid #e3e6ea;border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-word;color:#7a2230;font-size:13px">${esc(code || 'unknown')}${detail ? '\n' + esc(detail) : ''}</pre>
  <p style="margin-top:24px"><a href="/auth/login" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Try again</a></p>
</body>`;
}

// GET /auth/login -> bounce to the SSO.
router.get('/auth/login', (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.returnTo);
  // Already signed in (loadUser ran): no need to round-trip the SSO.
  if (res.locals.user) return res.redirect(returnTo);

  const { verifier, challenge, state, nonce } = oidc.beginFlow();
  res.cookie(FLOW_COOKIE, JSON.stringify({ verifier, state, nonce, returnTo }), {
    httpOnly: true, secure: cookieSecure, sameSite: 'lax', maxAge: 10 * 60 * 1000,
  });
  res.redirect(oidc.authorizeUrl({ challenge, state, nonce }));
});

// GET /auth/stepup/start -> begin the SSO step-up ceremony. Unlike /auth/login this
// forces the SSO round-trip even though the user is signed in, and passes the app's
// accepted method set + the id_token hint. The flow cookie carries purpose+required
// so the shared /auth/callback records and enforces it. The client saved its draft
// (sessionStorage) before navigating here.
router.get('/auth/stepup/start', (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.returnTo);
  if (!res.locals.user) {
    // No live session -> the page they land on will bounce through /auth/login.
    return res.redirect('/auth/login?returnTo=' + encodeURIComponent(returnTo));
  }
  // The client conveys the scenario's accepted set (from the gate's 403). Whitelist
  // it to strong factors — the gate re-checks against the server policy on resubmit,
  // so this only chooses which factor the SSO prompts for.
  const reqParam = typeof req.query.required === 'string' ? req.query.required : '';
  const whitelisted = reqParam.split(',').map((s) => s.trim()).filter((m) => m === 'totp' || m === 'passkey');
  const required = whitelisted.length ? whitelisted : STEPUP_METHODS;
  const { verifier, challenge, state, nonce } = oidc.beginFlow();
  res.cookie(FLOW_COOKIE, JSON.stringify({
    verifier, state, nonce, returnTo, purpose: 'stepup', required,
  }), { httpOnly: true, secure: cookieSecure, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const extra = { stepup: required.join(',') };
  const idt = req.cookies['oidc_idt'];
  if (idt) extra.id_token_hint = idt; // OIDC hint: "this should be the same subject"
  res.redirect(oidc.authorizeUrl({ challenge, state, nonce, extra }));
});

// GET /auth/stepup/status -> the client pre-check. Reports whether THIS session
// already satisfies a fresh step-up and how long it has left, so the SPA can
// pre-empt a redirect on modal-open when the window is thin. Reads videosite's own
// session state — never the SSO.
router.get('/auth/stepup/status', async (req, res) => {
  const user = res.locals.user;
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  // A scenario narrows the accepted set (via its policy level); without one, the
  // strong superset is used. Freshness is measured against that set.
  const scenario = typeof req.query.scenario === 'string' ? req.query.scenario : null;
  let methods = STEPUP_METHODS;
  let windowMs = STEPUP_WINDOW_MS;
  let policy = null;
  if (scenario) {
    policy = await scenarioPolicy(scenario);
    methods = stepupMethodsForLevel(policy.level);
    windowMs = (await windowSecondsFor(policy)) * 1000;
  }
  // A disabled scenario is a no-op at the gate, so the pre-check (only ever run for
  // a write action) must report satisfied — otherwise every guarded button would
  // spuriously challenge in the default, step-up-off state.
  if (policy && !policy.enabled) {
    return res.json({ satisfied: true, enabled: false, method: null, seconds_left: windowMs / 1000, accepted: methods, buffer_seconds: 0 });
  }
  const st = await stepupState(user.session_id, methods, windowMs);
  // Buffer can't exceed half the window (short windows would otherwise always
  // read as "too thin" and over-challenge).
  const bufferSeconds = Math.min(Math.floor(STEPUP_PRECHECK_BUFFER_MS / 1000), Math.floor(windowMs / 2000));
  res.json({
    satisfied: st.satisfied,
    method: st.method,
    seconds_left: st.secondsLeft,
    accepted: methods,
    buffer_seconds: bufferSeconds,
  });
});

// A step-up return: bounce back to the page the user was on, tagging the outcome so
// the SPA can restore the draft / show the right banner or error card.
function stepupReturn(flow, outcome) {
  const rt = sanitizeReturnTo(flow.returnTo);
  return rt + (rt.includes('?') ? '&' : '?') + 'stepup=' + encodeURIComponent(outcome);
}

// The step-up half of the callback: verify the token, bind identity to THIS session
// (sub-match), re-check the factor, stamp the sudo window. Never creates/rotates a
// session — the user keeps the one they have; we only record the fresh factor.
async function handleStepupCallback(req, res, flow) {
  try {
    const tok = await oidc.exchangeCode(String(req.query.code), flow.verifier);
    const claims = await oidc.verifyIdToken(tok.id_token, flow.nonce);

    const current = res.locals.user;
    // Session vanished during the round-trip -> let the page bounce to /auth/login.
    if (!current) return res.redirect(sanitizeReturnTo(flow.returnTo));

    // Bind identity: the returned subject MUST be this session's user. A mid-flight
    // account switch at the SSO is caught here, not by trusting the SSO session.
    const claimSub = String(claims.sub || '').replace(/-/g, '').toLowerCase();
    if (!claimSub || claimSub !== String(current.user_id).toLowerCase()) {
      return res.redirect(stepupReturn(flow, 'account'));
    }

    // Freshness guard: ONLY the SSO's fresh-challenge step-up fork stamps this acr.
    // A silently-reused login code echoes the original login's acr/amr, so requiring
    // this acr stops a stale strong-factor session from satisfying a step-up without
    // a fresh factor actually being proven.
    if (claims.acr !== 'urn:dreamsso:stepup') {
      return res.redirect(stepupReturn(flow, 'failed'));
    }

    // Map the returned factor and re-check it against the requested set. The SSO
    // already enforced this — this is the "didn't satisfy" guard (stray method /
    // clock skew) that stops a redirect loop.
    const amr = Array.isArray(claims.amr) ? claims.amr : [];
    const method = amr.includes('passkey') ? 'passkey'
      : amr.includes('otp') ? 'totp'
      : amr.includes('email') ? 'email' : 'password';
    const want = Array.isArray(flow.required) ? flow.required : STEPUP_METHODS;
    if (!want.includes(method)) return res.redirect(stepupReturn(flow, 'failed'));

    await stampSessionStepup(current.session_id, method);
    return res.redirect(stepupReturn(flow, 'done'));
  } catch (err) {
    console.error('step-up callback failed:', err.message, err.detail || '');
    return res.redirect(stepupReturn(flow, 'error'));
  }
}

// GET /auth/callback -> exchange the code and establish the session.
router.get('/auth/callback', async (req, res) => {
  let flow;
  try { flow = JSON.parse(req.cookies[FLOW_COOKIE] || '{}'); } catch { flow = {}; }
  res.clearCookie(FLOW_COOKIE);
  const isStepup = flow.purpose === 'stepup';

  if (req.query.error) {
    // A step-up cancel / enroll-declined comes back as access_denied -> user cancel
    // (silent, action stays blocked). Any other error (e.g. the attempt-cap's
    // login_required) -> the "didn't complete" card.
    if (isStepup) {
      return res.redirect(stepupReturn(flow, req.query.error === 'access_denied' ? 'cancel' : 'failed'));
    }
    const q = '?code=' + encodeURIComponent(req.query.error) +
      (req.query.error_description ? '&detail=' + encodeURIComponent(req.query.error_description) : '');
    return res.redirect('/auth/error' + q);
  }
  if (!req.query.code || !flow.state || req.query.state !== flow.state) {
    if (isStepup) return res.redirect(stepupReturn(flow, 'error'));
    return res.redirect('/auth/error?code=bad_state');
  }

  if (isStepup) return handleStepupCallback(req, res, flow);

  try {
    const tok = await oidc.exchangeCode(String(req.query.code), flow.verifier);
    const claims = await oidc.verifyIdToken(tok.id_token, flow.nonce);

    const user = await findOrCreateBySub(claims);

    // The SSO defines the app role at login: id_token `app_role` carries OUR
    // native role_id (the SSO's effective assignment). Apply it through the
    // service layer exactly like a roles_change event — update + cache purge —
    // but only when it differs. An unknown role_id means our catalog at the
    // SSO is out of sync: refuse the login (same rule as event reports).
    if (typeof claims.app_role === 'number' && claims.app_role !== user.role_id) {
      if (!(await roleIdExists(claims.app_role))) {
        console.error(`login app_role: unknown role_id ${claims.app_role} (catalog drift — sync pending?)`);
        return res.redirect('/auth/error?code=role_out_of_sync');
      }
      const hexId = String(claims.sub).replace(/-/g, '').toLowerCase();
      await updateUser(hexId, { role_id: claims.app_role });
      user.role_id = claims.app_role;
    }

    // Profile picture claim: apply like an event report (update + prefetch)
    // when the file name differs from the mirrored one. Absent claim = no
    // picture -> clears a stale mirror.
    {
      const pic = typeof claims.picture === 'string' ? claims.picture : null;
      if ((user.sso_avatar ?? null) !== pic) {
        const { applyAvatar } = require('../services/avatarService');
        await applyAvatar(String(claims.sub).replace(/-/g, '').toLowerCase(), pic)
          .catch((e) => console.error('avatar apply at login failed:', e.message));
      }
    }

    // Org name claim (the SSO's site_name): mirror it for the profile menu.
    if (typeof claims.site_name === 'string' && claims.site_name.trim()) {
      const { getSetting } = require('../services/cache/settingsCache');
      if ((await getSetting('sso_org_name', '')) !== claims.site_name) {
        const { setSetting } = require('../services/tokenService');
        await setSetting('sso_org_name', claims.site_name);
      }
    }

    // Rotate: one app session per SSO session — drop the browser's prior videosite
    // session for this SSO session (e.g. after a silent re-auth on browser reopen).
    const ssoSid = typeof claims.sid === 'string' ? claims.sid : null;
    if (ssoSid) await deleteSessionsBySsoSid(ssoSid);

    // Session durability follows the SSO's KMSI claims: persistent -> expiring
    // cookie capped at min(our absolute window, the SSO session's sess_exp);
    // transient -> browser-session cookie. Validity logic enforces sess_exp too.
    const persistent = claims.sess_persistent === true;
    const ssoExpMs = typeof claims.sess_exp === 'number' ? claims.sess_exp * 1000 : null;
    const sessionId = await createSession(
      user.user_id, req.headers['user-agent'] || null, getClientIp(req), ssoSid,
      ssoExpMs ? new Date(ssoExpMs) : null,
    );
    const baseCookie = { httpOnly: true, secure: cookieSecure, sameSite: 'lax' };
    let cookieOpts = baseCookie;
    if (persistent) {
      const maxDays = await getSessionMaxDays();
      const capMs = Math.min(Date.now() + maxDays * 24 * 60 * 60 * 1000, ssoExpMs ?? Infinity);
      cookieOpts = { ...baseCookie, expires: new Date(capMs) };
    }
    res.cookie(SESSION_COOKIE, sessionId, cookieOpts);
    // id_token kept (httpOnly) only as a logout hint — same lifetime as the session cookie.
    if (tok.id_token) res.cookie('oidc_idt', tok.id_token, cookieOpts);

    return res.redirect(sanitizeReturnTo(flow.returnTo));
  } catch (err) {
    const detail = err.message === 'token_endpoint_error'
      ? (err.detail && err.detail.error) || 'token_exchange_failed'
      : err.message;
    console.error('OIDC callback failed:', err.message, err.detail || '');
    return res.redirect('/auth/error?code=' + encodeURIComponent(detail || 'callback_failed'));
  }
});

// GET /auth/error
router.get('/auth/error', (req, res) => {
  res.status(400).type('html').send(renderAuthErrorPage(req.query.code, req.query.detail));
});

// POST /auth/logout -> kill local session, hand back the SSO end_session URL.
router.post('/auth/logout', async (req, res) => {
  const sid = req.cookies[SESSION_COOKIE];
  if (sid) { try { await deleteSession(sid); } catch (e) { console.error('logout deleteSession:', e.message); } }
  const idt = req.cookies['oidc_idt'];
  res.clearCookie(SESSION_COOKIE);
  res.clearCookie('oidc_idt');
  res.json({ success: true, logoutUrl: oidc.endSessionUrl(idt) });
});

module.exports = router;
