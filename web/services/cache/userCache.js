// User metadata cache. Stores the bits of the users row that the auth
// middleware needs on every request (username, display_name, email, role_id)
// so we can drop the session→users JOIN.

const { getClient } = require('../redis');
const { getPool, idBuf } = require('../../config/database');

const TTL = 30 * 60;
const key = (userId) => `user:meta:${userId}`;

async function loadFromDb(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT user_id, username, display_name, sso_avatar, email, role_id FROM users WHERE user_id = ?',
        [idBuf(userId)]
    );
    return rows[0] || null;
}

async function getUserMeta(userId) {
    const redis = getClient();
    const cached = await redis.get(key(userId));
    if (cached) return JSON.parse(cached);

    const row = await loadFromDb(userId);
    if (!row) return null;

    await redis.set(key(userId), JSON.stringify(row), 'EX', TTL);
    return row;
}

async function invalidate(userId) {
    await getClient().del(key(userId));
}

module.exports = { getUserMeta, invalidate };
