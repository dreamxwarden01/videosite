// Profile pictures mirrored from the SSO. users.sso_avatar holds the FILE NAME
// ({sub}-{16hex}.webp); bytes are cached on local disk and fetched S2S on a
// miss — the container filesystem is ephemeral across rebuilds, so
// fetch-on-miss IS the durability story. Names change with content, so the
// serve route can hand out a year of private+immutable caching.
const fs = require('fs/promises');
const path = require('path');
const { getPool, idBuf } = require('../config/database');
const userCache = require('./cache/userCache');

const AVATAR_DIR = process.env.AVATAR_DIR || '/app/data/avatars';
const FILE_RE = /^[0-9a-f-]{36}-[0-9a-f]{16}\.webp$/;

async function readOrFetch(file) {
    if (!FILE_RE.test(file)) return null;
    const p = path.join(AVATAR_DIR, file);
    try {
        return await fs.readFile(p);
    } catch { /* miss -> fetch from the SSO */ }
    const oidc = require('../lib/oidc');
    const buf = await oidc.fetchInternalAvatar(file);
    if (!buf || buf.length === 0) return null;
    await fs.mkdir(AVATAR_DIR, { recursive: true }).catch(() => {});
    await fs.writeFile(p, buf).catch(() => {});
    return buf;
}

async function removeLocal(file) {
    if (!file || !FILE_RE.test(file)) return;
    await fs.unlink(path.join(AVATAR_DIR, file)).catch(() => {});
}

// Apply a new avatar file name for a user (dash-less hex id): update the row,
// purge the user-meta cache, prefetch the bytes, drop the old local copy.
// No-ops when the name is unchanged. `file` null clears the picture.
async function applyAvatar(hexId, file) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT sso_avatar FROM users WHERE user_id = ?',
        [idBuf(hexId)]
    );
    if (!rows.length) return false;
    const old = rows[0].sso_avatar;
    if (old === file) return true;
    if (file != null && !FILE_RE.test(file)) return false;
    await pool.execute(
        'UPDATE users SET sso_avatar = ? WHERE user_id = ?',
        [file, idBuf(hexId)]
    );
    await userCache.invalidate(hexId);
    if (old) await removeLocal(old);
    if (file) readOrFetch(file).catch(() => {});
    return true;
}

module.exports = { applyAvatar, readOrFetch, FILE_RE };
