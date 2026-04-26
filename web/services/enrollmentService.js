const { getPool } = require('../config/database');
const { resolvePermissions } = require('./permissionService');
const enrollmentCache = require('./cache/enrollmentCache');

async function addEnrollment(userId, courseId) {
    const pool = getPool();
    await pool.execute(
        `INSERT IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)`,
        [userId, courseId]
    );
    await enrollmentCache.invalidateUser(userId);
}

async function removeEnrollment(userId, courseId) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Check if user has allCourseAccess (if so, don't delete watch progress)
        const [userRows] = await conn.execute(
            'SELECT role_id FROM users WHERE user_id = ?',
            [userId]
        );
        let keepWatchProgress = false;
        if (userRows.length > 0) {
            const permissions = await resolvePermissions(userId, userRows[0].role_id);
            keepWatchProgress = permissions.allCourseAccess;
        }

        // Remove enrollment
        await conn.execute(
            'DELETE FROM enrollments WHERE user_id = ? AND course_id = ?',
            [userId, courseId]
        );

        // Delete watch progress for this user/course unless they have allCourseAccess
        if (!keepWatchProgress) {
            await conn.execute(
                `DELETE wp FROM watch_progress wp
                 JOIN videos v ON wp.video_id = v.video_id
                 WHERE wp.user_id = ? AND v.course_id = ?`,
                [userId, courseId]
            );
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }

    await enrollmentCache.invalidateUser(userId);
}

async function isEnrolled(userId, courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
        [userId, courseId]
    );
    return rows.length > 0;
}

async function getCourseEnrollments(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT u.user_id, u.username, u.display_name, u.role_id, r.role_name, r.permission_level, e.enrolled_at
         FROM enrollments e
         JOIN users u ON e.user_id = u.user_id
         JOIN roles r ON u.role_id = r.role_id
         WHERE e.course_id = ?
         ORDER BY e.enrolled_at DESC`,
        [courseId]
    );
    return rows;
}

async function getUserEnrollments(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT c.* FROM courses c
         JOIN enrollments e ON c.course_id = e.course_id
         WHERE e.user_id = ?
         ORDER BY e.enrolled_at DESC`,
        [userId]
    );
    return rows;
}

// Get all users with their enrollment status for a course
async function getAllUsersWithEnrollment(courseId, actingUserLevel) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT u.user_id, u.username, u.display_name, u.role_id,
                r.role_name, r.permission_level,
                IF(e.enrollment_id IS NOT NULL, 1, 0) as is_enrolled
         FROM users u
         JOIN roles r ON u.role_id = r.role_id
         LEFT JOIN enrollments e ON u.user_id = e.user_id AND e.course_id = ?
         WHERE r.permission_level > ?
         ORDER BY u.username`,
        [courseId, actingUserLevel]
    );
    return rows;
}

module.exports = {
    addEnrollment,
    removeEnrollment,
    isEnrolled,
    getCourseEnrollments,
    getUserEnrollments,
    getAllUsersWithEnrollment
};
