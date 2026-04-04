const { getPool } = require('../config/database');

async function listRoles() {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM roles ORDER BY permission_level ASC, role_id ASC, role_name ASC'
    );
    return rows;
}

async function getRoleById(roleId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM roles WHERE role_id = ?',
        [roleId]
    );
    return rows[0] || null;
}

async function createRole(roleId, roleName, permissionLevel, description = null) {
    const pool = getPool();
    await pool.execute(
        `INSERT INTO roles (role_id, role_name, permission_level, description)
         VALUES (?, ?, ?, ?)`,
        [roleId, roleName, permissionLevel, description]
    );
}

async function updateRole(roleId, updates) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // If role_id is being changed, we need special handling due to foreign keys
        if (updates.role_id !== undefined && updates.role_id !== roleId) {
            const newId = updates.role_id;

            const [current] = await conn.execute('SELECT * FROM roles WHERE role_id = ?', [roleId]);
            if (current.length === 0) throw new Error('Role not found');
            const role = current[0];

            // Create new role entry with the new ID
            await conn.execute(
                `INSERT INTO roles (role_id, role_name, permission_level, description, is_system, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    newId,
                    updates.role_name !== undefined ? updates.role_name : role.role_name,
                    updates.permission_level !== undefined ? updates.permission_level : role.permission_level,
                    updates.description !== undefined ? updates.description : role.description,
                    role.is_system,
                    role.created_at
                ]
            );

            // Migrate role_permissions
            const [perms] = await conn.execute('SELECT permission_key, granted FROM role_permissions WHERE role_id = ?', [roleId]);
            for (const p of perms) {
                await conn.execute(
                    'INSERT INTO role_permissions (role_id, permission_key, granted) VALUES (?, ?, ?)',
                    [newId, p.permission_key, p.granted]
                );
            }

            // Update users to the new role_id
            await conn.execute('UPDATE users SET role_id = ? WHERE role_id = ?', [newId, roleId]);

            // Delete old role_permissions and old role
            await conn.execute('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
            await conn.execute('DELETE FROM roles WHERE role_id = ?', [roleId]);
        } else {
            // Simple field updates (no role_id change)
            const fields = [];
            const values = [];

            if (updates.role_name !== undefined) { fields.push('role_name = ?'); values.push(updates.role_name); }
            if (updates.permission_level !== undefined) { fields.push('permission_level = ?'); values.push(updates.permission_level); }
            if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }

            if (fields.length > 0) {
                values.push(roleId);
                await conn.execute(
                    `UPDATE roles SET ${fields.join(', ')} WHERE role_id = ?`,
                    values
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

async function deleteRole(roleId) {
    const pool = getPool();
    // Check if it's a system role
    const [rows] = await pool.execute(
        'SELECT is_system FROM roles WHERE role_id = ?',
        [roleId]
    );
    if (rows.length === 0) throw new Error('Role not found');
    if (rows[0].is_system) throw new Error('Cannot delete system role');

    // Reassign any users with this role to the default "user" role (id=2)
    await pool.execute('UPDATE users SET role_id = 2 WHERE role_id = ?', [roleId]);

    await pool.execute('DELETE FROM roles WHERE role_id = ?', [roleId]);
}

async function roleIdExists(roleId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT 1 FROM roles WHERE role_id = ?',
        [roleId]
    );
    return rows.length > 0;
}

async function roleNameExists(roleName, excludeRoleId = null) {
    const pool = getPool();
    if (excludeRoleId !== null) {
        const [rows] = await pool.execute(
            'SELECT 1 FROM roles WHERE role_name = ? AND role_id != ?',
            [roleName, excludeRoleId]
        );
        return rows.length > 0;
    }
    const [rows] = await pool.execute(
        'SELECT 1 FROM roles WHERE role_name = ?',
        [roleName]
    );
    return rows.length > 0;
}

async function permissionLevelExists(level, excludeRoleId = null) {
    const pool = getPool();
    if (excludeRoleId !== null) {
        const [rows] = await pool.execute(
            'SELECT 1 FROM roles WHERE permission_level = ? AND role_id != ?',
            [level, excludeRoleId]
        );
        return rows.length > 0;
    }
    const [rows] = await pool.execute(
        'SELECT 1 FROM roles WHERE permission_level = ?',
        [level]
    );
    return rows.length > 0;
}

// Get roles that can be assigned by a user with given permission level
async function getAssignableRoles(actingUserLevel) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM roles WHERE permission_level > ? ORDER BY permission_level ASC, role_id ASC, role_name ASC',
        [actingUserLevel]
    );
    return rows;
}

module.exports = {
    listRoles,
    getRoleById,
    createRole,
    updateRole,
    deleteRole,
    roleIdExists,
    roleNameExists,
    permissionLevelExists,
    getAssignableRoles
};
