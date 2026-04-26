const { getSession, updateSessionActivity, isSessionValid, deleteSession, deleteUserSessions } = require('../config/session');
const { resolveAuthBundle } = require('../services/permissionService');
const { getUserMeta } = require('../services/cache/userCache');

const SESSION_COOKIE = 'sid';

// Resolve real client IP: Cloudflare header → X-Forwarded-For → socket
function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp;

    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();

    return req.socket.remoteAddress || null;
}

// Load user from session cookie on every request. The full hot path is now
// 1 Redis GET (session) + 1 Redis GET (user_meta) + 2 Redis GETs (perms) on
// cache hit; previously it was 1 DB JOIN + 2 DB queries + 1 DB query.
async function loadUser(req, res, next) {
    res.locals.user = null;

    const sessionId = req.cookies[SESSION_COOKIE];
    if (!sessionId) return next();

    try {
        const session = await getSession(sessionId);
        if (!session) {
            res.clearCookie(SESSION_COOKIE);
            return next();
        }

        // Absolute TTL check (max_days). Idle TTL is enforced by Redis expiry.
        const valid = await isSessionValid(session);
        if (!valid) {
            await deleteSession(sessionId);
            res.clearCookie(SESSION_COOKIE);
            return next();
        }

        // Look up user metadata from cache (replaces the old session→users JOIN).
        const userMeta = await getUserMeta(session.user_id);
        if (!userMeta) {
            // User row vanished — kill the orphan session.
            await deleteSession(sessionId);
            res.clearCookie(SESSION_COOKIE);
            return next();
        }

        // Account deactivated → cascade-clear all sessions / caches for this user.
        if (!userMeta.is_active) {
            await deleteUserSessions(session.user_id);
            res.clearCookie(SESSION_COOKIE);
            return next();
        }

        // Update last_seen + ip + ua in Redis. The periodic flusher drains
        // these to DB every 15 min — the per-request DB write is gone.
        await updateSessionActivity(sessionId, getClientIp(req), req.headers['user-agent'] || null);

        // Resolve permissions + permission_level in one cached bundle (2 Redis GETs).
        const { permissions, permission_level } = await resolveAuthBundle(session.user_id);

        res.locals.user = {
            user_id: session.user_id,
            username: userMeta.username,
            display_name: userMeta.display_name,
            role_id: userMeta.role_id,
            permissions,
            permission_level,
            session_id: sessionId,
        };
    } catch (err) {
        console.error('Error loading user session:', err.message);
        res.clearCookie(SESSION_COOKIE);
    }

    next();
}

// Require authentication - redirect to login or return 401
function requireAuth(req, res, next) {
    if (!res.locals.user) {
        // Check if this is an API request (use originalUrl — req.path is relative to mount point)
        if (req.originalUrl.startsWith('/api/') || req.xhr || req.headers.accept === 'application/json') {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const returnTo = req.originalUrl === '/' ? '' : '?returnTo=' + encodeURIComponent(req.originalUrl);
        return res.redirect('/login' + returnTo);
    }
    next();
}

module.exports = { loadUser, requireAuth, SESSION_COOKIE, getClientIp };
