const crypto = require('crypto');
const argon2 = require('argon2');
const { getPool } = require('../config/database');
const { getClient } = require('./redis');
const { normalizeIP } = require('./ipHelpers');

const WORKER_TTL_SECONDS = 60 * 60; // 1 hour inactivity (Redis TTL)
const workerSessionKey = (token) => `session:worker:${token}`;
const DIRTY_WORKER_SESSIONS = 'dirty:session:worker';

// Leak detection window. Each auth on /api/worker/auth records the requesting
// IP under a per-key Redis sorted set; if a subsequent auth for the same key
// arrives from a different IP that's already in the list (ping-pong pattern),
// the key is deactivated. 60s matches the worker's 5s polling cadence × the
// realistic time for an attacker and a legit worker to alternate sessions.
const AUTH_ATTEMPT_WINDOW_SECONDS = 60;
const authAttemptKey = (keyId) => `worker_auth_attempts:${keyId}`;

// Key status values. Stored as VARCHAR(16) in worker_access_keys.status.
const STATUS_ACTIVE = 'active';
const STATUS_PAUSED = 'paused';
const STATUS_DEACTIVATED = 'deactivated';

async function generateWorkerKeyPair(label, createdBy) {
    const pool = getPool();
    const keyId = 'wk_' + crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const secretHash = await argon2.hash(secret, { type: argon2.argon2id });

    await pool.execute(
        `INSERT INTO worker_access_keys (key_id, key_secret, label, created_by)
         VALUES (?, ?, ?, ?)`,
        [keyId, secretHash, label || null, createdBy]
    );

    // Return the plain secret (shown once to the admin)
    return { keyId, secret };
}

// Rotate the secret on an existing key. Used by reactivate — generates a new
// plaintext secret, replaces the stored hash, and clears every existing
// session for the key (so any old bearer that was issued before the rotation
// is immediately invalid). Returns the new plaintext secret, shown once.
async function rotateWorkerKeySecret(keyId) {
    const pool = getPool();
    const secret = crypto.randomBytes(32).toString('base64url');
    const secretHash = await argon2.hash(secret, { type: argon2.argon2id });
    await pool.execute(
        'UPDATE worker_access_keys SET key_secret = ? WHERE key_id = ?',
        [secretHash, keyId]
    );
    await clearSessionsForKey(keyId);
    return secret;
}

// validateWorkerKey returns the row's status string on credential success, or
// null when the key is missing / secret-mismatch / status is 'deactivated'.
// 'active' and 'paused' both authenticate successfully — paused keys still
// need a valid bearer because the running worker is allowed to keep polling
// (polling and lease enforce the paused status downstream, returning empty /
// rejecting respectively).
async function validateWorkerKey(keyId, secret) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT key_id, key_secret, status FROM worker_access_keys WHERE key_id = ?',
        [keyId]
    );

    if (rows.length === 0) return null;
    if (rows[0].status === STATUS_DEACTIVATED) return null;

    const valid = await argon2.verify(rows[0].key_secret, secret);
    if (!valid) return null;

    // Update last_used_at
    await pool.execute(
        'UPDATE worker_access_keys SET last_used_at = NOW() WHERE key_id = ?',
        [keyId]
    );

    return rows[0].status;
}

// Cheap status lookup for the polling + lease hot paths. Returns the status
// string or null when the key is gone. Reading directly from the DB on every
// poll is fine — single PK lookup, dwarfed by everything else the endpoint
// does, and there's no consistency window to manage vs a cache.
async function getWorkerKeyStatus(keyId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT status FROM worker_access_keys WHERE key_id = ?',
        [keyId]
    );
    return rows.length === 0 ? null : rows[0].status;
}

// Set the key's status. Returns true if the row existed. When transitioning
// to 'deactivated' the caller is responsible for clearing the auth-attempt
// list — leak detection's own code path does this inline; the manual admin
// path goes through deactivateWorkerKey which handles it.
async function setWorkerKeyStatus(keyId, status) {
    const pool = getPool();
    const [result] = await pool.execute(
        'UPDATE worker_access_keys SET status = ? WHERE key_id = ?',
        [status, keyId]
    );
    return result.affectedRows > 0;
}

