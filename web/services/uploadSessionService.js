const crypto = require('crypto');
const { getPool } = require('../config/database');
const { abortMultipartUpload } = require('./uploadService');
const uploadHeartbeatCache = require('./cache/uploadHeartbeatCache');
const deletionService = require('./deletionService');

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
//
// Each active upload session has an in-process timer that fires 60 s
// after the last heartbeat. The "last heartbeat" is the live value in
// Redis (`uploadHeartbeatCache`); the DB column is a flushed view that
// lags by up to one flush cycle and is only consulted on startup or
// when the cache misses (cold Redis, etc.).
//
// On fire: `handleStaleUpload` confirms staleness via cache, then
// branches on session.type — multipart abort for video, R2 key
// deletion (with a 60 s buffer to let in-flight PUTs drain) for
// attachment. Both flows mark the session 'aborted' in DB.
const staleTimers = new Map(); // uploadId -> timeoutId
const STALE_TIMEOUT_MS = 60 * 1000; // 60 seconds
// Buffer between server-side "stale" decision and R2 key removal for
// attachments. Lets an in-flight PUT either land (and be deleted) or
// fail (no-op delete) before the reaper touches the prefix.
const ATTACHMENT_DELETE_BUFFER_MS = 60 * 1000;

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

/**
 * Re-check live heartbeat (Redis), then abort if truly stale.
 *
 * Branches on session.type: 'video' → multipart abort, 'attachment' →
 * enqueue R2 key for deletion with a 60 s buffer.
 */
async function handleStaleUpload(uploadId) {
    // Re-read live heartbeat from Redis. A late heartbeat could have
    // landed between the timer being scheduled and now — in which case
    // the session is not actually stale.
    const lastHeartbeatMs = await uploadHeartbeatCache.getLastHeartbeat(uploadId);
    if (lastHeartbeatMs && Date.now() - lastHeartbeatMs < STALE_TIMEOUT_MS) {
        return; // Fresh heartbeat — not stale.
    }

    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT type, r2_upload_id, object_key FROM upload_sessions
         WHERE upload_id = ? AND status = 'active'`,
        [uploadId]
    );
    if (rows.length === 0) return; // Already terminal.

    const session = rows[0];
    console.log(`Stale upload timer: aborting ${session.type} session ${uploadId}`);

    await markAborted(uploadId);

    if (session.type === 'video') {
        // Fire-and-forget multipart abort. R2's 24h bucket lifecycle
        // covers anything that fails here.
        abortMultipartUpload(session.object_key, session.r2_upload_id).catch(err => {
            console.error(`R2 multipart abort failed for stale upload ${uploadId}:`, err.message);
        });
    } else {
        // Single-PUT attachment: enqueue R2 key for deletion. The 60 s
        // buffer narrows the race where the client's PUT lands after
        // the server decided to give up.
        await deletionService.enqueueKey(session.object_key, {
            source: 'attachment_stale',
            execute_at: new Date(Date.now() + ATTACHMENT_DELETE_BUFFER_MS),
        });
    }
}

/**
 * Startup sweep: abort sessions that went stale while the server was
 * down. The DB `last_heartbeat` is the only reliable signal here
 * (Redis may itself be cold-starting and not yet populated).
 */
async function resetStaleUploads() {
    const pool = getPool();
    const [stale] = await pool.execute(
        `SELECT upload_id, type, r2_upload_id, object_key FROM upload_sessions
         WHERE status = 'active'
         AND last_heartbeat < DATE_SUB(NOW(), INTERVAL 60 SECOND)`
    );

    for (const session of stale) {
        console.log(`Startup: aborting stale ${session.type} upload ${session.upload_id}`);
        await pool.execute(
            `UPDATE upload_sessions SET status = 'aborted' WHERE upload_id = ? AND status = 'active'`,
            [session.upload_id]
        );
        await uploadHeartbeatCache.clearHeartbeat(session.upload_id);

        if (session.type === 'video') {
            abortMultipartUpload(session.object_key, session.r2_upload_id).catch(err => {
                console.error(`R2 multipart abort failed for stale upload ${session.upload_id}:`, err.message);
            });
        } else {
            await deletionService.enqueueKey(session.object_key, {
                source: 'attachment_stale_boot',
                execute_at: new Date(Date.now() + ATTACHMENT_DELETE_BUFFER_MS),
            });
        }
    }

    // Restart timers for still-active sessions (so the in-process
    // stale detector takes over from here).
    const [active] = await pool.execute(
        `SELECT upload_id, type, created_by FROM upload_sessions WHERE status = 'active'`
    );
    for (const session of active) {
        // Re-seed the Redis cache so live-heartbeat reads work even
        // after a Redis-cold boot. Use DB-stored last_heartbeat as
        // best-effort starting timestamp via init().
        await uploadHeartbeatCache.init(session.upload_id, {
            userId: session.created_by,
            type: session.type,
        });
        startStaleUploadTimer(session.upload_id);
    }
}

// --- Session CRUD ---

/**
 * Create an upload session. The `type` discriminator picks the flow:
 * 'video' (multipart) requires `r2UploadId` + `totalParts`; 'attachment'
 * (single PUT) requires `contentType` and leaves multipart fields null.
 * Caller is responsible for passing the right combination.
 */
async function createSession({ type, uploadId, videoId, courseId, title, week, lectureDate, description,
                                r2UploadId, objectKey, contentType, originalFilename, fileSizeBytes, totalParts, createdBy }) {
    if (type !== 'video' && type !== 'attachment') {
        throw new Error(`createSession: type must be 'video' or 'attachment', got ${type}`);
    }
    const pool = getPool();
    await pool.execute(
        `INSERT INTO upload_sessions
         (upload_id, video_id, course_id, title, week, lecture_date, description,
          r2_upload_id, object_key, content_type, original_filename, file_size_bytes, total_parts, created_by, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uploadId, videoId || null, courseId, title || null, week || null, lectureDate || null,
         description || null, r2UploadId || null, objectKey, contentType || null,
         originalFilename, fileSizeBytes, totalParts || null, createdBy, type]
    );
    // Seed Redis so subsequent heartbeats never touch DB.
    await uploadHeartbeatCache.init(uploadId, { userId: createdBy, type });
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

