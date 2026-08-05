// SSO activity reporting.
//
// The SSO's idle window is measured against ITS sessions.last_seen, which only
// moved when the SSO itself was hit (/authorize, portal renewal). Browsing
// videosite was invisible to it, so a continuously-used app session could sit on
// top of an SSO session quietly idling out — and since every SSO revocation path
// is sid-scoped over the session row, once that row was swept our session became
// unreachable by "sign out everywhere" or an admin terminate. We report activity
// so the idle window is genuinely shared.
//
// Shape (per SESSION, not per user — a user can hold several SSO sessions across
// devices, each with its own idle clock; coalescing per user would let activity
// on one device starve another's):
//   * One Redis key per sid does double duty as the coalescing window AND the
//     single-in-flight lock: SET NX EX 30 acquires, and success rewrites it to a
//     5-minute window. Losing the race means "someone is reporting, or we're
//     inside the window" — nothing to do.
//   * A failed report leaves the 30s lock to expire on its own, which is the
//     retry backoff: without it every request from every session would hammer a
//     down SSO.
//   * Fire-and-forget from the request path; never awaited.
//
// Outcomes:
//   204  accepted.
//   410  gone — terminate our session, but ONLY after verifying the SIGNED
//        verdict. Everything else (401/404/5xx/HTML/timeout/network) is
//        "unknown": do nothing, retry next window. Fail-open is deliberate — the
//        cost of failing open is a session outliving the idle line by minutes;
//        the cost of failing closed is logging out the whole fleet because a
//        proxy returned a 404 or a WAF served an HTML error page.

const { getClient } = require('./redis');
const { s2sFetch } = require('./s2sFetch');
const oidc = require('../lib/oidc');

// How long a successful report suppresses further ones. Far below any idle
// window (hours), so the SSO's last_seen is never more than this much stale.
const WINDOW_SECONDS = 300;
// In-flight lock / failure backoff. Also the ceiling on how long a crashed or
// hung report can suppress the next attempt.
const INFLIGHT_SECONDS = 30;
const TIMEOUT_MS = 5000;

const lockKey = (sid) => `sso:activity:${sid}`;

// Logged once per process, not per request — see the ssoSid guard below.
let warnedMissingSsoSid = false;

// Report activity for one session. Returns quietly on every path — the caller
// attaches a .catch() but this should rarely reject.
async function reportActivity(sessionId, ssoSid, lastSeenMs) {
    if (!sessionId) return;
    // A missing sso_sid is a ROLLOUT-window condition, not a steady state: every
    // login stores one (routes/auth.js takes it from the id_token `sid`, which the
    // SSO always issues) and the DB-fallback read selects it, so the only sessions
    // without one are Redis hashes cached before this shipped — they age out
    // within an idle window. If it persists past that, those sessions can never
    // keep their SSO session alive, which is precisely the failure this feature
    // exists to prevent, so it should be visible rather than silently skipped.
    if (!ssoSid) {
        if (!warnedMissingSsoSid) {
            warnedMissingSsoSid = true;
            console.warn('sso activity: session has no sso_sid — expected briefly after upgrade; a login bug if it persists');
        }
        return;
    }

    const redis = getClient();
    // Acquire the window/lock. Null = someone else holds it, or we're still
    // inside the 5-minute window. Either way there is nothing to do.
    const acquired = await redis.set(lockKey(sessionId), 'inflight', 'EX', INFLIGHT_SECONDS, 'NX');
    if (!acquired) return;

    let r;
    try {
        const assertion = await oidc.signClientAssertion();
        r = await s2sFetch(oidc.ssoActivityUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                sid: ssoSid,
                last_seen: lastSeenMs || Date.now(),
                client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                client_assertion: assertion,
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err) {
        // Unreachable / timeout / signing failure — leave the lock to expire as
        // backoff and try again after it does.
        return;
    }

    if (r.status === 204) {
        // Accepted: hold the coalescing window open.
        await redis.set(lockKey(sessionId), String(Date.now()), 'EX', WINDOW_SECONDS);
        return;
    }

    if (r.status === 410) {
        // The only destructive branch, and it fires ONLY on a verdict we can
        // prove the SSO signed. An unsigned/forged/undecodable 410 is treated
        // like any other unknown outcome: ignored.
        let verdict = null;
        try {
            const body = await r.json();
            // typ pins this to a verdict specifically: an events envelope is
            // signed by the same key for the same audience, so without it any
            // SSO-issued token would be accepted as authority to end a session.
            verdict = await oidc.verifySsoToken(String(body.verdict || ''), 'verdict+jwt');
        } catch {
            return; // not provably a verdict from the SSO — fail open
        }
        if (verdict.status !== 'invalid' || verdict.sid !== ssoSid) return;
        // Kill every local session bound to that SSO session (usually just ours).
        const { deleteSessionsBySsoSid } = require('../config/session');
        await deleteSessionsBySsoSid(ssoSid);
        await redis.del(lockKey(sessionId));
        return;
    }

    // 401 (our client key), 404 (wrong URL / not deployed yet), 5xx, an HTML
    // error page from the edge — all "unknown". Leave the lock to expire.
}

module.exports = { reportActivity, WINDOW_SECONDS, INFLIGHT_SECONDS };