// Move a key into the 'deactivated' state, kill all in-flight sessions, and
// clear the Redis auth-attempt history. Used by both the leak detector and the
// admin "Deactivate" UI path (when we add a manual deactivate later — right
// now manual deactivation only happens implicitly via the reactivate flow).
async function deactivateWorkerKey(keyId) {
    await setWorkerKeyStatus(keyId, STATUS_DEACTIVATED);
    await clearSessionsForKey(keyId);
    await clearAuthAttempts(keyId);
}

async function renameWorkerKey(keyId, label) {
    const pool = getPool();
    const [result] = await pool.execute(
        'UPDATE worker_access_keys SET label = ? WHERE key_id = ?',
        [label && label.length ? label : null, keyId]
    );
    return result.affectedRows > 0;
}

// Hard delete. The caller (admin UI) shows a warning before invoking this;
// previous behaviour required a separate Revoke step first, which we've
// removed in favour of a single confirmed Delete that works in any status.
async function deleteWorkerKey(keyId) {
    await clearSessionsForKey(keyId);
    await clearAuthAttempts(keyId);
    const pool = getPool();
    const [result] = await pool.execute(
        'DELETE FROM worker_access_keys WHERE key_id = ?',
        [keyId]
    );
    return result.affectedRows > 0;
}

