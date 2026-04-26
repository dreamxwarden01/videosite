const { getPool } = require('../config/database');
const { getClient } = require('../services/redis');
const { workerSessionKey, WORKER_TTL_SECONDS } = require('../services/workerAuthService');
const { getClientIp } = require('./auth');

// Bearer-token worker session middleware. Looks the token up in Redis first,
// falls back to the worker_sessions DB row on miss (and warm-loads the cache),
// enforces IP binding, and refreshes last_seen + TTL on every hit. Sets
// req.worker = { keyId, sessionId } on success.
async function requireWorkerSession(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return res.status(401).json({ error: 'Missing bearer token' });
    }
    const token = m[1];
    const clientIp = getClientIp(req) || '';
    const redis = getClient();
    const cacheKey = workerSessionKey(token);

    try {
        // Hot path: Redis lookup.
        let cached = await redis.hgetall(cacheKey);
        let sessionId, keyId, ipAddress;

        if (cached && Object.keys(cached).length > 0) {
            sessionId = cached.session_id;
            keyId = cached.worker_key_id;
            ipAddress = cached.ip_address;
        } else {
            // Cold path: DB lookup, warm Redis on success.
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
            const lastSeenMs = new Date(s.last_seen).getTime();

            // 1-hour absolute inactivity check against the DB row.
            if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs > WORKER_TTL_SECONDS * 1000) {
                await pool.execute('DELETE FROM worker_sessions WHERE session_id = ?', [s.session_id]);
                return res.status(401).json({ error: 'Session expired' });
            }

            sessionId = s.session_id;
            keyId = s.worker_key_id;
            ipAddress = s.ip_address;

            // Warm cache so the next request short-circuits.
            const remainingTtl = Math.max(60, Math.floor(WORKER_TTL_SECONDS - (Date.now() - lastSeenMs) / 1000));
            await redis.multi()
                .hset(cacheKey, {
                    session_id: sessionId,
                    worker_key_id: keyId,
                    ip_address: ipAddress || '',
                    last_seen: String(Date.now()),
                })
                .expire(cacheKey, remainingTtl)
                .exec();
        }

        // IP binding — any mismatch kills the session.
        if (ipAddress !== clientIp) {
            await redis.del(cacheKey);
            const pool = getPool();
            await pool.execute('DELETE FROM worker_sessions WHERE session_id = ?', [sessionId]);
            return res.status(401).json({ error: 'IP mismatch' });
        }

        // Refresh last_seen + sliding TTL in Redis. DB last_seen still updates
        // on every request until Phase 5's flusher lands.
        const now = Date.now();
        await redis.multi()
            .hset(cacheKey, 'last_seen', String(now))
            .expire(cacheKey, WORKER_TTL_SECONDS)
            .exec();
        const pool = getPool();
        await pool.execute(
            'UPDATE worker_sessions SET last_seen = NOW() WHERE session_id = ?',
            [sessionId]
        );

        req.worker = { keyId, sessionId };
        next();
    } catch (err) {
        console.error('requireWorkerSession error:', err);
        return res.status(500).json({ error: 'Authentication error' });
    }
}

module.exports = { requireWorkerSession };
