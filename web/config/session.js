const crypto = require('crypto');
const { getPool } = require('./database');
const sessionCache = require('../services/cache/sessionCache');

function generateSessionId() {
    return crypto.randomBytes(64).toString('base64url');
}

async function getSessionLimits() {
    const settingsCache = require('../services/cache/settingsCache');
    const inactivityDays = parseInt(await settingsCache.getSetting('session_inactivity_days', '3')) || 3;
    const maxDays = parseInt(await settingsCache.getSetting('session_max_days', '15')) || 15;
    return { inactivityDays, maxDays };
}

async function getInactivityTtlSeconds() {
    const { inactivityDays } = await getSessionLimits();
    return inactivityDays * 24 * 60 * 60;
}

async function createSession(userId, userAgent, ipAddress) {
    const pool = getPool();
    const sessionId = generateSessionId();
    const now = new Date();

    // Audit row in the sessions table; admin-view UI reads this and overlays
    // live values from Redis.
    await pool.execute(
        `INSERT INTO sessions (session_id, user_id, last_seen, last_sign_in, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, userId, now, now, userAgent || null, ipAddress || null]
    );

    const ttl = await getInactivityTtlSeconds();
    await sessionCache.createSession(sessionId, {
        userId,
        lastSignIn: now,
        lastSeen: now,
        ipAddress,
        userAgent,
    }, ttl);

    return sessionId;
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
        `SELECT session_id, user_id, last_seen, last_sign_in, user_agent, ip_address
         FROM sessions WHERE session_id = ?`,
        [sessionId]
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    const lastSeenMs = new Date(row.last_seen).getTime();
    const lastSignInMs = new Date(row.last_sign_in).getTime();

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
    }, remainingTtl);

    return {
        session_id: row.session_id,
        user_id: row.user_id,
        last_sign_in: lastSignInMs,
        last_seen: lastSeenMs,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
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
            [userId, exceptSessionId]
        );
    } else {
        await sessionCache.deleteAllForUser(userId);
        const pool = getPool();
        await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
}

// Return the list of sessions for a user (admin / profile view), with live
// last_seen / ip / user_agent overlaid from Redis where available.
async function getUserSessions(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT session_id, last_seen, last_sign_in, user_agent, ip_address, created_at
         FROM sessions WHERE user_id = ? ORDER BY last_seen DESC`,
        [userId]
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

module.exports = {
    createSession,
    getSession,
    getSessionById,
    updateSessionActivity,
    deleteSession,
    deleteUserSessions,
    getUserSessions,
    isSessionValid,
    cleanExpiredSessions,
    getSessionMaxDays,
};
