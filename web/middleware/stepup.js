// SSO step-up (sudo) gate for videosite — settings-driven, per scenario.
//
// A route is wrapped with requireStepup('<scenario>'). The scenario's policy lives
// in the site setting mfa_policy_<scenario> ({ enabled, level, scope, reuse }) —
// the same rows the admin "policy by scenario" table writes, so an admin toggles
// step-up per scenario there. When enabled, the request is refused with
// 403 { code:'step_up_required' } unless the caller's session carries a FRESH
// (< STEPUP_WINDOW_MS) step-up whose method is in the scenario's accepted set. The
// client then runs the redirect ceremony (/auth/stepup/start -> SSO -> /auth/callback),
// which stamps the session, and the user retries.
const { getSetting } = require('../services/cache/settingsCache');
const { getSessionStepup, clearSessionStepup } = require('../config/session');

// The accepted strong factors (never email/password). The per-scenario `level`
// narrows this: level >= 2 = passkey-only, else authenticator (totp) or passkey.
const STEPUP_METHODS = ['totp', 'passkey'];
// Fallback sudo window when no scenario/setting applies (e.g. a scenario-less
// status check). Real windows come from the MFA general/level settings below.
const STEPUP_WINDOW_MS = 10 * 60 * 1000;
// Pre-check re-challenges when less than this remains, so a slow modal/review can't
// lapse mid-action (the same 3-min buffer the account portal uses). Capped at half
// the window for short windows. Only the pre-check uses it — the gate uses the full
// window, so a page can load yet a button still challenge (accepted trade-off).
const STEPUP_PRECHECK_BUFFER_MS = 3 * 60 * 1000;

// Map a scenario policy `level` to the accepted step-up method set. Mirrors the
// old MFA getAllowedMethodsForLevel semantics (authenticator == totp).
function stepupMethodsForLevel(level) {
    return Number(level) >= 2 ? ['passkey'] : ['totp', 'passkey'];
}

// The sudo window (seconds) a completed step-up stays valid for a scenario, from
// the same MFA settings the admin edits: one-time uses the one-time timeout;
// persistent uses the per-level timeout. (The pending-challenge timeout is NOT
// used here — that governed an un-completed legacy MFA challenge; the SSO txn TTL
// governs our in-flight challenge.)
async function windowSecondsFor(policy) {
    if (policy.reuse === 'one-time') {
        const v = parseInt(await getSetting('mfa_onetime_challenge_timeout_seconds', '600'), 10);
        return Number.isFinite(v) && v > 0 ? v : 600;
    }
    const raw = await getSetting(`mfa_level_${policy.level}_timeout_seconds`, null);
    const v = raw != null ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(v) && v > 0) return v;
    return Number(policy.level) >= 2 ? 600 : 3600; // level defaults (10 min / 1 h)
}

// Read a scenario's policy from settings. Same shape/defaults as the legacy
// getScenarioPolicy, read directly so step-up doesn't depend on the MFA service.
async function scenarioPolicy(scenario) {
    const raw = await getSetting('mfa_policy_' + scenario, null);
    const fallback = { enabled: false, level: 1, scope: 'W', reuse: 'persistent' };
    if (!raw) return fallback;
    try {
        const p = JSON.parse(raw);
        let reuse = p.reuse || 'persistent';
        if (reuse === 'session') reuse = 'persistent'; // legacy value
        return {
            enabled: p.enabled === true,
            level: p.level != null ? p.level : 1,
            scope: p.scope || 'W',
            reuse,
        };
    } catch {
        return fallback;
    }
}

// Evaluate a session's step-up state against an accepted method set. `secondsLeft`
// is clamped at 0 and is 0 unless the window is currently fresh.
async function stepupState(sessionId, methods = STEPUP_METHODS, windowMs = STEPUP_WINDOW_MS) {
    const s = sessionId ? await getSessionStepup(sessionId) : null;
    const at = s && s.stepupAt ? s.stepupAt : null;
    const method = s ? s.method : null;
    const ageMs = at != null ? Date.now() - at : null;
    const fresh = ageMs != null && ageMs >= 0 && ageMs < windowMs;
    const methodOk = method != null && methods.includes(method);
    const satisfied = fresh && methodOk;
    const secondsLeft = fresh ? Math.max(0, Math.floor((windowMs - ageMs) / 1000)) : 0;
    return { satisfied, fresh, method, methodOk, secondsLeft };
}

// Express middleware factory: gate a route behind a fresh step-up for `scenario`.
// Assumes loadUser ran (res.locals.user). Unauthenticated requests are the auth
// middleware's concern. A disabled scenario is a no-op; a write-only ('W') scope
// lets GETs through (matching the old MFA scope semantics).
function requireStepup(scenario) {
    return async (req, res, next) => {
        try {
            const user = res.locals.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const policy = await scenarioPolicy(scenario);
            if (!policy.enabled) return next();
            if (policy.scope === 'W' && req.method === 'GET') return next();
            const methods = stepupMethodsForLevel(policy.level);
            const windowMs = (await windowSecondsFor(policy)) * 1000;
            const st = await stepupState(user.session_id, methods, windowMs);
            if (st.satisfied) {
                // reuse:'one-time' — burn the window after a successful mutation so
                // the next one re-verifies. (GETs never consume; the stamp is shared
                // across scenarios, so a one-time action re-challenges all of them —
                // the conservative choice for the strictest mode.)
                if (policy.reuse === 'one-time' && req.method !== 'GET') {
                    res.on('finish', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            clearSessionStepup(user.session_id).catch((e) =>
                                console.error('one-time step-up clear:', e.message));
                        }
                    });
                }
                return next();
            }
            return res.status(403).json({
                error: 'Identity verification required',
                code: 'step_up_required',
                accepted: methods,
                scenario,
            });
        } catch (err) {
            console.error('step-up gate error:', err.message);
            return res.status(500).json({ error: 'Verification check failed' });
        }
    };
}

module.exports = {
    STEPUP_METHODS,
    STEPUP_WINDOW_MS,
    STEPUP_PRECHECK_BUFFER_MS,
    stepupMethodsForLevel,
    windowSecondsFor,
    scenarioPolicy,
    stepupState,
    requireStepup,
};
