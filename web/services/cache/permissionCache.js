// Two-tier permission cache.
//
// `role:perms:{id}`  — JSON {permissions, permission_level}, TTL 24h.
//                      Shared across all users in that role; rebuilt only when
//                      the role itself changes.
//
// `user:perms:{id}`  — JSON {role_id, hasOverrides, overrides?}, TTL 30min.
//                      Stores the user's role pointer + their overrides.
//                      A user with no overrides still gets a {hasOverrides:false}
//                      sentinel so we never re-query DB for that fact.
//
// Effective permission resolution = read user:perms → look up its role:perms →
// merge in memory (role baseline, overrides win). Two GETs per authed request.
//
// Invalidation is targeted: a role permission change clears only the role
// cache; users referencing that role pick up the new values on their next
// request. A user's role change or override change clears only that user.

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');
const { ALL_PERMISSIONS } = require('../permissionConstants');

const ROLE_TTL = 24 * 60 * 60;   // 24h
const USER_TTL = 30 * 60;        // 30min

const roleKey = (id) => `role:perms:${id}`;
const userKey = (id) => `user:perms:${id}`;

// Defensive set lookup — old permission keys (e.g. allowSignIn) can linger in
// role_permissions / user_permission_overrides after being removed from
// ALL_PERMISSIONS. We drop them here so they don't leak through the cache,
// the auth bundle, or /api/me. The DB rows are harmless until cleaned up
// out-of-band; this filter guarantees the in-memory shape is canonical.
const ALLOWED_PERMISSION_SET = new Set(ALL_PERMISSIONS);

async function loadRoleFromDb(roleId) {
    const pool = getPool();
    const [permRows] = await pool.execute(
        'SELECT permission_key, granted FROM role_permissions WHERE role_id = ?',
        [roleId]
    );
    const [roleRows] = await pool.execute(
        'SELECT permission_level FROM roles WHERE role_id = ?',
        [roleId]
    );

    const permissions = {};
    for (const key of ALL_PERMISSIONS) permissions[key] = false;
    for (const row of permRows) {
        if (!ALLOWED_PERMISSION_SET.has(row.permission_key)) continue;
        permissions[row.permission_key] = row.granted === 1;
    }

    return {
        permissions,
        permission_level: roleRows[0] ? roleRows[0].permission_level : 0,
    };
}

async function getRolePerms(roleId) {
    const redis = getClient();
    const cached = await redis.get(roleKey(roleId));
    if (cached) return JSON.parse(cached);

    const obj = await loadRoleFromDb(roleId);
    await redis.set(roleKey(roleId), JSON.stringify(obj), 'EX', ROLE_TTL);
    return obj;
}

async function loadUserFromDb(userId) {
    const pool = getPool();
    const [userRows] = await pool.execute(
        'SELECT role_id FROM users WHERE user_id = ?',
        [userId]
    );
    if (userRows.length === 0) return null;

    const [overrideRows] = await pool.execute(
        'SELECT permission_key, override_value FROM user_permission_overrides WHERE user_id = ?',
        [userId]
    );

    const obj = {
        role_id: userRows[0].role_id,
        hasOverrides: overrideRows.length > 0,
    };
    if (overrideRows.length > 0) {
        obj.overrides = {};
        for (const row of overrideRows) {
            if (!ALLOWED_PERMISSION_SET.has(row.permission_key)) continue;
            obj.overrides[row.permission_key] = row.override_value;
        }
        // All overrides could have been legacy keys — re-check whether any
        // survived so the hasOverrides sentinel stays accurate.
        obj.hasOverrides = Object.keys(obj.overrides).length > 0;
        if (!obj.hasOverrides) delete obj.overrides;
    }
    return obj;
}

async function getUserPerms(userId) {
    const redis = getClient();
    const cached = await redis.get(userKey(userId));
    if (cached) return JSON.parse(cached);

    const obj = await loadUserFromDb(userId);
    if (!obj) return null;

    await redis.set(userKey(userId), JSON.stringify(obj), 'EX', USER_TTL);
    return obj;
}

async function invalidateRole(roleId) {
    await getClient().del(roleKey(roleId));
}

async function invalidateUser(userId) {
    await getClient().del(userKey(userId));
}

// Bulk-invalidate user perm caches (e.g., when a role is deleted and many
// users get reassigned). Empty array is a no-op.
async function invalidateUsers(userIds) {
    if (!userIds || userIds.length === 0) return;
    await getClient().del(...userIds.map(userKey));
}

module.exports = {
    getRolePerms,
    getUserPerms,
    invalidateRole,
    invalidateUser,
    invalidateUsers,
};
