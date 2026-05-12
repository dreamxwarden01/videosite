const crypto = require('crypto');
const { getPool } = require('../config/database');
const videoCache = require('./cache/videoCache');

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a unique 64-character base62 hashed video ID.
 *
 * Checks both the `videos` table (live uniqueness) and `pending_deletes`
 * (pending hash, scheduled for R2 cleanup) so a new video can't pick up a
 * hash that the deletion reaper is about to nuke. The 62^64 space is
 * astronomically large; the loop terminates on the first iteration in all
 * realistic cases — the check is defense, not a hot path.
 */
async function generateHashedVideoId() {
    const pool = getPool();
    for (let i = 0; i < 10; i++) {
        const bytes = crypto.randomBytes(64);
        let id = '';
        for (let j = 0; j < bytes.length && id.length < 64; j++) {
            id += BASE62[bytes[j] % 62];
        }

        const [existing] = await pool.execute(
            `SELECT 1 FROM videos          WHERE hashed_video_id = ?
             UNION ALL
             SELECT 1 FROM pending_deletes WHERE hashed_video_id = ?
             LIMIT 1`,
            [id, id]
        );
        if (existing.length === 0) return id;
    }
    throw new Error('Failed to generate unique hashed video ID');
}

/**
 * Create a video record. Accepts a pre-generated hashed_video_id and r2_source_key
 * in options (used by upload complete). If not provided, generates a new hash.
 *
 * options.video_type: 'ts' | 'cmaf'. Defaults to 'ts'. Upload flows will
 * override this to 'cmaf' once the CMAF pipeline is fully deployed (phase 4).
 */
async function createVideo(courseId, title, options = {}) {
    const pool = getPool();

    const hashedVideoId = options.hashed_video_id || await generateHashedVideoId();
    const videoType = options.video_type === 'cmaf' ? 'cmaf' : 'ts';

    const [result] = await pool.execute(
        `INSERT INTO videos (course_id, title, description, week, lecture_date,
         original_filename, file_size_bytes, uploaded_by, hashed_video_id, r2_source_key, video_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            courseId, title,
            options.description || null,
            options.week || null,
            options.lecture_date || null,
            options.original_filename || null,
            options.file_size_bytes || null,
            options.uploaded_by || null,
            hashedVideoId,
            options.r2_source_key || null,
            videoType
        ]
    );

    return { videoId: result.insertId, hashedVideoId };
}

async function getVideoById(videoId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT v.*, c.course_name
         FROM videos v JOIN courses c ON v.course_id = c.course_id
         WHERE v.video_id = ?`,
        [videoId]
    );
    return rows[0] || null;
}

async function updateVideo(videoId, updates) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.week !== undefined) { fields.push('week = ?'); values.push(updates.week); }
    if (updates.lecture_date !== undefined) { fields.push('lecture_date = ?'); values.push(updates.lecture_date); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.processing_job_id !== undefined) { fields.push('processing_job_id = ?'); values.push(updates.processing_job_id); }
    if (updates.processing_progress !== undefined) { fields.push('processing_progress = ?'); values.push(updates.processing_progress); }
    if (updates.processing_error !== undefined) { fields.push('processing_error = ?'); values.push(updates.processing_error); }
    if (updates.duration_seconds !== undefined) { fields.push('duration_seconds = ?'); values.push(updates.duration_seconds); }
    if (updates.r2_source_key !== undefined) { fields.push('r2_source_key = ?'); values.push(updates.r2_source_key); }
    if (updates.video_type !== undefined) {
        // Only 'ts' or 'cmaf' are valid; everything else is silently ignored.
        const vt = updates.video_type === 'cmaf' ? 'cmaf' : (updates.video_type === 'ts' ? 'ts' : null);
        if (vt !== null) { fields.push('video_type = ?'); values.push(vt); }
    }

    if (fields.length === 0) return;
    values.push(videoId);

    await pool.execute(
        `UPDATE videos SET ${fields.join(', ')} WHERE video_id = ?`,
        values
    );

    await videoCache.invalidate(videoId);
}

/**
 * Delete a video with 404-based worker abort + queued R2 cleanup.
 *
 * Flow:
 * 1. Pre-fetch video info (hashed ID, source key, status) and any active job
 * 2. Abort the video's in-flight multipart upload, if any (fire-and-forget)
 * 3. Clear stale timer + heartbeat cache for active job
 * 4. DELETE video (FK cascade removes processing_queue, upload_sessions →
 *    worker gets 404 on next call)
 * 5. Enqueue R2 cleanup in pending_deletes:
 *    - Source prefix — immediate
 *    - Output prefix — 2-min delay if mid-processing, else immediate
 */
