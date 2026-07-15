const crypto = require('crypto');
const { getPool, idBuf } = require('./database');
const sessionCache = require('../services/cache/sessionCache');

function generateSessionId() {
    return crypto.randomBytes(64).toString('base64url');
}

async function getSessionLimits() {
    const settingsCache = require('../services/cache/settingsCache');
    // Shortened under OIDC (was 3 / 15): re-auth is cheap via the SSO, so the app
    // session is short-lived. Site-settings rows still override these defaults.
    const inactivityDays = parseInt(await settingsCache.getSetting('session_inactivity_days', '1')) || 1;
    const maxDays = parseInt(await settingsCache.getSetting('session_max_days', '3')) || 3;
    return { inactivityDays, maxDays };
}

async function getInactivityTtlSeconds() {
    const { inactivityDays } = await getSessionLimits();
    return inactivityDays * 24 * 60 * 60;
}

async function createSession(userId, userAgent, ipAddress, ssoSid = null, ssoExpiresAt = null) {
    const pool = getPool();
    const sessionId = generateSessionId();
    const now = new Date();

    // Audit row in the sessions table; admin-view UI reads this and overlays
    // live values from Redis. sso_expires_at = the SSO session's absolute expiry
    // (from the id_token's sess_exp) — enforced in isSessionValid.
    await pool.execute(
        `INSERT INTO sessions (session_id, user_id, last_seen, last_sign_in, user_agent, ip_address, sso_sid, sso_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, idBuf(userId), now, now, userAgent || null, ipAddress || null, ssoSid, ssoExpiresAt]
    );

    const ttl = await getInactivityTtlSeconds();
    await sessionCache.createSession(sessionId, {
        userId,
        lastSignIn: now,
        lastSeen: now,
        ipAddress,
        userAgent,
        ssoExpiresAt,
    }, ttl);

    return sessionId;
}

// Delete every videosite session bound to an SSO master session (id_token `sid`).
// Used for rotate-on-login (drop the browser's prior session for this SSO session)
// and for OIDC back-channel logout. Clears both the Redis cache and the DB row.
async function deleteSessionsBySsoSid(ssoSid) {
    if (!ssoSid) return 0;
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT session_id, user_id FROM sessions WHERE sso_sid = ?',
        [ssoSid]
    );
    for (const row of rows) {
        await sessionCache.deleteSession(row.session_id, row.user_id);
    }
    await pool.execute('DELETE FROM sessions WHERE sso_sid = ?', [ssoSid]);
    return rows.length;
}

// Read the session record. Tries Redis first; on miss, falls back to the DB
// audit row and repopulates Redis. Returns just the session fields — the
// caller (middleware/auth) is responsible for fetching user metadata via
// userCache.
//
// Returns null when the session doesn't exist anywhere or has expired past
// the absolute max-days window.
async function getSession(sessionId) {
    const cached = await sessionCache.getSession(sessionId);
    if (cached) {
        cached.session_id = sessionId;
        return cached;
    }

    // Cache miss — try DB. Either the session is older than its idle TTL
    // (Redis expired it) and is invalid, or Redis was cold-restarted.
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT session_id, user_id, last_seen, last_sign_in, user_agent, ip_address, sso_expires_at
         FROM sessions WHERE session_id = ?`,
        [sessionId]
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    const lastSeenMs = new Date(row.last_seen).getTime();
    const lastSignInMs = new Date(row.last_sign_in).getTime();
    const ssoExpMs = row.sso_expires_at ? new Date(row.sso_expires_at).getTime() : null;

    // If DB row is itself past idle threshold, treat as expired — don't
    // repopulate Redis, let isSessionValid drive the cleanup.
    const { inactivityDays } = await getSessionLimits();
    const inactivityMs = inactivityDays * 24 * 60 * 60 * 1000;
    if (Date.now() - lastSeenMs > inactivityMs) {
        return {
            session_id: row.session_id,
            user_id: row.user_id,
            last_sign_in: lastSignInMs,
            last_seen: lastSeenMs,
            ip_address: row.ip_address,
            user_agent: row.user_agent,
            sso_expires_at: ssoExpMs,
            _stale: true,
        };
    }

    // Repopulate Redis with remaining TTL
    const remainingTtl = Math.max(60, Math.floor((inactivityMs - (Date.now() - lastSeenMs)) / 1000));
    await sessionCache.createSession(row.session_id, {
        userId: row.user_id,
        lastSignIn: lastSignInMs,
        lastSeen: lastSeenMs,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        ssoExpiresAt: ssoExpMs,
    }, remainingTtl);

    return {
        session_id: row.session_id,
        user_id: row.user_id,
        last_sign_in: lastSignInMs,
        last_seen: lastSeenMs,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        sso_expires_at: ssoExpMs,
    };
}

// Lightweight existence check (used where we only need to know "does this sid
// exist", not full session data).
async function getSessionById(sessionId) {
    const cached = await sessionCache.getSession(sessionId);
    if (cached) return { session_id: sessionId, user_id: cached.user_id };

    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT session_id, user_id FROM sessions WHERE session_id = ?',
        [sessionId]
    );
    return rows[0] || null;
}

// Refresh last_seen + ip on each request. Writes only to Redis; the periodic
// flusher (services/flusher.js) drains dirty:session:user every 15 min and
// writes last_seen / ip_address / user_agent back to the DB sessions row.
async function updateSessionActivity(sessionId, ipAddress, userAgent) {
    const ttl = await getInactivityTtlSeconds();
    await sessionCache.updateActivity(sessionId, {
        lastSeen: new Date(),
        ipAddress: ipAddress || '',
        ...(userAgent !== undefined ? { userAgent: userAgent || '' } : {}),
    }, ttl);
}

