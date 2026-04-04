const crypto = require('crypto');
const { getPool } = require('./database');

function generateSessionId() {
    return crypto.randomBytes(64).toString('base64url');
}

async function createSession(userId, userAgent, ipAddress) {
    const pool = getPool();
    const sessionId = generateSessionId();
    const now = new Date();

    await pool.execute(
        `INSERT INTO sessions (session_id, user_id, last_activity, last_sign_in, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, userId, now, now, userAgent || null, ipAddress || null]
    );

    return sessionId;
}

async function getSession(sessionId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT s.*, u.username, u.display_name, u.role_id, u.is_active
         FROM sessions s
         JOIN users u ON s.user_id = u.user_id
         WHERE s.session_id = ?`,
        [sessionId]
    );
    return rows[0] || null;
}

async function updateSessionActivity(sessionId, ipAddress) {
    const pool = getPool();
    await pool.execute(
        'UPDATE sessions SET last_activity = NOW(), ip_address = ? WHERE session_id = ?',
        [ipAddress || null, sessionId]
    );
}

async function getSessionById(sessionId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT session_id, user_id FROM sessions WHERE session_id = ?',
        [sessionId]
    );
    return rows[0] || null;
}

async function deleteSession(sessionId) {
    const pool = getPool();
    await pool.execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
}

async function deleteUserSessions(userId, exceptSessionId) {
    const pool = getPool();
    if (exceptSessionId) {
        await pool.execute(
            'DELETE FROM sessions WHERE user_id = ? AND session_id != ?',
            [userId, exceptSessionId]
        );
    } else {
        await pool.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
}

async function getUserSessions(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT session_id, last_activity, last_sign_in, user_agent, ip_address, created_at FROM sessions WHERE user_id = ? ORDER BY last_activity DESC',
        [userId]
    );
    return rows;
}

async function isSessionValid(session) {
    const pool = getPool();

    // Get configurable expiry settings
    const [settings] = await pool.execute(
        "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('session_inactivity_days', 'session_max_days')"
    );

    let inactivityDays = 3;
    let maxDays = 15;
    for (const s of settings) {
        if (s.setting_key === 'session_inactivity_days') inactivityDays = parseInt(s.setting_value) || 3;
        if (s.setting_key === 'session_max_days') maxDays = parseInt(s.setting_value) || 15;
    }

    const now = Date.now();
    const lastActivity = new Date(session.last_activity).getTime();
    const lastSignIn = new Date(session.last_sign_in).getTime();

    const inactivityMs = inactivityDays * 24 * 60 * 60 * 1000;
    const maxMs = maxDays * 24 * 60 * 60 * 1000;

    if (now - lastActivity > inactivityMs) return false;
    if (now - lastSignIn > maxMs) return false;

    return true;
}

// Clean up expired sessions periodically
async function cleanExpiredSessions() {
    const pool = getPool();
    try {
        const [settings] = await pool.execute(
            "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('session_inactivity_days', 'session_max_days')"
        );

        let inactivityDays = 3;
        let maxDays = 15;
        for (const s of settings) {
            if (s.setting_key === 'session_inactivity_days') inactivityDays = parseInt(s.setting_value) || 3;
            if (s.setting_key === 'session_max_days') maxDays = parseInt(s.setting_value) || 15;
        }

        await pool.execute(
            `DELETE FROM sessions
             WHERE last_activity < DATE_SUB(NOW(), INTERVAL ? DAY)
                OR last_sign_in < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [inactivityDays, maxDays]
        );
    } catch (err) {
        console.error('Failed to clean expired sessions:', err.message);
    }
}

async function getSessionMaxDays() {
    const pool = getPool();
    const [rows] = await pool.execute(
        "SELECT setting_value FROM site_settings WHERE setting_key = 'session_max_days'"
    );
    return (rows.length > 0 && parseInt(rows[0].setting_value)) || 15;
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
    getSessionMaxDays
};
