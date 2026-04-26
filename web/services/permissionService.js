const { getPool } = require('../config/database');
const { ALL_PERMISSIONS } = require('./permissionConstants');
const cache = require('./cache/permissionCache');

// Resolve effective permissions for a user.
//   1. Read user's role_id + overrides (cached, 30min)
//   2. Read role's permission map (cached, 24h)
//   3. Merge: role baseline → overrides override
//
// roleId is accepted for backwards compatibility but ignored — the cached
// user record is the source of truth post-invalidation.
async function resolvePermissions(userId, _roleId) {
    const bundle = await resolveAuthBundle(userId);
    return bundle.permissions;
}

// Auth-middleware variant: returns permissions plus permission_level + role_id
// in one shot, so the middleware avoids a third DB query for the level.
async function resolveAuthBundle(userId) {
    const userCache = await cache.getUserPerms(userId);
    if (!userCache) {
        // No such user — return zero permissions
        const empty = {};
        for (const key of ALL_PERMISSIONS) empty[key] = false;
        return { permissions: empty, permission_level: 0, role_id: null };
    }

    const roleCache = await cache.getRolePerms(userCache.role_id);

    const effective = { ...roleCache.permissions };
    if (userCache.hasOverrides && userCache.overrides) {
        for (const [key, value] of Object.entries(userCache.overrides)) {
            if (value === 1) effective[key] = true;
            else if (value === 2) effective[key] = false;
        }
    }

    return {
        permissions: effective,
        permission_level: roleCache.permission_level,
        role_id: userCache.role_id,
    };
}

// Get role permissions only (used by admin "view role" UI). Cache-backed.
async function getRolePermissions(roleId) {
    const roleCache = await cache.getRolePerms(roleId);
    return roleCache.permissions;
}

// Get user overrides only (used by admin "view user permissions" UI).
// Returns a map of permission_key → override_value (1 or 2). No entries for
// permissions the user inherits unchanged.
async function getUserOverrides(userId) {
    const userCache = await cache.getUserPerms(userId);
    if (!userCache || !userCache.hasOverrides) return {};
    return userCache.overrides || {};
}

// Set a user permission override (admin action). Invalidates user cache only —
// the role cache is unaffected.
async function setUserOverride(userId, permissionKey, value) {
    const pool = getPool();

    if (value === 0) {
        await pool.execute(
            'DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_key = ?',
            [userId, permissionKey]
        );
    } else {
        await pool.execute(
            `INSERT INTO user_permission_overrides (user_id, permission_key, override_value)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE override_value = VALUES(override_value)`,
            [userId, permissionKey, value]
        );
    }

    await cache.invalidateUser(userId);
}

// Set role permissions (replace all). Invalidates only that role's cache;
// users in the role pick up the new values on their next request.
async function setRolePermissions(roleId, permissions) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
        for (const [key, granted] of Object.entries(permissions)) {
            if (granted) {
                await conn.execute(
                    'INSERT INTO role_permissions (role_id, permission_key, granted) VALUES (?, ?, 1)',
                    [roleId, key]
                );
            }
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }

    await cache.invalidateRole(roleId);
}

module.exports = {
    ALL_PERMISSIONS,
    resolvePermissions,
    resolveAuthBundle,
    getRolePermissions,
    getUserOverrides,
    setUserOverride,
    setRolePermissions,
    // Re-exported for callers that need to invalidate without a write
    invalidateUserCache: cache.invalidateUser,
    invalidateRoleCache: cache.invalidateRole,
    invalidateUsersCache: cache.invalidateUsers,
};
