const crypto = require('crypto');
const { getPool, idBuf } = require('./database');
const sessionCache = require('../services/cache/sessionCache');
const { transaction } = require('../services/ssoCatalogStore');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalSsoSid(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid_sso_session');
    return value.toLowerCase();
}
async function lockSsoSession(db, ssoSid, userId) {
    await db.execute(`INSERT INTO sso_session_state(sso_sid,subject_id) VALUES(?,?)
        ON DUPLICATE KEY UPDATE sso_sid=VALUES(sso_sid)`, [ssoSid, idBuf(userId)]);
    const [[state]] = await db.execute('SELECT subject_id,revoked FROM sso_session_state WHERE sso_sid=? FOR UPDATE', [ssoSid]);
    if (!state || state.subject_id !== userId) throw new Error('sso_session_binding_mismatch');
    return state;
}

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

async function createSession(userId, userAgent, ipAddress, ssoSid = null, ssoExpiresAt = null, roleGeneration = '0') {
    const pool = getPool();
    const sessionId = generateSessionId();
    const now = new Date();

    // Audit row in the sessions table; admin-view UI reads this and overlays
    // live values from Redis. sso_expires_at = the SSO session's absolute expiry
    // (from the id_token's sess_exp) — enforced in isSessionValid.
    if (ssoSid !== null) ssoSid = canonicalSsoSid(ssoSid);
    const insert = db => db.execute(
        `INSERT INTO sessions (session_id, user_id, last_seen, last_sign_in, user_agent, ip_address, sso_sid, sso_expires_at,sso_role_generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, idBuf(userId), now, now, userAgent || null, ipAddress || null, ssoSid, ssoExpiresAt, roleGeneration]
    );
    if (ssoSid) {
        await transaction(pool, async db => {
            const state = await lockSsoSession(db, ssoSid, userId);
            if (state.revoked) throw new Error('sso_session_revoked');
            await insert(db);
        });
    } else await insert(pool);

    const ttl = await getInactivityTtlSeconds();
    await sessionCache.createSession(sessionId, {
        userId,
        lastSignIn: now,
        lastSeen: now,
        ipAddress,
        userAgent,
        ssoExpiresAt,
        ssoSid,
        roleGeneration,
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

// Final SSO logout differs from normal login replacement above. The persistent
// terminal row serializes with callback insertion; normal replacement never
// clears it. Retain it until an explicit, separately reviewed GC policy exists.
async function revokeSessionsBySsoSid(ssoSid, subject) {
    ssoSid = canonicalSsoSid(ssoSid);
    if (typeof subject !== 'string' || !UUID.test(subject)) throw new Error('invalid_sso_subject');
    const userId = subject.replace(/-/g, '').toLowerCase(), pool = getPool();
    const rows = await transaction(pool, async db => {
        await lockSsoSession(db, ssoSid, userId);
        const [current] = await db.execute('SELECT session_id,user_id FROM sessions WHERE sso_sid=? FOR UPDATE', [ssoSid]);
        if (current.some(row => row.user_id !== userId)) throw new Error('sso_session_binding_mismatch');
        await db.execute('UPDATE sso_session_state SET revoked=1 WHERE sso_sid=?', [ssoSid]);
        await db.execute('DELETE FROM sessions WHERE sso_sid=?', [ssoSid]);
        return current;
    });
    for (const row of rows) await sessionCache.deleteSession(row.session_id, row.user_id);
    return rows.length;
}

// SQL owns session membership and immutable authentication fields on every read.
// Redis only supplies live activity: a read begun before deletion may refill its
// cache afterward, but that SQL-less entry must never authorize a later request.
// The caller still checks expiry and current user/role authority.
async function getSession(sessionId) {
    const cached = await sessionCache.getSession(sessionId);
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT session_id, user_id, last_seen, last_sign_in, user_agent, ip_address, sso_expires_at, sso_sid,
                CAST(sso_role_generation AS CHAR) AS sso_role_generation,
                EXISTS(SELECT 1 FROM sso_session_state state WHERE state.sso_sid=CONVERT(LOWER(sessions.sso_sid) USING ascii) COLLATE ascii_bin
                    AND (state.revoked=1 OR state.subject_id<>sessions.user_id)) AS sso_revoked
         FROM sessions WHERE session_id = ?`,
        [sessionId]
    );
    if (rows.length === 0 || rows[0].sso_revoked) {
        await sessionCache.deleteSession(sessionId, cached?.user_id);
        return null;
    }

    const row = rows[0];
    const lastSignInMs = new Date(row.last_sign_in).getTime();
    const ssoExpMs = row.sso_expires_at ? new Date(row.sso_expires_at).getTime() : null;
    const cacheMatches = cached && cached.user_id === row.user_id
        && cached.sso_sid === (row.sso_sid || null)
        && cached.sso_role_generation === row.sso_role_generation;
    const lastSeenMs = Math.max(new Date(row.last_seen).getTime(),
        cacheMatches && Number.isFinite(cached.last_seen) ? cached.last_seen : 0);
    const session = {
        session_id: row.session_id,
        user_id: row.user_id,
        last_sign_in: lastSignInMs,
        last_seen: lastSeenMs,
        ip_address: cacheMatches ? cached.ip_address : row.ip_address,
        user_agent: cacheMatches ? cached.user_agent : row.user_agent,
        sso_expires_at: ssoExpMs,
        sso_sid: row.sso_sid || null,
        sso_role_generation: row.sso_role_generation,
    };
    if (cacheMatches) return session;

    // A cold/mismatched cache must not revive an idle-expired SQL session.
    const { inactivityDays } = await getSessionLimits();
    const inactivityMs = inactivityDays * 24 * 60 * 60 * 1000;
    if (Date.now() - lastSeenMs > inactivityMs) {
        return { ...session, _stale: true };
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
        ssoSid: row.sso_sid || null,
        roleGeneration: row.sso_role_generation,
    }, remainingTtl);

    return session;
}

