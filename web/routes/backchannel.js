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

const SEEN_TTL = 7 * 24 * 3600;

router.post('/backchannel/events', express.urlencoded({ extended: false }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = req.body && req.body.event_token;
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

    const redis = getClient();
    for (const ev of events) {
        const id = ev && typeof ev.id === 'string' ? ev.id : null;
        const type = ev && typeof ev.type === 'string' ? ev.type : '';
        if (!id) return res.status(400).json({ error: 'invalid_event_id' });

        const fresh = redis ? await redis.set(`sso:evt:seen:${id}`, '1', 'EX', SEEN_TTL, 'NX') : 'OK';
        if (!fresh) continue; // retry redelivery — already processed

        try {
            if (type === 'logout') {
                if (ev.payload && typeof ev.payload.sid === 'string') {
                    await deleteSessionsBySsoSid(ev.payload.sid);
                }
            } else if (type === 'roles.sync_request') {
                await ssoEvents.reportRoles();
            } else if (type === 'account.roles_change') {
                // SSO-held assignment changed. Apply through the SERVICE layer
                // so profile/permission caches purge exactly like a local
                // admin edit. role_id null = No access: kill the sessions
                // (future sign-ins are already refused at the SSO).
                const p = ev.payload || {};
                if (typeof p.sub === 'string') {
                    const { updateUser } = require('../services/userService');
                    const { roleIdExists } = require('../services/roleService');
                    const { deleteUserSessions } = require('../config/session');
                    // local user ids are DASH-LESS hex (idBuf does Buffer.from(hex))
                    const localId = p.sub.replace(/-/g, '');
                    if (p.role_id == null) {
                        await deleteUserSessions(localId);
                    } else if (await roleIdExists(p.role_id)) {
                        await updateUser(localId, { role_id: p.role_id });
                    } else {
                        console.error(`roles_change: unknown role_id ${p.role_id} (catalog drift — sync pending?)`);
                    }
                }
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
                        p.sub.replace(/-/g, '').toLowerCase(),
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
