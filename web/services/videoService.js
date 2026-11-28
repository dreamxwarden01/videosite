const crypto = require('crypto');
const { getPool, idBuf } = require('../config/database');
const videoCache = require('./cache/videoCache');
const courseListCache = require('./cache/courseListCache');

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
        `INSERT INTO videos (course_id, title, description, module_number, lecture_date,
         original_filename, file_size_bytes, uploaded_by, hashed_video_id, r2_source_key, video_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            courseId, title,
            options.description || null,
            options.module_number || null,
            options.lecture_date || null,
            options.original_filename || null,
            options.file_size_bytes || null,
            idBuf(options.uploaded_by || null),
            hashedVideoId,
            options.r2_source_key || null,
            videoType
        ]
    );

    // Course list base caches video_count per course — a new video changes it.
    await courseListCache.invalidate();
    return { videoId: result.insertId, hashedVideoId };
}

async function getVideoById(videoId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT v.*, c.course_code, c.course_name
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
    if (updates.module_number !== undefined) { fields.push('module_number = ?'); values.push(updates.module_number); }
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
 * Persist video deletion and every R2 cleanup intent in one transaction.
 * Capture/lock children before the cascade; only a known commit permits
 * cancelling writers or discarding buffered progress. Early posters are
 * independent of has_poster: a PUT may be in flight before its acknowledgement.
 */
async function deleteVideo(videoId) {
    const pool = getPool();
    const deletionService = require('./deletionService');
    const connection = await pool.getConnection();
    let reusable = true, commitStarted = false, alreadyAbsent = false;
    let transactionError;
    let activeJobs = [], inflightSessions = [];
    let deletedVideoId = Number.isSafeInteger(Number(videoId)) ? Number(videoId) : videoId;
    const reportEffectFailure = (effect, error) => {
        const code = String(error?.code || error?.name || 'unknown');
        console.error('Video deletion follow-up effect failed:', {
            video_id: deletedVideoId, effect,
            error_code: /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'unknown',
        });
    };
    const bestEffort = async (effect, run) => {
        try { await run(); }
        catch (error) { reportEffectFailure(effect, error); }
    };
    const invalidateReadCaches = async () => {
        await Promise.all([
            bestEffort('video_cache', () => videoCache.invalidate(deletedVideoId)),
            bestEffort('course_list_cache', () => courseListCache.invalidate()),
        ]);
    };
    try {
        await connection.beginTransaction();
        const [videos] = await connection.execute(
            `SELECT video_id, course_id, hashed_video_id, r2_source_key, status
             FROM videos WHERE video_id = ? FOR UPDATE`, [videoId]
        );
        if (videos.length === 0) {
            alreadyAbsent = true;
        } else {
            const video = videos[0];
            deletedVideoId = video.video_id;
            const [jobs] = await connection.execute(
                `SELECT job_id, status FROM processing_queue
                 WHERE video_id = ? FOR UPDATE`, [deletedVideoId]
            );
            // Include queued rows in the lock: leasing cannot create a writer
            // after the cleanup snapshot. Only real active jobs need follow-up.
            activeJobs = jobs.filter(job => ['leased', 'processing'].includes(job.status) && job.job_id != null);
            [inflightSessions] = await connection.execute(
                `SELECT upload_id, object_key, r2_upload_id FROM upload_sessions
                 WHERE video_id = ? AND status IN ('active', 'completing')
                   AND type = 'video' FOR UPDATE`, [deletedVideoId]
            );
            const invalidTarget = () => Object.assign(
                new Error('Cannot delete video: unsupported cleanup target'),
                { code: 'invalid_cleanup_target' }
            );
            let sourcePrefix = null;
            if (video.r2_source_key) {
                const match = /^source\/([A-Za-z0-9]{12})\/source\.[^/]+$/.exec(video.r2_source_key);
                if (!match) throw invalidTarget();
                sourcePrefix = `source/${match[1]}/`;
            }
            if (!/^[A-Za-z0-9]{64}$/.test(video.hashed_video_id)
                || !Number.isSafeInteger(Number(video.course_id)) || Number(video.course_id) < 1) throw invalidTarget();
            const now = new Date();
            const delayedAt = new Date(now.getTime() + 2 * 60 * 1000);
            const inFlight = ['worker_downloading', 'processing', 'worker_uploading'].includes(video.status) || activeJobs.length > 0;
            const opts = { connection, source: 'video_delete' };
            if (sourcePrefix) await deletionService.enqueuePrefix(sourcePrefix, { ...opts, execute_at: now });
            await deletionService.enqueuePrefix(`${video.hashed_video_id}/`, {
                ...opts, hashed_video_id: video.hashed_video_id, execute_at: inFlight ? delayedAt : now,
            });
            // The upload may precede completion, or survive briefly after an
            // abort changes status back to queued/error. Never gate this key on
            // has_poster, and always leave the same cancellation grace window.
            await deletionService.enqueueKey(`posters/${video.course_id}/${deletedVideoId}.jpg`, {
                ...opts, execute_at: delayedAt,
            });
            await deletionService.enqueuePrefix(`posters/${video.course_id}/${deletedVideoId}/`, {
                ...opts, execute_at: delayedAt,
            });
            await connection.execute('DELETE FROM videos WHERE video_id = ?', [deletedVideoId]);
        }
        commitStarted = true;
        await connection.commit();
    } catch (error) {
        try { await connection.rollback(); }
        catch { reusable = false; connection.destroy(); }
        transactionError = error;
    } finally {
        if (reusable) connection.release();
    }
    if (transactionError) {
        // A lost COMMIT reply proves neither rollback nor commit. Refillable
        // metadata is safe to evict; writer/liveness/watch state is not.
        if (commitStarted) await invalidateReadCaches();
        throw transactionError;
    }
    if (alreadyAbsent) {
        await invalidateReadCaches();
        return;
    }
    const effects = [
        ['video_cache', () => videoCache.invalidate(deletedVideoId)],
        ['course_list_cache', () => courseListCache.invalidate()],
        ['watch_progress_cache', () => require('./cache/watchProgressCache').clearForVideo(deletedVideoId)],
        ['transcode_cache', () => require('./cache/transcodeProgressCache').clearJobs(activeJobs.map(job => job.job_id))],
    ];
    for (const job of activeJobs) effects.push(['stale_timer', () => require('./processingService').clearStaleTimer(job.job_id)]);
    for (const session of inflightSessions) {
        effects.push(['upload_heartbeat', () => require('./cache/uploadHeartbeatCache').clearHeartbeat(session.upload_id)]);
        void bestEffort('multipart_abort', () => require('./uploadService').abortMultipartUpload(session.object_key, session.r2_upload_id));
    }
    await Promise.all(effects.map(([name, run]) => bestEffort(name, run)));
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
