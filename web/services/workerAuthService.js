const crypto = require('crypto');
const argon2 = require('argon2');
const { getPool } = require('../config/database');

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
    SESSION_TTL_SECONDS
};
