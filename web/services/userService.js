const argon2 = require('argon2');
const { getPool } = require('../config/database');
const permCache = require('./cache/permissionCache');
const userCache = require('./cache/userCache');

async function hashPassword(password) {
    return argon2.hash(password, { type: argon2.argon2id });
}

async function verifyPassword(hash, password) {
    return argon2.verify(hash, password);
}

async function createUser(username, displayName, password, roleId = 2, email = null) {
    const pool = getPool();
    const passwordHash = await hashPassword(password);

    const [result] = await pool.execute(
        `INSERT INTO users (username, display_name, email, password_hash, role_id)
         VALUES (?, ?, ?, ?, ?)`,
        [username, displayName, email, passwordHash, roleId]
    );
    return result.insertId;
}

async function getUserById(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT u.*, r.role_name, r.permission_level
         FROM users u JOIN roles r ON u.role_id = r.role_id
         WHERE u.user_id = ?`,
        [userId]
    );
    return rows[0] || null;
}

async function getUserByUsername(username) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM users WHERE username = ?',
        [username]
    );
    return rows[0] || null;
}

async function getUserByEmail(email) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM users WHERE email = ?',
        [email]
    );
    return rows[0] || null;
}

async function updateUser(userId, updates) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (updates.display_name !== undefined) { fields.push('display_name = ?'); values.push(updates.display_name); }
    if (updates.email !== undefined) { fields.push('email = ?'); values.push(updates.email); }
    if (updates.role_id !== undefined) { fields.push('role_id = ?'); values.push(updates.role_id); }
    if (updates.is_active !== undefined) { fields.push('is_active = ?'); values.push(updates.is_active); }
    if (updates.password) {
        const hash = await hashPassword(updates.password);
        fields.push('password_hash = ?');
        values.push(hash);
    }

    if (fields.length === 0) return;

    values.push(userId);
    await pool.execute(
        `UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`,
        values
    );

    // Invalidate cached permissions when role_id changes; invalidate user_meta
    // for any field change (callers always read meta on auth, so it must reflect
    // the latest display_name / email / is_active / role_id).
    if (updates.role_id !== undefined) {
        await permCache.invalidateUser(userId);
    }
    await userCache.invalidate(userId);
}

async function deleteUser(userId) {
    const pool = getPool();
    await pool.execute('DELETE FROM users WHERE user_id = ?', [userId]);
    await permCache.invalidateUser(userId);
    await userCache.invalidate(userId);
}

async function listUsers(actingUserLevel, page = 1, limit = 10) {
    const pool = getPool();
    const offset = (page - 1) * limit;

    const level = parseInt(actingUserLevel);
    const lim = parseInt(limit);
    const off = parseInt(offset);

    const [countRows] = await pool.execute(
        'SELECT COUNT(*) as total FROM users u JOIN roles r ON u.role_id = r.role_id WHERE r.permission_level > ?',
        [level]
    );
    const total = countRows[0].total;

    const [rows] = await pool.execute(
        `SELECT u.user_id, u.username, u.display_name, u.email, u.role_id, u.is_active, u.created_at,
                r.role_name, r.permission_level
         FROM users u JOIN roles r ON u.role_id = r.role_id
         WHERE r.permission_level > ?
         ORDER BY u.created_at DESC
         LIMIT ${lim} OFFSET ${off}`,
        [level]
    );

    return {
        users: rows,
        total,
        page,
        totalPages: Math.ceil(total / limit)
    };
}

async function usernameExists(username, excludeUserId = null) {
    const pool = getPool();
    if (excludeUserId) {
        const [rows] = await pool.execute(
            'SELECT 1 FROM users WHERE username = ? AND user_id != ?',
            [username, excludeUserId]
        );
        return rows.length > 0;
    }
    const [rows] = await pool.execute(
        'SELECT 1 FROM users WHERE username = ?',
        [username]
    );
    return rows.length > 0;
}

async function emailExists(email, excludeUserId = null) {
    const pool = getPool();
    const userQuery = excludeUserId
        ? 'SELECT 1 FROM users WHERE email = ? AND user_id != ?'
        : 'SELECT 1 FROM users WHERE email = ?';
    const userParams = excludeUserId ? [email, excludeUserId] : [email];
    const [[existing]] = await pool.execute(userQuery, userParams);
    if (existing) return true;

    const [[pending]] = await pool.execute(
        `SELECT 1 FROM pending_registrations WHERE email = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL CAST(COALESCE(
             (SELECT setting_value FROM site_settings WHERE setting_key = 'emailed_link_validity_minutes'), '30'
         ) AS UNSIGNED) MINUTE)`,
        [email]
    );
    return !!pending;
}

module.exports = {
    hashPassword,
    verifyPassword,
    createUser,
    getUserById,
    getUserByUsername,
    getUserByEmail,
    updateUser,
    deleteUser,
    listUsers,
    usernameExists,
    emailExists
};
