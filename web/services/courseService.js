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
 * Delete a course with 404-based worker abort + queued R2 cleanup for all
 * its videos and attachments.
 *
 * Flow:
 * 1. Pre-fetch video info (hashed IDs + status + r2_source_key)
 * 2. Pre-fetch active processing jobs (for stale-timer clearance) and
 *    in-flight upload sessions (for multipart abort)
 * 3. Abort in-flight multipart uploads (fire-and-forget; R2's 24h
 *    lifecycle catches stragglers)
 * 4. Clear stale timers + heartbeat cache so workers detect the abort
 * 5. DELETE course (FK cascade removes videos, processing_queue,
 *    upload_sessions, course_materials → workers get 404)
 * 6. Enqueue R2 cleanup rows in pending_deletes:
 *    - Source prefix per video — immediate
 *    - Output prefix per video — 2-min delay if mid-processing, else immediate
 *    - Attachments prefix for the course — immediate
 */
async function deleteCourse(courseId) {
    const pool = getPool();
    const { clearStaleTimer } = require('./processingService');
    const { abortMultipartUpload } = require('./uploadService');
    const deletionService = require('./deletionService');

    // 1. Get all videos (need hashed IDs, source key, and status for R2 cleanup planning)
    const [videos] = await pool.execute(
        'SELECT video_id, hashed_video_id, r2_source_key, status FROM videos WHERE course_id = ?',
        [courseId]
    );

    // 2a. Get active jobs for stale-timer clearance
    const [activeJobs] = await pool.execute(
        `SELECT pq.job_id FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE v.course_id = ? AND pq.status IN ('leased', 'processing') AND pq.job_id IS NOT NULL`,
        [courseId]
    );

    // 2b. Get in-flight upload sessions for this course's videos
    const [inflightSessions] = await pool.execute(
        `SELECT object_key, r2_upload_id FROM upload_sessions
         WHERE course_id = ? AND status IN ('active', 'completing')`,
        [courseId]
    );

    // 3. Abort in-flight multipart uploads (fire-and-forget). R2's bucket
    //    lifecycle covers anything that fails here within 24 hours.
    for (const session of inflightSessions) {
        abortMultipartUpload(session.object_key, session.r2_upload_id).catch(err => {
            console.error(`R2 multipart abort failed for upload ${session.r2_upload_id}:`, err.message);
        });
    }

    // 4. Clear stale timers + heartbeat cache so workers' next status ping
    //    detects the abort cleanly (avoids the 2-minute stale-timeout wait).
    for (const job of activeJobs) {
        clearStaleTimer(job.job_id);
    }
    await require('./cache/transcodeProgressCache').clearJobs(activeJobs.map(j => j.job_id));

    // 5. Delete course record — FK cascade deletes videos, processing_queue,
    //    upload_sessions, course_materials, watch_progress, enrollments,
    //    transcoding_profiles → workers get 404 on next API call
    await pool.execute('DELETE FROM courses WHERE course_id = ?', [courseId]);

    // Invalidate caches for every cascade-deleted video + the course itself.
    const videoIds = videos.map(v => v.video_id);
    await videoCache.invalidateMany(videoIds);
    await courseCache.invalidate(courseId);
    await require('./cache/watchProgressCache').clearForVideos(videoIds);

    // 6. Enqueue R2 cleanup. All durable — reaper retries on transient
    //    R2 failures, survives server restarts.
    const processingStatuses = ['worker_downloading', 'processing', 'worker_uploading'];
    const now = new Date();
    const delayedAt = new Date(Date.now() + 2 * 60 * 1000); // +2 min for in-flight workers

    for (const video of videos) {
        // Source: always immediate (worker has already downloaded what it needs).
        if (video.r2_source_key) {
            const sourceDir = video.r2_source_key.substring(0, video.r2_source_key.lastIndexOf('/') + 1);
            await deletionService.enqueuePrefix(sourceDir, { source: 'course_delete' });
        }

        // Output: 2-min delay if mid-processing (let worker finish its upload),
        // immediate otherwise. Hash collision check at video creation time
        // closes the race with new uploads picking the same hash.
        const isProcessing = processingStatuses.includes(video.status);
        await deletionService.enqueuePrefix(`${video.hashed_video_id}/`, {
            hashed_video_id: video.hashed_video_id,
            execute_at: isProcessing ? delayedAt : now,
            source: 'course_delete',
        });
    }

    // Attachments: one prefix for all course materials.
    // DB rows are gone via FK CASCADE on course_materials.course_id.
    await deletionService.enqueuePrefix(`attachments/${courseId}/`, { source: 'course_delete' });
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
