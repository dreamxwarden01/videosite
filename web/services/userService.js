const { getPool, idBuf } = require('../config/database');
const permCache = require('./cache/permissionCache');
const userCache = require('./cache/userCache');

// Resolve the local user for an OIDC subject, or JIT-create on first login.
// user_id is BINARY(16) holding the UUIDv7 `sub`; the canonical JS form is the
// 32-char hex (sub with dashes stripped). Migrated users already have a row
// (their user_id == this sub), so they resolve on the first SELECT; only genuinely
// new SSO identities hit the INSERT.
async function findOrCreateBySub(claims) {
    const pool = getPool();
    const sub = String(claims.sub || '');
    const hexId = sub.replace(/-/g, '').toLowerCase();
    if (hexId.length !== 32 || /[^0-9a-f]/.test(hexId)) {
        throw new Error('invalid sub: ' + sub);
    }

    const [rows] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [idBuf(hexId)]);
    if (rows[0]) {
        // Profile is read-only under SSO: refresh the mirrored display_name/email
        // from the claims each login so the SSO stays the source of truth. A refresh
        // failure (e.g. an email UNIQUE clash) must never block login.
        const dn = claims.name || rows[0].display_name;
        const em = claims.email != null ? claims.email : rows[0].email;
        if (dn !== rows[0].display_name || em !== rows[0].email) {
            try {
                await pool.execute(
                    'UPDATE users SET display_name = ?, email = ? WHERE user_id = ?',
                    [dn, em, idBuf(hexId)]
                );
                await userCache.invalidate(hexId);
                rows[0].display_name = dn;
                rows[0].email = em;
            } catch (e) {
                console.error('Claim refresh skipped for', hexId, '-', e.message);
            }
        }
        return rows[0];
    }

    // JIT-create. The placeholder role is immediately overwritten by the
    // app_role claim the callback applies (the SSO refuses sign-in entirely
    // for No-access users, so a JIT user always arrives with a role claim).
    // username/display_name fall back when a claim is absent; a username
    // clash retries with a sub-derived suffix.
    const username = claims.preferred_username || ('u_' + hexId.slice(0, 8));
    const displayName = claims.name || username;
    const email = claims.email || null;
    const [[fallbackRole]] = await pool.execute(
        'SELECT role_id FROM roles ORDER BY permission_level DESC LIMIT 1'
    );
    const insertSql =
        `INSERT INTO users (user_id, username, display_name, email, role_id)
         VALUES (?, ?, ?, ?, ?)`;
    try {
        await pool.execute(insertSql, [idBuf(hexId), username, displayName, email, fallbackRole.role_id]);
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            await pool.execute(insertSql,
                [idBuf(hexId), username + '_' + hexId.slice(0, 6), displayName, email, fallbackRole.role_id]);
        } else throw e;
    }

    const [created] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [idBuf(hexId)]);
    return created[0];
}

async function getUserById(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT u.*, u.sso_avatar AS avatar, r.role_name, r.permission_level
         FROM users u JOIN roles r ON u.role_id = r.role_id
         WHERE u.user_id = ?`,
        [idBuf(userId)]
    );
    return rows[0] || null;
}

async function updateUser(userId, updates) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (updates.display_name !== undefined) { fields.push('display_name = ?'); values.push(updates.display_name); }
    if (updates.email !== undefined) { fields.push('email = ?'); values.push(updates.email); }
    if (updates.role_id !== undefined) { fields.push('role_id = ?'); values.push(updates.role_id); }

    if (fields.length === 0) return;

    values.push(idBuf(userId));
    await pool.execute(
        `UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`,
        values
    );

    // Invalidate cached permissions when role_id changes; invalidate user_meta
    // for any field change (callers always read meta on auth, so it must reflect
    // the latest display_name / email / role_id).
    if (updates.role_id !== undefined) {
        await permCache.invalidateUser(userId);
    }
    await userCache.invalidate(userId);
}

async function listUsers(actingUserLevel, page = 1, limit = 10, dir = 'DESC', search = '') {
    const pool = getPool();

    const level = parseInt(actingUserLevel);
    const lim = Math.max(1, parseInt(limit) || 10);
    // Re-whitelist the sort direction to the two literals before it is
    // interpolated into the ORDER BY — the route already does this, but the
    // service must not trust its caller for an interpolated value.
    const orderDir = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Optional search over name/handle/email. Escape LIKE metacharacters so the
    // term matches literally (a user typing "%" searches for a percent sign,
    // not a wildcard); cap length; empty/whitespace → no filter (endpoint
    // behaves exactly as before). The term ALWAYS rides a ? placeholder — never
    // interpolated — so it can't be an injection vector.
    const term = String(search || '').trim().slice(0, 100);
    const searchSql = term
        ? " AND (u.display_name LIKE ? ESCAPE '\\\\' OR u.username LIKE ? ESCAPE '\\\\' OR u.email LIKE ? ESCAPE '\\\\')"
        : '';
    const likeParams = term ? (() => { const l = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%'; return [l, l, l]; })() : [];

    // permission_level >= acting level: same-or-lower privilege, which INCLUDES
    // the acting admin (self) and same-level peers. Higher-priv users
    // (strictly lower level) stay hidden. Count and rows share BOTH the level
    // predicate and the search predicate so the pager total never desyncs.
    const [countRows] = await pool.execute(
        `SELECT COUNT(*) as total FROM users u JOIN roles r ON u.role_id = r.role_id WHERE r.permission_level >= ?${searchSql}`,
        [level, ...likeParams]
    );
    const total = countRows[0].total;
    const totalPages = Math.max(1, Math.ceil(total / lim));
    // Clamp an out-of-range page to the last page so a stale/oversized page
    // number returns the last page's rows rather than an empty set.
    const effPage = Math.min(Math.max(parseInt(page) || 1, 1), totalPages);
    const off = (effPage - 1) * lim;

    const [rows] = await pool.execute(
        `SELECT u.user_id, u.username, u.display_name, u.email, u.role_id, u.created_at,
                u.sso_avatar AS avatar,
                r.role_name, r.permission_level
         FROM users u JOIN roles r ON u.role_id = r.role_id
         WHERE r.permission_level >= ?${searchSql}
         ORDER BY r.permission_level ${orderDir},
                  u.display_name ${orderDir},
                  u.user_id ${orderDir}
         LIMIT ${lim} OFFSET ${off}`,
        [level, ...likeParams]
    );

    return {
        users: rows,
        total,
        page: effPage,
        totalPages
    };
}

module.exports = {
    findOrCreateBySub,
    getUserById,
    updateUser,
    listUsers,
};
