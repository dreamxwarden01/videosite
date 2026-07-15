const { getPool, idBuf } = require('../config/database');
const { resolvePermissions } = require('./permissionService');
const enrollmentCache = require('./cache/enrollmentCache');

async function addEnrollment(userId, courseId) {
    const pool = getPool();
    await pool.execute(
        `INSERT IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)`,
        [idBuf(userId), courseId]
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
            [idBuf(userId)]
        );
        let keepWatchProgress = false;
        if (userRows.length > 0) {
            const permissions = await resolvePermissions(userId, userRows[0].role_id);
            keepWatchProgress = permissions.allCourseAccess;
        }

        // Remove enrollment
        await conn.execute(
            'DELETE FROM enrollments WHERE user_id = ? AND course_id = ?',
            [idBuf(userId), courseId]
        );

        // Delete watch progress for this user/course unless they have allCourseAccess
        if (!keepWatchProgress) {
            await conn.execute(
                `DELETE wp FROM watch_progress wp
                 JOIN videos v ON wp.video_id = v.video_id
                 WHERE wp.user_id = ? AND v.course_id = ?`,
                [idBuf(userId), courseId]
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
        [idBuf(userId), courseId]
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
        [idBuf(userId)]
    );
    return rows;
}

// Students the acting admin may enroll — every user of strictly lower authority
// (higher permission_level) MINUS anyone who effectively has `allCourseAccess`
// (they bypass enrollment entirely, so listing them is pointless). The exclusion
// mirrors resolvePermissions' merge: a user has the permission when a force-true
// override exists (override_value = 1) OR — with no override row — their role
// grants it (a matched, granted role_permissions row). A force-false override
// (override_value = 2) leaves them enrollable. This is a UX filter only, so
// approximate parity with the cache resolver is acceptable.
//
// user_id comes back as the canonical 32-char lower-hex string via the pool's
// typeCast (BINARY(16) → hex), exactly like GET /api/admin/users.
async function getEnrollableStudents(actingUserLevel) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT u.user_id, u.username, u.display_name
         FROM users u
         JOIN roles r ON u.role_id = r.role_id
         LEFT JOIN role_permissions rp
                ON rp.role_id = u.role_id
               AND rp.permission_key = 'allCourseAccess'
               AND rp.granted = 1
         LEFT JOIN user_permission_overrides o
                ON o.user_id = u.user_id
               AND o.permission_key = 'allCourseAccess'
         WHERE r.permission_level > ?
           AND (
               -- effective allCourseAccess is FALSE: either an explicit
               -- force-off override (value 2), or no override AND the role
               -- doesn't grant it. Written as an explicit INCLUDE rather than
               -- NOT(...) because a NULL override_value makes NOT(...) itself
               -- NULL, which WHERE treats as false and would drop every user
               -- who has no override row (i.e. almost everyone).
               o.override_value = 2
               OR (o.override_value IS NULL AND rp.role_id IS NULL)
           )
         ORDER BY u.display_name ASC, u.user_id ASC`,
        [actingUserLevel]
    );
    return rows;
}

// Commit a whole set of enrollment changes for one user in ONE transaction, so
// the admin's staged adds/removes land atomically. Adds are INSERT IGNORE
// (idempotent on the (user_id, course_id) unique key); removes DELETE the
// enrollment and — replicating removeEnrollment — purge the user's
// watch_progress for that course UNLESS the user has allCourseAccess (resolved
// once, up front, exactly as removeEnrollment does). Non-integer / non-positive
// ids are dropped; add ids that don't reference a real course are filtered out
// (so an INSERT can't trip a FK error and abort the batch); a courseId present
// in BOTH lists is treated as a remove (remove wins). Returns the fresh
// enrolled course_id array (ints) so the caller can reconcile without a re-GET.
async function setEnrollmentBatch(userId, adds, removes) {
    const pool = getPool();

    const toIntSet = (arr) => {
        const set = new Set();
        if (Array.isArray(arr)) {
            for (const v of arr) {
                const n = parseInt(v, 10);
                if (Number.isInteger(n) && n > 0) set.add(n);
            }
        }
        return set;
    };

    const removeSet = toIntSet(removes);
    const addSet = toIntSet(adds);
    // Remove wins when a course is staged in both directions.
    for (const id of removeSet) addSet.delete(id);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Filter adds to ids that reference real courses so a stray/stale id
        // can't raise a FK error and roll back the whole batch. (DELETE no-ops
        // for non-existent rows, so removes need no such guard.)
        if (addSet.size > 0) {
            const ids = [...addSet];
            const placeholders = ids.map(() => '?').join(',');
            const [existing] = await conn.execute(
                `SELECT course_id FROM courses WHERE course_id IN (${placeholders})`,
                ids
            );
            const valid = new Set(existing.map((r) => r.course_id));
            for (const id of ids) if (!valid.has(id)) addSet.delete(id);
        }

        // Resolve allCourseAccess once — same condition removeEnrollment uses —
        // to decide whether removes also purge watch progress.
        const [userRows] = await conn.execute(
            'SELECT role_id FROM users WHERE user_id = ?',
            [idBuf(userId)]
        );
        let keepWatchProgress = false;
        if (userRows.length > 0) {
            const permissions = await resolvePermissions(userId, userRows[0].role_id);
            keepWatchProgress = permissions.allCourseAccess;
        }

        for (const courseId of addSet) {
            await conn.execute(
                'INSERT IGNORE INTO enrollments (user_id, course_id) VALUES (?, ?)',
                [idBuf(userId), courseId]
            );
        }

        for (const courseId of removeSet) {
            await conn.execute(
                'DELETE FROM enrollments WHERE user_id = ? AND course_id = ?',
                [idBuf(userId), courseId]
            );
            if (!keepWatchProgress) {
                await conn.execute(
                    `DELETE wp FROM watch_progress wp
                     JOIN videos v ON wp.video_id = v.video_id
                     WHERE wp.user_id = ? AND v.course_id = ?`,
                    [idBuf(userId), courseId]
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

    await enrollmentCache.invalidateUser(userId);

    const [rows] = await pool.execute(
        'SELECT course_id FROM enrollments WHERE user_id = ? ORDER BY course_id ASC',
        [idBuf(userId)]
    );
    return rows.map((r) => r.course_id);
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
    getAllUsersWithEnrollment,
    getEnrollableStudents,
    setEnrollmentBatch
};
