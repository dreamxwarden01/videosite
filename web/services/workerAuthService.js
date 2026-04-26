const crypto = require('crypto');
const argon2 = require('argon2');
const { getPool } = require('../config/database');
const { getClient } = require('./redis');

const WORKER_TTL_SECONDS = 60 * 60; // 1 hour inactivity (Redis TTL)
const workerSessionKey = (token) => `session:worker:${token}`;
const DIRTY_WORKER_SESSIONS = 'dirty:session:worker';

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

async function validateWorkerKey(keyId, secret) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT key_id, key_secret, is_active FROM worker_access_keys WHERE key_id = ?',
        [keyId]
    );

    if (rows.length === 0 || !rows[0].is_active) {
        return false;
    }

    const valid = await argon2.verify(rows[0].key_secret, secret);
    if (!valid) return false;

    // Update last_used_at
    await pool.execute(
        'UPDATE worker_access_keys SET last_used_at = NOW() WHERE key_id = ?',
        [keyId]
    );

    return true;
}

async function revokeWorkerKey(keyId) {
    const pool = getPool();
    await pool.execute(
        'UPDATE worker_access_keys SET is_active = 0 WHERE key_id = ?',
        [keyId]
    );
}

async function deleteWorkerKey(keyId) {
    const pool = getPool();
    // Only allow deleting revoked (inactive) keys
    const [result] = await pool.execute(
        'DELETE FROM worker_access_keys WHERE key_id = ? AND is_active = 0',
        [keyId]
    );
    return result.affectedRows > 0;
}

async function listWorkerKeys() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT key_id, label, is_active, created_at, last_used_at
         FROM worker_access_keys ORDER BY created_at DESC`
    );
    return rows;
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
        [sessionId, keyId, bearerToken, ipAddress || '']
    );

    // Mirror to Redis for hot-path lookup. The plan's `dirty:session:worker`
    // set will be wired in Phase 5 when the periodic flusher lands.
    const redis = getClient();
    await redis.multi()
        .hset(workerSessionKey(bearerToken), {
            session_id: sessionId,
            worker_key_id: keyId,
            ip_address: ipAddress || '',
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
    validateWorkerKey,
    revokeWorkerKey,
    deleteWorkerKey,
    listWorkerKeys,
    createWorkerSession,
    cleanupExpiredWorkerSessions,
    SESSION_TTL_SECONDS,
    WORKER_TTL_SECONDS,
    workerSessionKey,
    DIRTY_WORKER_SESSIONS,
};
