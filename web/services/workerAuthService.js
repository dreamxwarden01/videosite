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

// Middleware for worker API routes
async function requireWorkerAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('WorkerKey ')) {
        return res.status(401).json({ error: 'Missing worker authentication' });
    }

    const parts = authHeader.slice(10).split(':');
    if (parts.length !== 2) {
        return res.status(401).json({ error: 'Invalid authorization format' });
    }

    const [keyId, secret] = parts;
    const valid = await validateWorkerKey(keyId, secret);
    if (!valid) {
        return res.status(401).json({ error: 'Invalid or revoked worker key' });
    }

    req.workerKeyId = keyId;
    next();
}

module.exports = {
    generateWorkerKeyPair,
    validateWorkerKey,
    revokeWorkerKey,
    deleteWorkerKey,
    listWorkerKeys,
    requireWorkerAuth
};
