const { getSession, updateSessionActivity, isSessionValid, deleteSession } = require('../config/session');
const { resolvePermissions } = require('../services/permissionService');

const SESSION_COOKIE = 'sid';

// Resolve real client IP: Cloudflare header → X-Forwarded-For → socket
function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp;

    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();

    return req.socket.remoteAddress || null;
}

// Load user from session cookie on every request
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

        // Check if user account is active
        if (!session.is_active) {
            await deleteSession(sessionId);
            res.clearCookie(SESSION_COOKIE);
            return next();
        }

        // Check session expiry
        const valid = await isSessionValid(session);
        if (!valid) {
            await deleteSession(sessionId);
            res.clearCookie(SESSION_COOKIE);
            return next();
        }

        // Update last activity and IP
        await updateSessionActivity(sessionId, getClientIp(req));

        // Resolve permissions
        const permissions = await resolvePermissions(session.user_id, session.role_id);

        res.locals.user = {
            user_id: session.user_id,
            username: session.username,
            display_name: session.display_name,
            role_id: session.role_id,
            permissions,
            session_id: sessionId
        };

        // Also need permission_level for level checks
        const { getPool } = require('../config/database');
        const pool = getPool();
        const [roleRows] = await pool.execute(
            'SELECT permission_level FROM roles WHERE role_id = ?',
            [session.role_id]
        );
        if (roleRows.length > 0) {
            res.locals.user.permission_level = roleRows[0].permission_level;
        }
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
