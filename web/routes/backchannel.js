// Generic back-channel event receiver (SSO -> videosite): POST
// /backchannel/events with a signed envelope verified against the SSO JWKS
// (aud = our client_id). Logout is an event TYPE on this channel now (was the
// bespoke OIDC logout token); roles.sync_request queues a fresh full-state
// roles.sync back through the outbound pump. At-least-once safe: per-event
// dedupe by id; unknown types are ACKED so the SSO can add types freely.
const express = require('express');
const router = express.Router();
const oidc = require('../lib/oidc');
const { deleteSessionsBySsoSid } = require('../config/session');
const { getClient } = require('../services/redis');
const ssoEvents = require('../services/ssoEvents');
const roleProtocol = require('../lib/ssoRoleProtocol');
const { eventFormParser, readEventToken } = require('../middleware/ssoEventBody');

const SEEN_TTL = 7 * 24 * 3600;

// SSO `sub` (dashed UUID) -> local user_id (dash-less LOWER hex).
//
// Both halves matter. idBuf() is case-insensitive (Buffer.from(hex)), so a
// wrong-case id still finds the right DB row — but the Redis caches are keyed by
// the STRING (`user:meta:{id}`, `user:perms:{id}`, `user:sessions:{id}`), and
// those are written from mysql2's typeCast, i.e. buf.toString('hex') = lower.
// Feed an upper-case id in and the row updates while its cache purge silently
// misses, leaving the user on stale permissions until the TTL expires. The two
// handlers had drifted (profile_change lower-cased, roles_change did not); one
// definition so they cannot drift again.
const localUserId = (sub) => sub.replace(/-/g, '').toLowerCase();

router.post('/backchannel/events', eventFormParser(), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = readEventToken(req.body);
    if (!token) return res.status(400).json({ error: 'missing_event_token' });

    let payload;
    try {
        payload = await oidc.verifyEventToken(token);
    } catch (err) {
        return res.status(401).json({ error: 'invalid_token' });
    }
    const events = payload.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
        return res.status(400).json({ error: 'invalid_events' });
    }
    // Reject malformed role payloads before any batch member has effects. Later
    // runtime failures still use per-event receipts; the batch is not atomic.
    for (const ev of events) {
        if (!ev || typeof ev.id !== 'string' || !ev.id) return res.status(400).json({ error: 'invalid_event_id' });
        if (ev.type === 'account.roles_change') {
            try {
                roleProtocol.observation(ev.payload);
                roleProtocol.digest({ type: ev.type, payload: ev.payload });
                if (!roleProtocol.UUID.test(ev.id)) throw new Error('invalid_event_id');
            } catch { return res.status(400).json({ error: 'invalid_role_event' }); }
        }
    }

    const redis = getClient();
    for (const ev of events) {
        const id = ev && typeof ev.id === 'string' ? ev.id : null;
        const type = ev && typeof ev.type === 'string' ? ev.type : '';
        if (!id) return res.status(400).json({ error: 'invalid_event_id' });

        // Role receipts, subject watermark, and SQL role mutation commit together.
        // The durable gate covers the subsequent cache/session cleanup.
        if (type === 'account.roles_change') {
            try { await require('../services/ssoRoleAuthority').service().processEvent(ev); }
            catch { return res.status(500).json({ error: 'server_error' }); }
            continue;
        }

        const fresh = redis ? await redis.set(`sso:evt:seen:${id}`, '1', 'EX', SEEN_TTL, 'NX') : 'OK';
        if (!fresh) continue; // retry redelivery — already processed

        try {
            if (type === 'logout') {
                if (ev.payload && typeof ev.payload.sid === 'string') {
                    await deleteSessionsBySsoSid(ev.payload.sid);
                }
            } else if (type === 'roles.sync_request') {
                await ssoEvents.reportRoles();
            } else if (type === 'org.settings') {
                // Org-level settings changed at the SSO (site_name today).
                const p = ev.payload || {};
                if (typeof p.site_name === 'string' && p.site_name.trim()) {
                    const { setSetting } = require('../services/tokenService');
                    await setSetting('sso_org_name', p.site_name.trim());
                }
            } else if (type === 'account.profile_change') {
                // Profile picture changed at the SSO: mirror the file name,
                // prefetch the bytes, drop the old local copy.
                const p = ev.payload || {};
                if (typeof p.sub === 'string') {
                    const { applyAvatar } = require('../services/avatarService');
                    await applyAvatar(
                        localUserId(p.sub),
                        typeof p.avatar === 'string' ? p.avatar : null
                    );
                }
            } else {
                console.log(`sso events: acked unknown type '${type}'`);
            }
        } catch (err) {
            console.error(`sso events: ${type} failed:`, err.message);
            if (redis) await redis.del(`sso:evt:seen:${id}`).catch(() => {});
            return res.status(500).json({ error: 'server_error' });
        }
    }
    return res.status(204).end();
});

module.exports = router;
