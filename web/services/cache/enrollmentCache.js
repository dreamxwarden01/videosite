// Per-user enrollment cache. Stores the array of course_ids the user is
// enrolled in. The playback authorization path only ever asks "is user X
// enrolled in course Y?" — a simple membership check on this list.
//
// Users with the `allCourseAccess` permission bypass enrollment entirely;
// callers should check that first and skip this cache when it's true.

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');

const TTL = 30 * 60; // 30 min
const key = (userId) => `enrollment:${userId}`;

async function loadFromDb(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT course_id FROM enrollments WHERE user_id = ?',
        [userId]
    );
    return rows.map(r => r.course_id);
}

async function getUserEnrollments(userId) {
    const redis = getClient();
    const cached = await redis.get(key(userId));
    if (cached) return JSON.parse(cached);

    const list = await loadFromDb(userId);
    await redis.set(key(userId), JSON.stringify(list), 'EX', TTL);
    return list;
}

async function isEnrolledInCourse(userId, courseId) {
    const list = await getUserEnrollments(userId);
    return list.includes(courseId);
}

async function invalidateUser(userId) {
    await getClient().del(key(userId));
}

async function invalidateMany(userIds) {
    if (!userIds || userIds.length === 0) return;
    await getClient().del(...userIds.map(key));
}

module.exports = { getUserEnrollments, isEnrolledInCourse, invalidateUser, invalidateMany };