async function deleteSession(sessionId) {
    // Need user_id to remove from the user-sessions index. Look it up from
    // Redis first (cheap) and fall back to DB.
    let userId = null;
    const cached = await sessionCache.getSession(sessionId);
    if (cached) {
        userId = cached.user_id;
    } else {
        const pool = getPool();
        const [rows] = await pool.execute(
            'SELECT user_id FROM sessions WHERE session_id = ?',
            [sessionId]
        );
        if (rows.length > 0) userId = rows[0].user_id;
    }

    await sessionCache.deleteSession(sessionId, userId);

    const pool = getPool();
    await pool.execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
}

// Used by admin "terminate all sessions for user", deactivation, password
// reset/change. Also clears the user's meta and perm caches so any in-flight
// re-auth sees a fresh DB read.
async function deleteUserSessions(userId, exceptSessionId) {
    if (exceptSessionId) {
        await sessionCache.deleteAllForUserExcept(userId, exceptSessionId);
        const pool = getPool();
        await pool.execute(
            'DELETE FROM sessions WHERE user_id = ? AND session_id != ?',
            [idBuf(userId), exceptSessionId]
        );
    } else {
        await sessionCache.deleteAllForUser(userId);
        const pool = getPool();
        await pool.execute('DELETE FROM sessions WHERE user_id = ?', [idBuf(userId)]);
    }
}

// Return the list of sessions for a user (admin / profile view), with live
// last_seen / ip / user_agent overlaid from Redis where available.
async function getUserSessions(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT session_id, last_seen, last_sign_in, user_agent, ip_address, created_at
         FROM sessions WHERE user_id = ? ORDER BY last_seen DESC`,
        [idBuf(userId)]
    );

    if (rows.length === 0) return [];

    const sids = rows.map(r => r.session_id);
    const live = await sessionCache.getMany(sids);

    return rows.map(row => {
        const r = live[row.session_id];
        if (!r) return row;
        return {
            ...row,
            last_seen: r.last_seen ? new Date(r.last_seen) : row.last_seen,
            ip_address: r.ip_address ?? row.ip_address,
            user_agent: r.user_agent ?? row.user_agent,
        };
    });
}

// Inactivity + absolute TTL check. Both windows compared against the cached
// last_seen / last_sign_in (epoch ms). Redis TTL is a safety net for natural
// expiry — but `volatile-lru` can also evict an active session under memory
// pressure, so the explicit last_seen check is the source of truth.
async function isSessionValid(session) {
    if (session._stale) return false;
    const { inactivityDays, maxDays } = await getSessionLimits();
    const inactivityMs = inactivityDays * 24 * 60 * 60 * 1000;
    const maxMs = maxDays * 24 * 60 * 60 * 1000;
    if (Date.now() - session.last_seen > inactivityMs) return false;
    if (Date.now() - session.last_sign_in > maxMs) return false;
    // Never outlive the SSO session behind this login (id_token sess_exp).
    if (session.sso_expires_at && Date.now() > Number(session.sso_expires_at)) return false;
    return true;
}

// DB-side backstop. Removes audit rows whose Redis copies expired long ago
// (idle window) plus any past the absolute max-days. Redis TTL handles
// in-flight expiry; this just keeps the table from growing unbounded.
async function cleanExpiredSessions() {
    try {
        const { inactivityDays, maxDays } = await getSessionLimits();
        const pool = getPool();
        await pool.execute(
            `DELETE FROM sessions
             WHERE last_seen < DATE_SUB(NOW(), INTERVAL ? DAY)
                OR last_sign_in < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [inactivityDays, maxDays]
        );
    } catch (err) {
        console.error('Failed to clean expired sessions:', err.message);
    }
}

async function getSessionMaxDays() {
    return (await getSessionLimits()).maxDays;
}

// --- step-up (sudo) window ---
// The SSO step-up ceremony returns a fresh factor; the callback stamps it on the
// session's DB row (stepup_at + stepup_method). The gate and the status endpoint
// read it straight from the DB — it's deliberately NOT mirrored into the Redis
// session cache (the few gated actions tolerate one extra read, and this avoids a
// cache-coherence surface on a security-sensitive value).
async function stampSessionStepup(sessionId, method) {
    const pool = getPool();
    // Bind the timestamp as a JS Date (like createSession's last_seen) rather than
    // SQL NOW(), so freshness is measured against the same clock the gate uses
    // (Date.now()) — no dependency on the DB session time_zone matching Node's.
    await pool.execute(
        'UPDATE sessions SET stepup_at = ?, stepup_method = ? WHERE session_id = ?',
        [new Date(), method, sessionId]
    );
}

// Burn a session's step-up window (reuse:'one-time' scenarios clear it after a
// successful mutation so the next one re-verifies).
async function clearSessionStepup(sessionId) {
    const pool = getPool();
    await pool.execute(
        'UPDATE sessions SET stepup_at = NULL, stepup_method = NULL WHERE session_id = ?',
        [sessionId]
    );
}

// Returns { stepupAt: epochMs|null, method: string|null } for a session, or null
// if the row is gone.
async function getSessionStepup(sessionId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT stepup_at, stepup_method FROM sessions WHERE session_id = ?',
        [sessionId]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
        stepupAt: r.stepup_at ? new Date(r.stepup_at).getTime() : null,
        method: r.stepup_method || null,
    };
}

module.exports = {
    createSession,
    getSession,
    getSessionById,
    updateSessionActivity,
    deleteSession,
    deleteSessionsBySsoSid,
    deleteUserSessions,
    getUserSessions,
    isSessionValid,
    cleanExpiredSessions,
    getSessionMaxDays,
    stampSessionStepup,
    getSessionStepup,
    clearSessionStepup,
};
