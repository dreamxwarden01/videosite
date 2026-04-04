const { getPool } = require('../config/database');

// All permission keys in the system
const ALL_PERMISSIONS = [
    'allowPlayback',
    'changeOwnPassword',
    'allCourseAccess',
    'manageCourse',
    'addCourse',
    'changeCourse',
    'deleteCourse',
    'manageEnrolment',
    'uploadVideo',
    'changeVideo',
    'deleteVideo',
    'manageUser',
    'addUser',
    'changeUser',
    'deleteUser',
    'viewPlaybackStat',
    'clearPlaybackStat',
    'changeUserPermission',
    'manageSite',
    'manageRoles',
    'inviteUser',
    'requireMFA',
    'manageSiteMFA'
];

// Resolve effective permissions for a user
// 1. Check user_permission_overrides (1=true, 2=false)
// 2. Fall through to role_permissions
// 3. Default to false
async function resolvePermissions(userId, roleId) {
    const pool = getPool();

    const [rolePerms] = await pool.execute(
        'SELECT permission_key, granted FROM role_permissions WHERE role_id = ?',
        [roleId]
    );

    const [overrides] = await pool.execute(
        'SELECT permission_key, override_value FROM user_permission_overrides WHERE user_id = ?',
        [userId]
    );

    const effective = {};

    // Start with all permissions as false
    for (const key of ALL_PERMISSIONS) {
        effective[key] = false;
    }

    // Apply role permissions
    for (const rp of rolePerms) {
        effective[rp.permission_key] = rp.granted === 1;
    }

    // Apply user overrides (take precedence)
    for (const ov of overrides) {
        if (ov.override_value === 1) {
            effective[ov.permission_key] = true;
        } else if (ov.override_value === 2) {
            effective[ov.permission_key] = false;
        }
    }

    return effective;
}

// Get role permissions only (for role management)
async function getRolePermissions(roleId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT permission_key, granted FROM role_permissions WHERE role_id = ?',
        [roleId]
    );

    const perms = {};
    for (const key of ALL_PERMISSIONS) {
        perms[key] = false;
    }
    for (const row of rows) {
        perms[row.permission_key] = row.granted === 1;
    }
    return perms;
}

// Get user overrides only (for user management)
async function getUserOverrides(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT permission_key, override_value FROM user_permission_overrides WHERE user_id = ?',
        [userId]
    );

    const overrides = {};
    for (const row of rows) {
        overrides[row.permission_key] = row.override_value;
    }
    return overrides;
}

// Set a user permission override
async function setUserOverride(userId, permissionKey, value) {
    const pool = getPool();

    if (value === 0) {
        // Remove override (inherit from role)
        await pool.execute(
            'DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_key = ?',
            [userId, permissionKey]
        );
    } else {
        // Upsert override
        await pool.execute(
            `INSERT INTO user_permission_overrides (user_id, permission_key, override_value)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE override_value = VALUES(override_value)`,
            [userId, permissionKey, value]
        );
    }
}

// Set role permissions (replace all)
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
}

module.exports = {
    ALL_PERMISSIONS,
    resolvePermissions,
    getRolePermissions,
    getUserOverrides,
    setUserOverride,
    setRolePermissions
};