/**
 * Record a heartbeat. Goes through the Redis cache (no DB write per
 * tick) and returns whether the session is still alive. Restarts the
 * in-process stale timer on success.
 */
async function heartbeat(uploadId, userId) {
    const accepted = await uploadHeartbeatCache.recordHeartbeat(uploadId, userId);
    if (accepted) {
        startStaleUploadTimer(uploadId);
    }
    return accepted;
}

/**
 * Check for metadata conflict (new video uploads): same course + title
 * + week + lecture_date. Attachments are excluded because they don't
 * use title/week metadata for uniqueness.
 */
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

    // Check active upload sessions — videos only
    const [sessionRows] = await pool.execute(
        `SELECT upload_id, created_by FROM upload_sessions
         WHERE course_id = ? AND title <=> ? AND week <=> ? AND lecture_date <=> ?
           AND status IN ('active', 'completing')
           AND type = 'video'`,
        [courseId, title, week || null, lectureDate || null]
    );
    if (sessionRows.length > 0) {
        return { type: 'upload', uploadId: sessionRows[0].upload_id };
    }

    return null;
}

/**
 * Check for replace conflict: another active video upload targeting the
 * same video_id. Attachments don't replace, so no type filter needed
 * (video_id is null for attachment sessions and the JOIN naturally
 * filters them out).
 */
async function checkReplaceConflict(videoId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT upload_id, created_by FROM upload_sessions
         WHERE video_id = ? AND status IN ('active', 'completing')
           AND type = 'video'`,
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
    await uploadHeartbeatCache.clearHeartbeat(uploadId);
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
    await uploadHeartbeatCache.clearHeartbeat(uploadId);
}

async function markAborted(uploadId) {
    const pool = getPool();
    await pool.execute(
        `UPDATE upload_sessions SET status = 'aborted' WHERE upload_id = ? AND status IN ('active', 'completing')`,
        [uploadId]
    );
    clearStaleUploadTimer(uploadId);
    await uploadHeartbeatCache.clearHeartbeat(uploadId);
}

/**
 * Abort an attachment session: mark aborted in DB, clear cache, enqueue
 * the R2 object key for deletion with the 60 s "wait for in-flight PUT
 * to settle" buffer. Idempotent — safe to call on already-terminal
 * sessions (no-op except for any stray cache state).
 *
 * Used by the user-initiated abort endpoint, the stale-detection path,
 * and `courseService.deleteCourse`. Video sessions have their own
 * multipart-abort handling.
 */
async function abortAttachmentSession(uploadId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT object_key, status FROM upload_sessions
         WHERE upload_id = ? AND type = 'attachment'`,
        [uploadId]
    );
    if (rows.length === 0) return null;
    const { object_key, status } = rows[0];

    if (status === 'active' || status === 'completing') {
        await markAborted(uploadId);
    }
    await deletionService.enqueueKey(object_key, {
        source: 'attachment_abort',
        execute_at: new Date(Date.now() + ATTACHMENT_DELETE_BUFFER_MS),
    });
    return object_key;
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
    abortAttachmentSession,
    resetStaleUploads,
};
