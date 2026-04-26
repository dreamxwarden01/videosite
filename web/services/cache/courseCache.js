// Course metadata cache. Courses change rarely (admin-driven renames /
// description edits), so a 30-min TTL with explicit invalidation gives
// near-100% hit rate on the watch page's course-name lookup.

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');

const TTL = 30 * 60;
const key = (id) => `course:meta:${id}`;

async function loadFromDb(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT course_id, course_name, description, is_active FROM courses WHERE course_id = ?',
        [courseId]
    );
    return rows[0] || null;
}

async function getCourseMeta(courseId) {
    const redis = getClient();
    const cached = await redis.get(key(courseId));
    if (cached) return JSON.parse(cached);

    const row = await loadFromDb(courseId);
    if (!row) return null;

    await redis.set(key(courseId), JSON.stringify(row), 'EX', TTL);
    return row;
}

async function invalidate(courseId) {
    await getClient().del(key(courseId));
}

module.exports = { getCourseMeta, invalidate };
