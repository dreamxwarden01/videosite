// The installer's connect step. videosite cannot register itself at the SSO —
// it holds no credential the SSO trusts yet — so the operator adds it to the
// SSO's client list by hand. These probes are what tell them whether that
// actually worked, BEFORE the installer locks itself and the site goes live.
//
// The clever part is that one signed `roles.sync` envelope proves everything at
// once, using the SSO's existing POST /backchannel/events (src/routes/events.ts):
//   401 unknown_client    -> we aren't in the client list (or we're disabled)
//   401 no_registered_key -> we're registered but the SSO has no jwks_uri for us
//   401 invalid_token     -> the SSO has a DIFFERENT key for us
//   400 invalid_role*     -> connection is fine; our role table is malformed
//   204                   -> the SSO knows us, our signature verified, and it
//                            accepted the catalogue (which also sets our display
//                            name from site_name and hands the SSO's root org
//                            role this site's top role — the admin bootstrap)
const crypto = require('crypto');
const oidc = require('../lib/oidc');
const { s2sFetch } = require('./s2sFetch');

const TIMEOUT_MS = 6000;

const noSlash = (u) => String(u || '').trim().replace(/\/+$/, '');

// Is the SSO up, and does it advertise the issuer we were given? A mismatch here
// would otherwise stay invisible until the first login failed on id_token
// validation. Informational — the SSO may legitimately come up later.
async function probeSso(issuer) {
    let target;
    try {
        if (new URL(issuer).protocol !== 'https:') throw new Error('scheme');
        target = noSlash(issuer) + '/.well-known/openid-configuration';
    } catch {
        return { ok: false, reachable: false, reason: 'bad_url' };
    }
    try {
        const r = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.status !== 200) return { ok: false, reachable: true, status: r.status, reason: 'no_discovery' };
        const body = await r.json().catch(() => null);
        if (!body || !body.issuer) return { ok: false, reachable: true, status: 200, reason: 'no_discovery' };
        if (noSlash(body.issuer) !== noSlash(issuer)) {
            return { ok: false, reachable: true, status: 200, reason: 'issuer_mismatch', issuer: body.issuer };
        }
        return { ok: true, reachable: true, status: 200, issuer: body.issuer };
    } catch (e) {
        return { ok: false, reachable: false, reason: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
}

// Pre-flight: can the WORLD read our key set? The SSO fetches jwks_uri the moment
// the operator saves the client, so if our own public URL doesn't answer, the
// registration will fail on their side and they'll go hunting for a problem that
// is actually ours. Check ourselves first and say so.
async function probeSelfJwks(baseUrl) {
    const target = noSlash(baseUrl) + '/.well-known/jwks.json';
    try {
        const r = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.status !== 200) return { ok: false, url: target, status: r.status, reason: 'not_serving' };
        const body = await r.json().catch(() => null);
        const keys = body && Array.isArray(body.keys) ? body.keys : [];
        if (!keys.length) return { ok: false, url: target, status: 200, reason: 'no_keys' };
        return { ok: true, url: target, keys: keys.length, kid: keys[0].kid || null };
    } catch (e) {
        return {
            ok: false,
            url: target,
            reason: e.name === 'TimeoutError' ? 'timeout' : 'unreachable',
            detail: e.message,
        };
    }
}

// The real gate. Signs a roles.sync envelope with our registered client key and
// posts it to the SSO. A 204 is the only way through the installer.
async function verifyAndPublish() {
    const { composeRolesPayload } = require('./ssoEvents');
    let payload;
    try {
        payload = await composeRolesPayload();
    } catch (e) {
        return { ok: false, stage: 'roles', reason: 'roles_unavailable', detail: e.message };
    }

    let token;
    try {
        token = await oidc.signEventToken([
            { id: crypto.randomUUID(), type: 'roles.sync', payload },
        ]);
    } catch (e) {
        return { ok: false, stage: 'sign', reason: 'sign_failed', detail: e.message };
    }

    let r;
    try {
        r = await s2sFetch(oidc.ssoEventsUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ event_token: token }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        // Never reached the SSO at all — DNS, TLS, firewall, or (once the edge
        // enforces mTLS) a client certificate the edge refused.
        return {
            ok: false,
            stage: 'reach',
            reason: e.name === 'TimeoutError' ? 'timeout' : 'unreachable',
            detail: e.message,
            roles: payload,
        };
    }

    if (r.status === 204) {
        return { ok: true, roles: payload };
    }

    const body = await r.json().catch(() => null);
    const reason = (body && body.error) || 'http_' + r.status;

    // Which rung of the ladder failed? unknown_client / no_registered_key /
    // invalid_token are all "the SSO doesn't accept us"; invalid_role* means it
    // DOES accept us and rejected the catalogue — a very different fix.
    const stage = ['invalid_roles', 'invalid_role_row', 'processing_failed'].includes(reason)
        ? 'roles'
        : 'identity';

    return { ok: false, stage, reason, status: r.status, roles: payload };
}

module.exports = { probeSso, probeSelfJwks, verifyAndPublish };
