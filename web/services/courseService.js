const { getPool } = require('../config/database');
const videoCache = require('./cache/videoCache');
const courseCache = require('./cache/courseCache');

async function createCourse(courseName, description, createdBy) {
    const pool = getPool();

    const [result] = await pool.execute(
        `INSERT INTO courses (course_name, description, created_by) VALUES (?, ?, ?)`,
        [courseName, description || null, createdBy]
    );

    return { courseId: result.insertId };
}

async function getCourseById(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM courses WHERE course_id = ?',
        [courseId]
    );
    return rows[0] || null;
}

async function updateCourse(courseId, updates) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (updates.course_name !== undefined) { fields.push('course_name = ?'); values.push(updates.course_name); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.is_active !== undefined) { fields.push('is_active = ?'); values.push(updates.is_active); }

    if (fields.length === 0) return;
    values.push(courseId);

    await pool.execute(
        `UPDATE courses SET ${fields.join(', ')} WHERE course_id = ?`,
        values
    );

    await courseCache.invalidate(courseId);
}

/**
 * Delete a course with 404-based worker abort + R2 cleanup for all its videos.
 *
 * Flow:
 * 1. Pre-fetch course info, all video info (hashed IDs + status), active jobs
 * 2. Clear stale timers for all active jobs
 * 3. DELETE course (FK cascade removes videos, processing_queue → workers get 404)
 * 4. For each video:
 *    - Source file: always cleaned immediately
 *    - HLS output: delayed 2 min if video was processing, immediate otherwise
 */
async function deleteCourse(courseId) {
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');
    const { clearStaleTimer } = require('./processingService');

    // 1. Get all videos with hashed IDs, source key, and status (need for R2 cleanup)
    const [videos] = await pool.execute(
        'SELECT video_id, hashed_video_id, r2_source_key, status FROM videos WHERE course_id = ?',
        [courseId]
    );

    // 3. Get active jobs for stale timer clearance
    const [activeJobs] = await pool.execute(
        `SELECT pq.job_id FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE v.course_id = ? AND pq.status IN ('leased', 'processing') AND pq.job_id IS NOT NULL`,
        [courseId]
    );

    // 4. Clear stale timers for all active jobs
    for (const job of activeJobs) {
        clearStaleTimer(job.job_id);
    }
    // Drop heartbeat cache so workers' next status ping detects the abort.
    await require('./cache/transcodeProgressCache').clearJobs(activeJobs.map(j => j.job_id));

    // 5. Delete course record — FK cascade deletes videos, processing_queue,
    //    watch_progress, enrollments → workers get 404
    await pool.execute('DELETE FROM courses WHERE course_id = ?', [courseId]);

    // Invalidate cached video meta for every cascade-deleted video, plus the course itself.
    const videoIds = videos.map(v => v.video_id);
    await videoCache.invalidateMany(videoIds);
    await courseCache.invalidate(courseId);
    // Also drop watch-progress cache for the cascade-deleted videos so resume
    // doesn't point to a vanished row.
    await require('./cache/watchProgressCache').clearForVideos(videoIds);

    // 6. R2 cleanup for all video prefixes (fire-and-forget)
    const processingStatuses = ['worker_downloading', 'processing', 'worker_uploading'];
    for (const video of videos) {
        const isProcessing = processingStatuses.includes(video.status);

        // Source file: always clean immediately (extract directory from r2_source_key)
        if (video.r2_source_key) {
            const sourceDir = video.r2_source_key.substring(0, video.r2_source_key.lastIndexOf('/') + 1);
            cleanR2Prefix(sourceDir).catch(err => {
                console.error(`R2 source cleanup failed for video ${video.video_id}:`, err.message);
            });
        }

        if (isProcessing) {
            // HLS output: delay 2 minutes for worker to stop uploading
            const vid = video; // capture for closure
            const timer = setTimeout(() => {
                cleanR2Prefix(`${vid.hashed_video_id}/`).catch(err => {
                    console.error(`R2 HLS cleanup failed for video ${vid.video_id}:`, err.message);
                });
            }, 2 * 60 * 1000);
            if (timer.unref) timer.unref();
        } else {
            // Not processing: clean HLS output immediately
            cleanR2Prefix(`${video.hashed_video_id}/`).catch(err => {
                console.error(`R2 HLS cleanup failed for video ${video.video_id}:`, err.message);
            });
        }
    }

    // 7. Clean all course material files from R2 (fire-and-forget)
    // DB records already removed by FK CASCADE on course_materials.course_id
    cleanR2Prefix(`attachments/${courseId}/`).catch(err => {
        console.error(`R2 materials cleanup failed for course ${courseId}:`, err.message);
    });
}

async function listCourses(page = 1, limit = 10) {
    const pool = getPool();
    const offset = (page - 1) * limit;

    const lim = parseInt(limit);
    const off = parseInt(offset);
    const [countRows] = await pool.execute('SELECT COUNT(*) as total FROM courses');
    const [rows] = await pool.query(
        `SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) as video_count
         FROM courses c ORDER BY c.created_at DESC LIMIT ${lim} OFFSET ${off}`
    );

    return {
        courses: rows,
        total: countRows[0].total,
        page,
        totalPages: Math.ceil(countRows[0].total / limit)
    };
}

// List courses the user has access to (for admin views that require course enrollment)
async function listUserCourses(userId, hasAllCourseAccess) {
    const pool = getPool();
    if (hasAllCourseAccess) {
        const [rows] = await pool.execute(
            'SELECT * FROM courses ORDER BY created_at DESC'
        );
        return rows;
    }

    const [rows] = await pool.execute(
        `SELECT c.* FROM courses c
         JOIN enrollments e ON c.course_id = e.course_id
         WHERE e.user_id = ?
         ORDER BY c.created_at DESC`,
        [userId]
    );
    return rows;
}

module.exports = {
    createCourse,
    getCourseById,
    updateCourse,
    deleteCourse,
    listCourses,
    listUserCourses
};
