const { getPool, idBuf } = require('../config/database');
const permCache = require('./cache/permissionCache');
const userCache = require('./cache/userCache');
const { subject, profileText } = require('../lib/ssoRoleProtocol');
const { randomBytes } = require('node:crypto');

// A subject is the identity. Names and email are mirrors, and a stale mirror
// belonging to another subject must never make us merge or overwrite that row.
// The caller can include this insert in the authority/inbox transaction.
async function createMissingBySub(sub, profile, roleId, { connection = null } = {}) {
    sub = subject(sub);
    const hexId = sub.replace(/-/g, '');
    const db = connection || getPool();
    const id = idBuf(hexId);
    const read = async () => {
        const [[row]] = await db.execute('SELECT * FROM users WHERE user_id=? FOR UPDATE', [id]);
        return row;
    };
    // A nonlocking first read avoids locking an absent PK gap while another
    // first-login transaction is creating the same subject.
    const [[existing]] = await db.execute('SELECT * FROM users WHERE user_id=?', [id]);
    if (existing) return { user: existing, created: false };
    const fallback = 'u_' + hexId;
    let username = profileText(profile.preferred_username, 50) ? profile.preferred_username : fallback;
    let usedStableFallback = username === fallback;
    const displayName = profileText(profile.name, 100) ? profile.name : username;
    let email = profileText(profile.email, 254) ? profile.email : null;
    const picture = typeof profile.picture === 'string'
        && new RegExp('^' + sub + '-[0-9a-f]{16}\\.webp$').test(profile.picture) ? profile.picture : null;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await db.execute(`INSERT INTO users(user_id,username,display_name,email,sso_avatar,role_id)
                VALUES(?,?,?,?,?,?)`, [id, username, displayName, email, picture, roleId]);
            return { user: await read(), created: true };
        } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY') throw error;
            // Locking reads see a concurrent winner even under REPEATABLE READ.
            const winner = await read();
            if (winner) return { user: winner, created: false };
            let changed = false;
            const [[otherUsername]] = await db.execute('SELECT user_id FROM users WHERE username=? FOR UPDATE', [username]);
            if (otherUsername) {
                // Legacy data may already own even the subject-derived name.
                // Keep the UUID identity and choose another local mirror name;
                // 34 + 1 + 14 = 49 characters, within users.username's limit.
                username = usedStableFallback ? fallback + '_' + randomBytes(7).toString('hex') : fallback;
                usedStableFallback = true;
                changed = true;
            }
            if (email !== null) {
                const [[other]] = await db.execute('SELECT user_id FROM users WHERE email=? FOR UPDATE', [email]);
                if (other) { email = null; changed = true; }
            }
            if (!changed) throw error;
        }
    }
    throw new Error('user_mirror_conflict');
}

// The authority record is the access state; do not maintain another mutable
// active flag on users. Legacy users without a confirmed observation are unknown.
const ACCESS_JOIN = `LEFT JOIN sso_role_authority a ON a.subject_id=LOWER(CONCAT(
    SUBSTR(HEX(u.user_id),1,8),'-',SUBSTR(HEX(u.user_id),9,4),'-',SUBSTR(HEX(u.user_id),13,4),'-',
    SUBSTR(HEX(u.user_id),17,4),'-',SUBSTR(HEX(u.user_id),21,12)))`;
const ACCESS_STATUS = `CASE
    WHEN a.account_status IN ('disabled','locked','deleted') THEN a.account_status
    WHEN a.account_status='not_found' THEN 'deleted'
    WHEN a.refresh_pending=1 OR a.effects_pending=1 THEN 'pending'
    WHEN a.blocked=1 THEN 'no_access'
    WHEN a.authority_epoch IS NOT NULL AND a.role_id IS NOT NULL THEN 'active'
    ELSE 'unknown' END AS access_status`;

async function refreshLoginProfile(pool, hexId, claims, user) {
    // Only an authenticated login refreshes an existing profile. In particular,
    // this also runs when an older event seed wins a first-login insert race.
    const displayName = profileText(claims.name, 100) ? claims.name : user.display_name;
    let email = profileText(claims.email, 254) ? claims.email : user.email;
    if (displayName === user.display_name && email === user.email) return user;
    try {
        await pool.execute('UPDATE users SET display_name = ?, email = ? WHERE user_id = ?',
            [displayName, email, idBuf(hexId)]);
    } catch (error) {
        // This statement updates no other unique field. A stale email mirror
        // on another subject is not an identity link and must never merge rows.
        // Still refresh the name, and leave the conflicting email unclaimed.
        if (error.code !== 'ER_DUP_ENTRY' || email === null) {
            console.warn('sso_login_profile_refresh_failed');
            return user;
        }
        email = null;
        try {
            await pool.execute('UPDATE users SET display_name = ?, email = ? WHERE user_id = ?',
                [displayName, email, idBuf(hexId)]);
        } catch {
            console.warn('sso_login_profile_refresh_failed');
            return user;
        }
        console.warn('sso_login_profile_email_conflict');
    }
    user.display_name = displayName;
    user.email = email;
    await userCache.invalidate(hexId).catch(() => console.warn('sso_login_profile_cache_refresh_failed'));
    return user;
}

// Resolve the local user for an OIDC subject, or JIT-create on first login.
// user_id is BINARY(16) holding the UUIDv7 `sub`; the canonical JS form is the
// 32-char hex (sub with dashes stripped). Migrated users already have a row
// (their user_id == this sub), so they resolve on the first SELECT; only genuinely
// new SSO identities hit the INSERT.
async function findOrCreateBySub(claims) {
    const pool = getPool();
    const sub = subject(claims.sub);
    const hexId = sub.replace(/-/g, '').toLowerCase();

    const [rows] = await pool.execute('SELECT * FROM users WHERE user_id = ?', [idBuf(hexId)]);
    if (rows[0]) {
        return refreshLoginProfile(pool, hexId, claims, rows[0]);
    }

    // JIT-create. The placeholder role is immediately overwritten by the
    // app_role claim the callback applies (the SSO refuses sign-in entirely
    // for No-access users, so a JIT user always arrives with a role claim).
    // username/display_name fall back when a claim is absent; a username
    // clash uses a bounded subject-derived name instead of changing identity.
    const [[fallbackRole]] = await pool.execute(
        'SELECT role_id FROM roles ORDER BY permission_level DESC LIMIT 1'
    );
    if (!fallbackRole) throw new Error('role_out_of_sync');
    const result = await createMissingBySub(sub, claims, fallbackRole.role_id);
    return refreshLoginProfile(pool, hexId, claims, result.user);
}

async function getUserById(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT u.*, u.sso_avatar AS avatar, r.role_name, r.permission_level, ${ACCESS_STATUS}
         FROM users u JOIN roles r ON u.role_id = r.role_id
         ${ACCESS_JOIN}
         WHERE u.user_id = ?`,
        [idBuf(userId)]
    );
    return rows[0] || null;
}

async function updateUser(userId, updates, { connection = null, invalidate = true } = {}) {
    const pool = connection || getPool();
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
    if (!invalidate) return;
    if (updates.role_id !== undefined) {
        await permCache.invalidateUser(userId);
    }
    await userCache.invalidate(userId);
}

async function invalidateUserCaches(userId) {
    await permCache.invalidateUser(userId);
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
                r.role_name, r.permission_level, ${ACCESS_STATUS}
         FROM users u JOIN roles r ON u.role_id = r.role_id
         ${ACCESS_JOIN}
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
    createMissingBySub,
    findOrCreateBySub,
    getUserById,
    updateUser,
    invalidateUserCaches,
    listUsers,
};