// Lightweight existence check (used where we only need to know "does this sid
// exist", not full session data).
async function getSessionById(sessionId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT session_id, user_id FROM sessions WHERE session_id = ? AND NOT EXISTS(
            SELECT 1 FROM sso_session_state state WHERE state.sso_sid=CONVERT(LOWER(sessions.sso_sid) USING ascii) COLLATE ascii_bin
            AND (state.revoked=1 OR state.subject_id<>sessions.user_id))`,
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
async function stampSessionStepup(sessionId, method, { userId, ssoSid, authenticatedAt, expiresAt }) {
    ssoSid = canonicalSsoSid(ssoSid);
    if (typeof userId !== 'string' || !/^[0-9a-f]{32}$/.test(userId)
        || !(authenticatedAt instanceof Date) || !Number.isFinite(authenticatedAt.getTime())
        || !Number.isSafeInteger(expiresAt)) {
        throw new Error('invalid_stepup_binding');
    }
    // Same lock order as final logout/session creation. Revocation cannot land
    // between the SID check and stamp, and a deleted/replaced row is never added.
    const expired = new Error('stepup_flow_expired');
    try {
        return await transaction(getPool(), async db => {
            const state = await lockSsoSession(db, ssoSid, userId);
            if (state.revoked || Date.now() >= expiresAt) return false;
            const [result] = await db.execute(
                `UPDATE sessions SET stepup_at = ?, stepup_method = ?
                 WHERE session_id = ? AND user_id = ? AND sso_sid = ?`,
                [authenticatedAt, method, sessionId, idBuf(userId), ssoSid]
            );
            // UPDATE can itself wait on the local-session row. Throw so the
            // transaction rolls back its stamp before reporting expiry.
            if (Date.now() >= expiresAt) throw expired;
            return result.affectedRows > 0;
        });
    } catch (error) {
        if (error === expired) return false;
        throw error;
    }
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
    revokeSessionsBySsoSid,
    deleteUserSessions,
    getUserSessions,
    isSessionValid,
    cleanExpiredSessions,
    getSessionMaxDays,
    stampSessionStepup,
    getSessionStepup,
    clearSessionStepup,
};
