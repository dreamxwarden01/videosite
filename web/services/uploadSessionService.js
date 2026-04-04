const crypto = require('crypto');
const { getPool } = require('../config/database');
const { abortMultipartUpload } = require('./uploadService');

// --- Base62 encoding ---
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(buffer, length) {
    let result = '';
    for (let i = 0; i < buffer.length && result.length < length; i++) {
        result += BASE62[buffer[i] % 62];
    }
    return result;
}

/** Generate a 12-character base62 upload ID. */
function generateUploadId() {
    return toBase62(crypto.randomBytes(12), 12);
}

// --- Stale upload timers ---
const staleTimers = new Map(); // uploadId -> timeoutId
const STALE_TIMEOUT_MS = 60 * 1000; // 60 seconds

function startStaleUploadTimer(uploadId) {
    clearStaleUploadTimer(uploadId);
    const timerId = setTimeout(async () => {
        staleTimers.delete(uploadId);
        try {
            await handleStaleUpload(uploadId);
        } catch (err) {
            console.error(`Stale upload timer failed for ${uploadId}:`, err.message);
        }
    }, STALE_TIMEOUT_MS);
    if (timerId.unref) timerId.unref();
    staleTimers.set(uploadId, timerId);
}

function clearStaleUploadTimer(uploadId) {
    const existing = staleTimers.get(uploadId);
    if (existing) {
        clearTimeout(existing);
        staleTimers.delete(uploadId);
    }
}

/** Timer-triggered: re-check heartbeat, abort if truly stale. */
async function handleStaleUpload(uploadId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT upload_id, r2_upload_id, object_key FROM upload_sessions
         WHERE upload_id = ? AND status = 'active'
         AND last_heartbeat < DATE_SUB(NOW(), INTERVAL 60 SECOND)`,
        [uploadId]
    );

    if (rows.length === 0) return; // Heartbeat came in or already completed

    const session = rows[0];
    console.log(`Stale upload timer: aborting session ${uploadId}`);

    await markAborted(uploadId);

    // Fire-and-forget R2 abort
    abortMultipartUpload(session.object_key, session.r2_upload_id).catch(err => {
        console.error(`R2 abort failed for stale upload ${uploadId}:`, err.message);
    });
}

/** Startup sweep: abort sessions that went stale while server was down. */
async function resetStaleUploads() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT upload_id, r2_upload_id, object_key FROM upload_sessions
         WHERE status = 'active'
         AND last_heartbeat < DATE_SUB(NOW(), INTERVAL 60 SECOND)`
    );

    for (const session of rows) {
        console.log(`Startup: aborting stale upload ${session.upload_id}`);
        await pool.execute(
            `UPDATE upload_sessions SET status = 'aborted' WHERE upload_id = ? AND status = 'active'`,
            [session.upload_id]
        );
        abortMultipartUpload(session.object_key, session.r2_upload_id).catch(err => {
            console.error(`R2 abort failed for stale upload ${session.upload_id}:`, err.message);
        });
    }

    // Restart timers for still-active sessions
    const [active] = await pool.execute(
        `SELECT upload_id FROM upload_sessions WHERE status = 'active'`
    );
    for (const session of active) {
        startStaleUploadTimer(session.upload_id);
    }
}

// --- Session CRUD ---

async function createSession({ uploadId, videoId, courseId, title, week, lectureDate, description,
                                r2UploadId, objectKey, originalFilename, fileSizeBytes, totalParts, createdBy }) {
    const pool = getPool();
    await pool.execute(
        `INSERT INTO upload_sessions
         (upload_id, video_id, course_id, title, week, lecture_date, description,
          r2_upload_id, object_key, original_filename, file_size_bytes, total_parts, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uploadId, videoId || null, courseId, title || null, week || null, lectureDate || null,
         description || null, r2UploadId, objectKey, originalFilename, fileSizeBytes, totalParts, createdBy]
    );
    startStaleUploadTimer(uploadId);
}

async function getSession(uploadId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM upload_sessions WHERE upload_id = ?',
        [uploadId]
    );
    return rows[0] || null;
}

async function heartbeat(uploadId, userId) {
    const pool = getPool();
    const [result] = await pool.execute(
        `UPDATE upload_sessions SET last_heartbeat = NOW()
         WHERE upload_id = ? AND status = 'active' AND created_by = ?`,
        [uploadId, userId]
    );
    if (result.affectedRows > 0) {
        startStaleUploadTimer(uploadId);
    }
    return result.affectedRows > 0;
}

/** Check for metadata conflict (new uploads): same course + title + week + lecture_date. */
async function checkMetadataConflict(courseId, title, week, lectureDate) {
    const pool = getPool();

    // Check existing videos
    const [videoRows] = await pool.execute(
        `SELECT video_id, title FROM videos
         WHERE course_id = ? AND title <=> ? AND week <=> ? AND lecture_date <=> ?`,
        [courseId, title, week || null, lectureDate || null]
    );
    if (videoRows.length > 0) {
        return { type: 'video', videoId: videoRows[0].video_id };
    }

    // Check active upload sessions
    const [sessionRows] = await pool.execute(
        `SELECT upload_id, created_by FROM upload_sessions
         WHERE course_id = ? AND title <=> ? AND week <=> ? AND lecture_date <=> ?
           AND status IN ('active', 'completing')`,
        [courseId, title, week || null, lectureDate || null]
    );
    if (sessionRows.length > 0) {
        return { type: 'upload', uploadId: sessionRows[0].upload_id };
    }

    return null;
}

/** Check for replace conflict: another active upload targeting same video_id. */
async function checkReplaceConflict(videoId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT upload_id, created_by FROM upload_sessions
         WHERE video_id = ? AND status IN ('active', 'completing')`,
        [videoId]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function markCompleting(uploadId) {
    const pool = getPool();
    await pool.execute(
        `UPDATE upload_sessions SET status = 'completing' WHERE upload_id = ? AND status = 'active'`,
        [uploadId]
    );
    clearStaleUploadTimer(uploadId);
}

async function markCompleted(uploadId, videoId) {
    const pool = getPool();
    const fields = [`status = 'completed'`, `completed_at = NOW()`];
    const values = [];
    if (videoId != null) {
        fields.push('video_id = ?');
        values.push(videoId);
    }
    values.push(uploadId);
    await pool.execute(
        `UPDATE upload_sessions SET ${fields.join(', ')} WHERE upload_id = ?`,
        values
    );
    clearStaleUploadTimer(uploadId);
}

async function markAborted(uploadId) {
    const pool = getPool();
    await pool.execute(
        `UPDATE upload_sessions SET status = 'aborted' WHERE upload_id = ? AND status IN ('active', 'completing')`,
        [uploadId]
    );
    clearStaleUploadTimer(uploadId);
}

module.exports = {
    generateUploadId,
    toBase62,
    createSession,
    getSession,
    heartbeat,
    checkMetadataConflict,
    checkReplaceConflict,
    markCompleting,
    markCompleted,
    markAborted,
    resetStaleUploads
};
