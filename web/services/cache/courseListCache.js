// Course LIST base cache. Holds ONE row per course — active AND inactive —
// with no enrollment join and NO per-user data whatsoever. The student home
// page composes the caller's visible list in-app from this base (filtering by
// is_active + the caller's own enrollment/permissions on every request), so we
// can share a single cached blob across all users without ever leaking one
// user's course set to another.
//
// TTL is short (60s) because last_video_at / last_material_at drift as content
// is edited; the explicit invalidate() covers the structural changes (course /
// video / material create+delete) that the 60s window shouldn't have to wait on.

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');

const TTL = 60;
const KEY = 'courses:base';

async function loadFromDb() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT c.course_id, c.course_code, c.course_name, c.module_label, c.is_active,
            (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) AS video_count,
            (SELECT MAX(COALESCE(v.updated_at, v.created_at)) FROM videos v WHERE v.course_id = c.course_id) AS last_video_at,
            (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id) AS material_count,
            (SELECT MAX(m.created_at) FROM course_materials m WHERE m.course_id = c.course_id) AS last_material_at
         FROM courses c
         ORDER BY c.course_code ASC`
    );
    return rows;
}

async function getBase() {
    const redis = getClient();
    const cached = await redis.get(KEY);
    if (cached) return JSON.parse(cached);

    const rows = await loadFromDb();
    await redis.set(KEY, JSON.stringify(rows), 'EX', TTL);
    return rows;
}

async function invalidate() {
    await getClient().del(KEY);
}

module.exports = { getBase, invalidate };
