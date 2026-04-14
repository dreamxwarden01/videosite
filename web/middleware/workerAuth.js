const { getPool } = require('../config/database');
const { getClientIp } = require('./auth');

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour inactivity

// Bearer-token worker session middleware. Looks the token up in worker_sessions,
// enforces IP binding and 1-hour inactivity, and refreshes last_seen on every hit.
// Sets req.worker = { keyId, sessionId } on success.
async function requireWorkerSession(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return res.status(401).json({ error: 'Missing bearer token' });
    }
    const token = m[1];
    const clientIp = getClientIp(req) || '';

    try {
        const pool = getPool();

        const [rows] = await pool.execute(
            `SELECT session_id, worker_key_id, ip_address, last_seen
             FROM worker_sessions WHERE bearer_token = ?`,
            [token]
        );
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        const s = rows[0];

        // IP binding — any mismatch kills the session.
        if (s.ip_address !== clientIp) {
            await pool.execute('DELETE FROM worker_sessions WHERE session_id = ?', [s.session_id]);
            return res.status(401).json({ error: 'IP mismatch' });
        }

        // 1-hour inactivity expiry.
        const lastSeenMs = new Date(s.last_seen).getTime();
        if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > SESSION_TTL_MS) {
            await pool.execute('DELETE FROM worker_sessions WHERE session_id = ?', [s.session_id]);
            return res.status(401).json({ error: 'Session expired' });
        }

        // Refresh last_seen (best-effort — don't block on failure).
        await pool.execute(
            'UPDATE worker_sessions SET last_seen = NOW() WHERE session_id = ?',
            [s.session_id]
        );

        req.worker = { keyId: s.worker_key_id, sessionId: s.session_id };
        next();
    } catch (err) {
        console.error('requireWorkerSession error:', err);
        return res.status(500).json({ error: 'Authentication error' });
    }
}

module.exports = { requireWorkerSession };
