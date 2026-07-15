// videosite -> SSO event pump — the RP twin of the SSO's src/events.ts.
// Pending queue in Redis (zset sso:events:out; score = due time, so the retry
// timestamp IS the score), 2s debounce after the first enqueue, a 60s sweep
// (which is the retry mechanism), and a boot-time full role report (self-
// healing against anything missed while down). Delivered/dead events land in
// MariaDB sso_event_outbox (the archive).
//
// roles.sync is COALESCED (only the latest matters) and its payload is
// composed AT SEND TIME: the full role list plus the SINGULAR default_role
// (from the "default role for new users" setting), so a queued report always
// carries the freshest state.
const crypto = require('crypto');
const oidc = require('../lib/oidc');
const { s2sFetch } = require('./s2sFetch');
const { getClient } = require('./redis');
const { getPool } = require('../config/database');

const KEY = 'sso:events:out';
const DEBOUNCE_MS = 2000;
const SWEEP_MS = 60000;
const BATCH_MAX = 100;
const MAX_ATTEMPTS = 50;

function backoffMs(attempts) {
    return Math.min(60000 * Math.pow(2, Math.max(0, attempts - 1)), 3600000) + Math.floor(Math.random() * 15000);
}

async function enqueue(type, payload = {}, { coalesce = false } = {}) {
    const redis = getClient();
    if (!redis) return; // early boot — the boot report covers it
    if (coalesce) {
        const members = await redis.zrange(KEY, 0, -1);
        for (const m of members) {
            try {
                if (JSON.parse(m).type === type) await redis.zrem(KEY, m);
            } catch {
                await redis.zrem(KEY, m);
            }
        }
    }
    await redis.zadd(KEY, Date.now(), JSON.stringify({ id: crypto.randomUUID(), type, payload, attempts: 0 }));
    kick();
}

// Role catalog changed (role CRUD / default-role setting / boot / the SSO's
// roles.sync_request): queue ONE coalesced full-state report.
async function reportRoles() {
    await enqueue('roles.sync', {}, { coalesce: true });
}

let timer = null;
function kick() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        drain().catch((e) => console.error('sso event drain failed:', e.message));
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
}

async function composeRolesPayload() {
    const { listRoles } = require('./roleService');
    const { getSetting } = require('./cache/settingsCache');
    const roles = await listRoles();
    const def = parseInt(await getSetting('registration_default_role', '2'), 10);
    return {
        // The app owns its display name — the SSO mirrors it into the client
        // registry from this report.
        site_name: await getSetting('site_name', 'VideoSite'),
        default_role: roles.some((r) => r.role_id === def) ? def : null,
        roles: roles.map((r) => ({
            role_id: r.role_id,
            name: r.role_name,
            level: r.permission_level,
            is_system: !!r.is_system,
        })),
    };
}

async function archive(ev, status) {
    try {
        await getPool().execute(
            `INSERT INTO sso_event_outbox (id, kind, payload, status, attempts, delivered_at)
             VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'delivered' THEN NOW() ELSE NULL END)
             ON DUPLICATE KEY UPDATE status = VALUES(status), attempts = VALUES(attempts), delivered_at = VALUES(delivered_at)`,
            [ev.id, ev.type, JSON.stringify(ev.payload || {}), status, ev.attempts || 0, status]
        );
    } catch (e) {
        console.error('sso event archive failed:', e.message);
    }
}

async function drain() {
    const redis = getClient();
    if (!redis) return;
    const members = await redis.zrangebyscore(KEY, 0, Date.now(), 'LIMIT', 0, BATCH_MAX);
    if (!members.length) return;
    const parsed = [];
    for (const m of members) {
        try {
            parsed.push({ m, ev: JSON.parse(m) });
        } catch {
            await redis.zrem(KEY, m);
        }
    }
    if (!parsed.length) return;

    const events = [];
    for (const { ev } of parsed) {
        events.push({
            id: ev.id,
            type: ev.type,
            payload: ev.type === 'roles.sync' ? await composeRolesPayload() : (ev.payload || {}),
        });
    }

    let ok = false;
    try {
        const token = await oidc.signEventToken(events);
        const r = await s2sFetch(oidc.ssoEventsUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ event_token: token }),
            signal: AbortSignal.timeout(5000),
        });
        ok = r.ok;
        if (!ok) console.error(`sso events -> HTTP ${r.status}`);
    } catch (e) {
        console.error('sso events send failed:', e.message);
    }

    for (const { m, ev } of parsed) {
        await redis.zrem(KEY, m);
        if (ok) {
            await archive(ev, 'delivered');
            continue;
        }
        ev.attempts = (ev.attempts || 0) + 1;
        if (ev.attempts >= MAX_ATTEMPTS) {
            await archive(ev, 'dead');
            continue;
        }
        await redis.zadd(KEY, Date.now() + backoffMs(ev.attempts), JSON.stringify(ev));
    }
    if (ok && (await redis.zcount(KEY, 0, Date.now())) > 0) return drain();
}

// Boot: report the current catalog, then keep the 60s retry sweep running.
function start() {
    reportRoles().catch((e) => console.error('boot role report failed:', e.message));
    const t = setInterval(() => drain().catch((e) => console.error('sso event sweep failed:', e.message)), SWEEP_MS);
    if (t.unref) t.unref();
}

// composeRolesPayload is exported for the installer's connect step, which sends
// the SAME roles.sync synchronously (it needs the SSO's answer, not a queued
// retry) to prove registration before it locks itself.
module.exports = { enqueue, reportRoles, drain, start, composeRolesPayload };