async function deleteVideo(videoId) {
    const pool = getPool();
    const { clearStaleTimer } = require('./processingService');
    const { abortMultipartUpload } = require('./uploadService');
    const deletionService = require('./deletionService');

    // 1. Pre-fetch video info (need it for R2 cleanup planning, before DB cascade)
    const [videoRows] = await pool.execute(
        `SELECT hashed_video_id, r2_source_key, status FROM videos WHERE video_id = ?`,
        [videoId]
    );

    // 2a. Get active job_id for stale-timer clearance + heartbeat-cache eviction
    const [taskRows] = await pool.execute(
        `SELECT job_id FROM processing_queue
         WHERE video_id = ? AND status IN ('leased', 'processing') AND job_id IS NOT NULL`,
        [videoId]
    );

    // 2b. Get in-flight upload session (if any) so we can abort the multipart.
    // Video sessions only here — attachment sessions don't reference video_id.
    const [inflightSessions] = await pool.execute(
        `SELECT upload_id, object_key, r2_upload_id FROM upload_sessions
         WHERE video_id = ? AND status IN ('active', 'completing')
           AND type = 'video'`,
        [videoId]
    );

    // 3. Abort in-flight multipart upload (fire-and-forget — R2's lifecycle
    //    cleans up parts within 24h if this fails). Also drop the Redis
    //    heartbeat cache so the next client tick gets a 404.
    const uploadHeartbeatCache = require('./cache/uploadHeartbeatCache');
    for (const session of inflightSessions) {
        abortMultipartUpload(session.object_key, session.r2_upload_id).catch(err => {
            console.error(`R2 multipart abort failed for upload ${session.r2_upload_id}:`, err.message);
        });
        await uploadHeartbeatCache.clearHeartbeat(session.upload_id);
    }

    // 4. Clear stale timer for active job
    if (taskRows.length > 0 && taskRows[0].job_id) {
        clearStaleTimer(taskRows[0].job_id);
    }

    // 5. Delete DB record (FK cascade removes processing_queue, upload_sessions
    //    → worker gets 404 on next API call)
    await pool.execute('DELETE FROM videos WHERE video_id = ?', [videoId]);
    await videoCache.invalidate(videoId);
    await require('./cache/watchProgressCache').clearForVideo(videoId);
    // Drop heartbeat cache so the worker's next status ping detects the abort.
    if (taskRows.length > 0 && taskRows[0].job_id) {
        await require('./cache/transcodeProgressCache').clearJob(taskRows[0].job_id);
    }

    // 6. Enqueue R2 cleanup. Reaper retries on transient R2 failures and
    //    survives server restarts.
    if (videoRows.length > 0) {
        const { hashed_video_id, r2_source_key, status } = videoRows[0];
        const isProcessing = ['worker_downloading', 'processing', 'worker_uploading'].includes(status);

        // Source file: always immediate (extract directory from r2_source_key).
        if (r2_source_key) {
            const sourceDir = r2_source_key.substring(0, r2_source_key.lastIndexOf('/') + 1);
            await deletionService.enqueuePrefix(sourceDir, { source: 'video_delete' });
        }

        // Output: 2-min delay if mid-processing (let worker finish its upload),
        // immediate otherwise.
        const executeAt = isProcessing
            ? new Date(Date.now() + 2 * 60 * 1000)
            : new Date();
        await deletionService.enqueuePrefix(`${hashed_video_id}/`, {
            hashed_video_id,
            execute_at: executeAt,
            source: 'video_delete',
        });
    }
}

async function listCourseVideos(courseId, page = 1, limit = 20) {
    const pool = getPool();
    const offset = (page - 1) * limit;

    const [countRows] = await pool.execute(
        'SELECT COUNT(*) as total FROM videos WHERE course_id = ?',
        [courseId]
    );

    const lim = parseInt(limit);
    const off = parseInt(offset);
    const [rows] = await pool.execute(
        `SELECT * FROM videos WHERE course_id = ?
         ORDER BY COALESCE(lecture_date, created_at) DESC
         LIMIT ${lim} OFFSET ${off}`,
        [courseId]
    );

    return {
        videos: rows,
        total: countRows[0].total,
        page,
        totalPages: Math.ceil(countRows[0].total / limit)
    };
}

module.exports = {
    createVideo,
    generateHashedVideoId,
    getVideoById,
    updateVideo,
    deleteVideo,
    listCourseVideos
};
