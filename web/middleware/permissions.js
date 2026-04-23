const { getPool } = require('../config/database');

// Check if user has one or more permissions
function checkPermission(...requiredPermissions) {
    return (req, res, next) => {
        const user = res.locals.user;
        if (!user) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
        }

        for (const perm of requiredPermissions) {
            if (!user.permissions[perm]) {
                if (req.path.startsWith('/api/') || req.xhr) {
                    return res.status(403).json({ error: 'Permission denied' });
                }
                return res.status(403).render('error', {
                    title: 'Access Denied',
                    message: 'You do not have permission to perform this action.'
                });
            }
        }
        next();
    };
}

// Check that the acting user has a lower permission_level than the target user
// The target user ID comes from req.params.id
function checkPermissionLevel(req, res, next) {
    const targetUserId = parseInt(req.params.id);
    const actingUser = res.locals.user;

    if (!actingUser) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    // Users can always access their own profile-level actions
    if (targetUserId === actingUser.user_id) {
        return next();
    }

    const pool = getPool();
    const isApi = req.path.startsWith('/api/') || req.xhr;

    pool.execute(
        `SELECT u.role_id, r.permission_level
         FROM users u JOIN roles r ON u.role_id = r.role_id
         WHERE u.user_id = ?`,
        [targetUserId]
    ).then(([rows]) => {
        if (rows.length === 0) {
            if (isApi) {
                return res.status(404).json({ error: 'User not found' });
            }
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'User not found.'
            });
        }

        const targetLevel = rows[0].permission_level;
        if (actingUser.permission_level >= targetLevel) {
            if (isApi) {
                return res.status(403).json({ error: 'Cannot manage a user with equal or higher authority' });
            }
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'You cannot manage a user with equal or higher authority.'
            });
        }

        // Store target user info for the route handler
        req.targetUserLevel = targetLevel;
        req.targetUserRoleId = rows[0].role_id;
        next();
    }).catch(err => {
        console.error('Permission level check error:', err);
        if (isApi) {
            return res.status(500).json({ error: 'Failed to verify permissions' });
        }
        res.status(500).render('error', {
            title: 'Error',
            message: 'Failed to verify permissions.'
        });
    });
}

// Check if user has at least one of the specified permissions (OR logic)
function checkAnyPermission(...permissions) {
    return (req, res, next) => {
        const user = res.locals.user;
        if (!user) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            return res.redirect('/login?returnTo=' + encodeURIComponent(req.originalUrl));
        }

        if (!permissions.some(p => user.permissions[p])) {
            if (req.path.startsWith('/api/') || req.xhr) {
                return res.status(403).json({ error: 'Permission denied' });
            }
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'You do not have permission to perform this action.'
            });
        }
        next();
    };
}

module.exports = { checkPermission, checkPermissionLevel, checkAnyPermission };
