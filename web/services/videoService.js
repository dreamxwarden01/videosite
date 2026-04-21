const crypto = require('crypto');
const { getPool } = require('../config/database');
const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getR2Client, getR2BucketName } = require('../config/r2');

// --- R2 retry + concurrency settings ---
const R2_MAX_ATTEMPTS = 6;        // 1 original + 5 retries
const R2_DELETE_BATCH_SIZE = 100;  // objects per DeleteObjects call
const R2_DELETE_CONCURRENCY = 10;  // max concurrent delete calls

/**
 * Execute an R2 operation with automatic retry.
 * First retry is immediate, retries 2-5 have 1s backoff, then give up.
 */
async function r2WithRetry(operation, label) {
    for (let attempt = 0; attempt < R2_MAX_ATTEMPTS; attempt++) {
        try {
            return await operation();
        } catch (err) {
            // 4xx errors (including 404) are client errors — don't retry
            const status = err.$metadata?.httpStatusCode;
            if (status && status >= 400 && status < 500) throw err;
            if (attempt === R2_MAX_ATTEMPTS - 1) throw err;
            const delay = attempt === 0 ? 0 : 1000;
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
            console.warn(`R2 ${label} attempt ${attempt + 2}/${R2_MAX_ATTEMPTS}: ${err.message}`);
        }
    }
}

/** Split an array into chunks of the given size. */
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a unique 64-character base62 hashed video ID.
 * Called at upload completion time (when video record is created).
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
            'SELECT 1 FROM videos WHERE hashed_video_id = ?',
            [id]
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
}

/**
 * Delete a video with 404-based worker abort + R2 cleanup.
 *
 * For processing videos (worker_downloading, processing, worker_uploading):
 *   - Worker detects deletion via 404 on next API call → aborts immediately
 *   - HLS output cleanup delayed 2 minutes (worker guaranteed to stop by then)
 *   - Source file cleaned immediately (worker only reads it during download)
 *
 * For non-processing videos (queued, finished, error):
 *   - All R2 cleanup runs immediately
 *
 * Flow:
 * 1. Pre-fetch video info (hashed IDs, status) BEFORE deleting DB rows
 * 2. Clear stale timer for any active job
 * 3. DELETE video (FK cascade removes processing_queue → worker gets 404)
 * 4. Schedule R2 cleanup based on video status
 */
async function deleteVideo(videoId) {
    const pool = getPool();
    const { clearStaleTimer } = require('./processingService');

    // 1. Pre-fetch video info (need hashed IDs and status for R2 cleanup after DB delete)
    const [videoRows] = await pool.execute(
        `SELECT hashed_video_id, r2_source_key, status FROM videos WHERE video_id = ?`,
        [videoId]
    );

    // 2. Get active job_id for stale timer clearance
    const [taskRows] = await pool.execute(
        `SELECT job_id FROM processing_queue
         WHERE video_id = ? AND status IN ('leased', 'processing') AND job_id IS NOT NULL`,
        [videoId]
    );

    // 3. Clear stale timer for active job
    if (taskRows.length > 0 && taskRows[0].job_id) {
        clearStaleTimer(taskRows[0].job_id);
    }

    // 4. Delete DB record (FK cascade removes processing_queue → worker gets 404)
    await pool.execute('DELETE FROM videos WHERE video_id = ?', [videoId]);

    // 5. R2 cleanup (fire-and-forget, don't block API response)
    if (videoRows.length > 0) {
        const { hashed_video_id, r2_source_key, status } = videoRows[0];
        const isProcessing = ['worker_downloading', 'processing', 'worker_uploading'].includes(status);

        // Source file: clean the directory containing r2_source_key
        if (r2_source_key) {
            const sourceDir = r2_source_key.substring(0, r2_source_key.lastIndexOf('/') + 1);
            cleanR2Prefix(sourceDir).catch(err => {
                console.error(`R2 source cleanup failed for video ${videoId}:`, err.message);
            });
        }

        if (isProcessing) {
            // HLS output: delay 2 minutes for worker to stop uploading
            const timer = setTimeout(() => {
                cleanR2Prefix(`${hashed_video_id}/`).catch(err => {
                    console.error(`R2 HLS cleanup failed for video ${videoId}:`, err.message);
                });
            }, 2 * 60 * 1000);
            if (timer.unref) timer.unref(); // Don't keep process alive
        } else {
            // Not processing: clean HLS output immediately
            cleanR2Prefix(`${hashed_video_id}/`).catch(err => {
                console.error(`R2 HLS cleanup failed for video ${videoId}:`, err.message);
            });
        }
    }
}

/**
 * Delete all R2 objects under a given prefix.
 * Each R2 API call (list + delete) is retried up to 5 times on failure.
 * Deletes run in concurrent batches of R2_DELETE_CONCURRENCY.
 */
async function cleanR2Prefix(prefix) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();
    if (!bucket) return;

    let continuationToken;
    do {
        const listResult = await r2WithRetry(
            () => r2.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            })),
            `list "${prefix}"`
        );

        if (listResult.Contents && listResult.Contents.length > 0) {
            const batches = chunkArray(listResult.Contents, R2_DELETE_BATCH_SIZE);

            // Process batches in groups of R2_DELETE_CONCURRENCY
            for (let i = 0; i < batches.length; i += R2_DELETE_CONCURRENCY) {
                const group = batches.slice(i, i + R2_DELETE_CONCURRENCY);
                await Promise.all(group.map(batch =>
                    r2WithRetry(
                        () => r2.send(new DeleteObjectsCommand({
                            Bucket: bucket,
                            Delete: {
                                Objects: batch.map(obj => ({ Key: obj.Key })),
                                Quiet: true
                            }
                        })),
                        `delete ${batch.length} objects from "${prefix}"`
                    )
                ));
            }
        }

        continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
    } while (continuationToken);
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
    cleanR2Prefix,
    listCourseVideos
};