async function listWorkerKeys() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT key_id, label, status, created_at, last_used_at
         FROM worker_access_keys ORDER BY created_at DESC`
    );
    return rows;
}

// Clear every active session for a key. Used by deactivateWorkerKey,
// rotateWorkerKeySecret, and deleteWorkerKey so the next request from a
// previously-issued bearer falls straight to 401 instead of relying on the
// underlying status check.
async function clearSessionsForKey(keyId) {
    const pool = getPool();
    const [sessions] = await pool.execute(
        'SELECT bearer_token FROM worker_sessions WHERE worker_key_id = ?',
        [keyId]
    );
    if (sessions.length > 0) {
        const redis = getClient();
        const tokens = sessions.map(s => s.bearer_token);
        const tx = redis.multi().del(...tokens.map(workerSessionKey));
        if (tokens.length > 0) tx.srem(DIRTY_WORKER_SESSIONS, ...tokens);
        await tx.exec();
    }
    await pool.execute(
        'DELETE FROM worker_sessions WHERE worker_key_id = ?',
        [keyId]
    );
}

async function clearAuthAttempts(keyId) {
    await getClient().del(authAttemptKey(keyId));
}

// Leak detection — see services/ipHelpers.js for the IP normalisation rules.
// Called on /api/worker/auth AFTER credential validation has succeeded, so we
// only record genuine sign-ins (probing wrong-secret attempts can't fill the
// list and false-positive a legit worker).
//
// Returns:
//   'allow' — sign-in proceeds; entry recorded / refreshed.
//   'leak'  — ping-pong pattern detected (this IP appeared in the list and is
//             not the most-recent entry); caller MUST deactivate the key and
//             refuse the auth response.
//
// Rules:
//   - If the new IP equals the most-recent entry, refresh its timestamp and
//     allow. This collapses crash-loop restarts (same machine) into a single
//     entry so a supervisor isn't blamed for the worker's own restart.
//   - Else if the new IP appears anywhere else in the list, ping-pong: leak.
//   - Else append and allow (legit one-way IP change, or first sign-in ever).
async function checkAndRecordAuthAttempt(keyId, normalizedIp) {
    if (!normalizedIp) return 'allow'; // missing IP — nothing meaningful to record
    const redis = getClient();
    const key = authAttemptKey(keyId);

    // Latest entry (highest score).
    const latest = await redis.zrevrange(key, 0, 0);
    const latestIp = latest[0] || null;

    if (latestIp === normalizedIp) {
        // Restart loop from the same IP — refresh timestamp, no detection,
        // no new entry added.
        await redis.zadd(key, Date.now(), normalizedIp);
        await redis.expire(key, AUTH_ATTEMPT_WINDOW_SECONDS);
        return 'allow';
    }

    // Has this IP authed within the live window?
    const existingScore = await redis.zscore(key, normalizedIp);
    if (existingScore !== null && existingScore !== undefined) {
        // Yes, and a different IP is now the latest → ping-pong.
        return 'leak';
    }

    await redis.zadd(key, Date.now(), normalizedIp);
    await redis.expire(key, AUTH_ATTEMPT_WINDOW_SECONDS);
    return 'allow';
}

// Create a new bearer-token session for a worker key. Revokes any prior sessions
// for the same key first (one active session per key). Returns { bearerToken,
// expiresInSeconds } — the token is plaintext, shown once to the worker and
// stored plaintext in the DB (same model as the user `sessions` table).
const SESSION_TTL_SECONDS = 60 * 60; // 1 hour inactivity
const SESSION_ID_BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function generateSessionId() {
    // 16 random bytes → 16 base62 chars
    const buf = crypto.randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++) out += SESSION_ID_BASE62[buf[i] % 62];
    return out;
}

async function createWorkerSession(keyId, ipAddress) {
    const pool = getPool();
    const storedIp = normalizeIP(ipAddress || '');

    // Revoke any existing sessions for this key (one active session per key).
    // Look them up first so we can clear matching Redis entries.
    const [oldSessions] = await pool.execute(
        'SELECT bearer_token FROM worker_sessions WHERE worker_key_id = ?',
        [keyId]
    );
    if (oldSessions.length > 0) {
        const redis = getClient();
        const oldTokens = oldSessions.map(s => s.bearer_token);
        await redis.multi()
            .del(...oldTokens.map(workerSessionKey))
            .srem(DIRTY_WORKER_SESSIONS, ...oldTokens)
            .exec();
    }
    await pool.execute(
        'DELETE FROM worker_sessions WHERE worker_key_id = ?',
        [keyId]
    );

    const sessionId = generateSessionId();
    const bearerToken = crypto.randomBytes(64).toString('base64url');

    await pool.execute(
        `INSERT INTO worker_sessions (session_id, worker_key_id, bearer_token, ip_address)
         VALUES (?, ?, ?, ?)`,
        [sessionId, keyId, bearerToken, storedIp]
    );

    // Mirror to Redis for hot-path lookup. The plan's `dirty:session:worker`
    // set will be wired in Phase 5 when the periodic flusher lands.
    const redis = getClient();
    await redis.multi()
        .hset(workerSessionKey(bearerToken), {
            session_id: sessionId,
            worker_key_id: keyId,
            ip_address: storedIp,
            last_seen: String(Date.now()),
        })
        .expire(workerSessionKey(bearerToken), WORKER_TTL_SECONDS)
        .exec();

    await pool.execute(
        'UPDATE worker_access_keys SET last_used_at = NOW() WHERE key_id = ?',
        [keyId]
    );

    return { bearerToken, expiresInSeconds: SESSION_TTL_SECONDS };
}

// Delete worker sessions whose last_seen is older than 1 hour.
// Called hourly from server.js alongside the other session/token cleanups.
async function cleanupExpiredWorkerSessions() {
    const pool = getPool();
    const [result] = await pool.execute(
        'DELETE FROM worker_sessions WHERE last_seen < NOW() - INTERVAL 1 HOUR'
    );
    return result.affectedRows;
}

module.exports = {
    generateWorkerKeyPair,
    rotateWorkerKeySecret,
    validateWorkerKey,
    getWorkerKeyStatus,
    setWorkerKeyStatus,
    deactivateWorkerKey,
    renameWorkerKey,
    deleteWorkerKey,
    listWorkerKeys,
    clearSessionsForKey,
    checkAndRecordAuthAttempt,
    createWorkerSession,
    cleanupExpiredWorkerSessions,
    SESSION_TTL_SECONDS,
    WORKER_TTL_SECONDS,
    workerSessionKey,
    DIRTY_WORKER_SESSIONS,
    STATUS_ACTIVE,
    STATUS_PAUSED,
    STATUS_DEACTIVATED,
};
