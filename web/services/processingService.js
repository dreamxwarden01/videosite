const crypto = require('crypto');
const { getPool } = require('../config/database');

// --- Per-job stale detection timers ---
// Each active job gets a 2-minute timer that resets on every heartbeat.
// When the timer fires, the job is checked and reset if truly stale.
const staleTimers = new Map(); // jobId → timeoutId
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function startStaleTimer(jobId) {
    clearStaleTimer(jobId);
    const timerId = setTimeout(async () => {
        staleTimers.delete(jobId);
        try {
            await resetSingleStaleTask(jobId);
        } catch (err) {
            console.error(`Stale timer reset failed for job ${jobId}:`, err.message);
        }
    }, STALE_TIMEOUT_MS);
    // Don't let the timer keep the process alive on shutdown
    if (timerId.unref) timerId.unref();
    staleTimers.set(jobId, timerId);
}

function clearStaleTimer(jobId) {
    const existing = staleTimers.get(jobId);
    if (existing) {
        clearTimeout(existing);
        staleTimers.delete(jobId);
    }
}

// Timer-triggered: reset a single stale job with R2 cleanup.
async function resetSingleStaleTask(jobId) {
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');

    // Get task details (need hashed paths for R2 cleanup)
    const [rows] = await pool.execute(
        `SELECT pq.video_id, pq.job_id, v.hashed_video_id
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ? AND pq.status IN ('leased', 'processing')`,
        [jobId]
    );

    if (rows.length === 0) return; // Already completed/reset

    const task = rows[0];

    // Atomically reset — re-checks staleness to avoid race with a late heartbeat
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'queued', job_id = NULL, worker_key_id = NULL,
             leased_at = NULL, last_heartbeat = NULL, pending_until = NULL,
             progress = 0, error_message = NULL, error_at = NULL
         WHERE job_id = ? AND status IN ('leased', 'processing')
         AND last_heartbeat < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
        [jobId]
    );

    if (result.affectedRows === 0) return; // Heartbeat came in — not stale

    console.log(`Stale timer: reset job ${jobId} (video ${task.video_id})`);

    // Clean up partial R2 output
    try {
        await cleanR2Prefix(`${task.hashed_video_id}/${task.job_id}/`);
    } catch (err) {
        console.error(`R2 cleanup failed for stale job ${jobId}:`, err.message);
    }

    // Reset video status and clear encryption key
    await pool.execute(
        `UPDATE videos
         SET status = 'queued', processing_progress = 0,
             processing_error = NULL, processing_job_id = NULL, encryption_key = NULL
         WHERE video_id = ? AND status IN ('worker_downloading', 'processing', 'worker_uploading')`,
        [task.video_id]
    );
}

async function createTask(videoId) {
    const pool = getPool();
    await pool.execute(
        'INSERT INTO processing_queue (video_id) VALUES (?)',
        [videoId]
    );
}

async function leaseNextTask(workerKeyId) {
    const pool = getPool();
    const jobId = crypto.randomUUID();

    // Atomic lease: update the first queued task
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'leased', job_id = ?, worker_key_id = ?, leased_at = NOW(), last_heartbeat = NOW()
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
        [jobId, workerKeyId]
    );

    if (result.affectedRows === 0) {
        return null; // No tasks available
    }

    // Get the leased task details
    const [rows] = await pool.execute(
        `SELECT pq.*, v.course_id, v.hashed_video_id, v.r2_source_key, v.original_filename
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ?`,
        [jobId]
    );

    if (rows.length === 0) return null;

    const task = rows[0];

    // Update video status
    await pool.execute(
        "UPDATE videos SET status = 'worker_downloading', processing_job_id = ? WHERE video_id = ?",
        [jobId, task.video_id]
    );

    startStaleTimer(jobId);
    return task;
}

async function updateTaskStatus(jobId, status, progress = null, errorMessage = null) {
    const pool = getPool();

    // Update processing queue
    const fields = ['status = ?', 'last_heartbeat = NOW()'];
    const values = [status];

    if (progress !== null) {
        fields.push('progress = ?');
        values.push(progress);
    }
    if (errorMessage !== null) {
        fields.push('error_message = ?');
        values.push(errorMessage);
    }
    values.push(jobId);

    const [result] = await pool.execute(
        `UPDATE processing_queue SET ${fields.join(', ')} WHERE job_id = ?`,
        values
    );

    // Job not found — 404 signals abort to worker
    if (result.affectedRows === 0) {
        return { found: false };
    }

    // Map queue status to video status
    const statusMap = {
        'leased': 'worker_downloading',
        'processing': 'processing',
        'completed': 'finished',
        'error': 'error'
    };

    // Also update video status
    const [task] = await pool.execute(
        'SELECT video_id FROM processing_queue WHERE job_id = ?',
        [jobId]
    );

    if (task.length > 0) {
        const videoUpdates = {};
        if (statusMap[status]) videoUpdates.status = statusMap[status];
        if (progress !== null) videoUpdates.processing_progress = progress;
        if (errorMessage !== null) videoUpdates.processing_error = errorMessage;

        const updateFields = [];
        const updateValues = [];
        if (videoUpdates.status) { updateFields.push('status = ?'); updateValues.push(videoUpdates.status); }
        if (videoUpdates.processing_progress !== undefined) { updateFields.push('processing_progress = ?'); updateValues.push(videoUpdates.processing_progress); }
        if (videoUpdates.processing_error !== undefined) { updateFields.push('processing_error = ?'); updateValues.push(videoUpdates.processing_error); }

        if (updateFields.length > 0) {
            updateValues.push(task[0].video_id);
            await pool.execute(
                `UPDATE videos SET ${updateFields.join(', ')} WHERE video_id = ?`,
                updateValues
            );
        }
    }

    // Restart or clear stale timer based on status
    if (status === 'leased' || status === 'processing') {
        startStaleTimer(jobId);
    } else {
        clearStaleTimer(jobId);
    }

    return { found: true };
}

async function completeTask(jobId, durationSeconds = null) {
    clearStaleTimer(jobId);
    const pool = getPool();

    const [result] = await pool.execute(
        "UPDATE processing_queue SET status = 'completed', progress = 100, last_heartbeat = NOW() WHERE job_id = ?",
        [jobId]
    );

    // Job not found — 404 signals abort to worker
    if (result.affectedRows === 0) {
        return false;
    }

    const [task] = await pool.execute(
        'SELECT video_id FROM processing_queue WHERE job_id = ?',
        [jobId]
    );

    if (task.length > 0) {
        const fields = ["status = 'finished'", 'processing_progress = 100'];
        const values = [];
        if (durationSeconds !== null) {
            fields.push('duration_seconds = ?');
            values.push(durationSeconds);
        }
        values.push(task[0].video_id);

        await pool.execute(
            `UPDATE videos SET ${fields.join(', ')} WHERE video_id = ?`,
            values
        );

        // Clean up R2 source file (fire-and-forget — don't block completion)
        cleanupSourceFile(task[0].video_id).catch(err => {
            console.warn(`R2 source cleanup failed for video ${task[0].video_id} (job ${jobId}):`, err.message);
        });
    }

    return true;
}

// Delete the original source file from R2 after transcoding completes.
async function cleanupSourceFile(videoId) {
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');

    const [rows] = await pool.execute(
        `SELECT r2_source_key FROM videos WHERE video_id = ?`,
        [videoId]
    );

    if (rows.length === 0 || !rows[0].r2_source_key) {
        return;
    }

    // Derive directory from r2_source_key (e.g. "source/{upload_id}/source.mp4" → "source/{upload_id}/")
    const sourceKey = rows[0].r2_source_key;
    const sourceDir = sourceKey.substring(0, sourceKey.lastIndexOf('/') + 1);
    await cleanR2Prefix(sourceDir);

    await pool.execute(
        'UPDATE videos SET r2_source_key = NULL WHERE video_id = ?',
        [videoId]
    );
}

async function reportError(jobId, errorMessage) {
    const pool = getPool();
    const result = await updateTaskStatus(jobId, 'error', null, errorMessage);
    if (!result.found) return { found: false };
    // Set error_at timestamp for transcoding status page sorting
    await pool.execute(
        'UPDATE processing_queue SET error_at = NOW() WHERE job_id = ?',
        [jobId]
    );
    return { found: true };
}

// Generate a short 12-char hex job ID with collision retry
async function generateShortJobId(videoId, workerKeyId, timestamp) {
    const pool = getPool();
    for (let attempt = 0; attempt < 10; attempt++) {
        const salt = attempt > 0 ? crypto.randomBytes(4).toString('hex') : '';
        const input = `${videoId}:${workerKeyId}:${timestamp}${salt}`;
        const hash = crypto.createHash('sha256').update(input).digest('hex');
        const shortId = hash.substring(0, 12);

        const [existing] = await pool.execute(
            'SELECT 1 FROM processing_queue WHERE job_id = ?',
            [shortId]
        );
        if (existing.length === 0) return shortId;
    }
    // Extremely unlikely fallback
    return crypto.randomBytes(6).toString('hex');
}

// Reset expired pending tasks (check-then-lease timeout)
async function resetExpiredPendingTasks() {
    const pool = getPool();
    await pool.execute(
        `UPDATE processing_queue
         SET status = 'queued', pending_until = NULL
         WHERE status = 'pending' AND pending_until < NOW()`
    );
}

// Check for an available task (atomically sets to pending with 10s hold)
async function checkAvailableTask() {
    const pool = getPool();

    // Reset expired pending + stale tasks first
    await resetExpiredPendingTasks();
    await resetStaleTasks();

    // Atomically find first queued task and set to pending
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'pending', pending_until = DATE_ADD(NOW(), INTERVAL 10 SECOND)
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`
    );

    if (result.affectedRows === 0) {
        return { hasAvailableTask: false, videoId: null };
    }

    // Get the video_id of the task we just set to pending
    const [rows] = await pool.execute(
        `SELECT video_id FROM processing_queue WHERE status = 'pending' ORDER BY pending_until DESC LIMIT 1`
    );

    if (rows.length === 0) {
        return { hasAvailableTask: false, videoId: null };
    }

    return { hasAvailableTask: true, videoId: rows[0].video_id };
}

// Lease a specific pending task
async function leaseTask(videoId, workerKeyId) {
    const pool = getPool();

    const jobId = await generateShortJobId(videoId, workerKeyId, Date.now().toString());

    // Atomically update pending → leased for this specific video
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'leased', job_id = ?, worker_key_id = ?, leased_at = NOW(),
             last_heartbeat = NOW(), pending_until = NULL
         WHERE video_id = ? AND status = 'pending'`,
        [jobId, workerKeyId, videoId]
    );

    if (result.affectedRows === 0) {
        return { isLeaseSuccess: false, jobId: null, downloadUrl: null };
    }

    // Get task details for download URL generation
    const [rows] = await pool.execute(
        `SELECT pq.*, v.course_id, v.hashed_video_id, v.r2_source_key, v.original_filename
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ?`,
        [jobId]
    );

    if (rows.length === 0) {
        return { isLeaseSuccess: false, jobId: null, downloadUrl: null };
    }

    const task = rows[0];

    // Generate HLS encryption key (AES-128 = 16 bytes)
    const encryptionKey = crypto.randomBytes(16);

    // Update video status to worker_downloading and store encryption key
    await pool.execute(
        "UPDATE videos SET status = 'worker_downloading', processing_job_id = ?, encryption_key = ? WHERE video_id = ?",
        [jobId, encryptionKey, task.video_id]
    );

    // Generate presigned download URL
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { getR2Client, getR2BucketName } = require('../config/r2');

    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const command = new GetObjectCommand({ Bucket: bucket, Key: task.r2_source_key });
    const downloadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    startStaleTimer(jobId);
    return { isLeaseSuccess: true, jobId, downloadUrl, videoId: task.video_id, encryptionKey: encryptionKey.toString('hex') };
}

// Map file extension to the correct MIME type for R2 storage.
function hlsContentType(filename) {
    if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (filename.endsWith('.ts'))   return 'video/mp2t';
    return 'application/octet-stream';
}

// Generate presigned PUT URLs for uploading HLS output files
async function generateUploadUrls(jobId, filenames) {
    const pool = getPool();

    // Look up the task and get path components
    const [rows] = await pool.execute(
        `SELECT pq.*, v.hashed_video_id
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ?`,
        [jobId]
    );

    if (rows.length === 0) {
        return null;
    }

    const task = rows[0];
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { getR2Client, getR2BucketName } = require('../config/r2');

    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const urls = {};

    for (const filename of filenames) {
        const key = `${task.hashed_video_id}/${jobId}/${filename}`;
        const contentType = hlsContentType(filename);
        const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' });
        urls[filename] = await getSignedUrl(r2, command, { expiresIn: 43200 }); // 12 hours
    }

    return { urls };
}

// Re-queue a failed video for transcoding.
// Cleans up any partial HLS output from the previous failed job,
// resets the processing_queue row back to queued, and resets the video status.
async function retryFailedVideo(videoId) {
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');

    // Get video info — must be in error status to retry
    const [videoRows] = await pool.execute(
        `SELECT processing_job_id, hashed_video_id
         FROM videos
         WHERE video_id = ? AND status = 'error'`,
        [videoId]
    );

    if (videoRows.length === 0) {
        return false; // Not found or not in error state
    }

    const { processing_job_id: oldJobId, hashed_video_id } = videoRows[0];

    // Clean up any partial HLS output from the failed job
    if (oldJobId) {
        try {
            await cleanR2Prefix(`${hashed_video_id}/${oldJobId}/`);
        } catch (err) {
            console.error(`R2 cleanup failed for retry of video ${videoId}:`, err.message);
            // Continue with retry even if R2 cleanup fails
        }
    }

    // Reset the processing_queue row back to queued (brings it to the back of the queue)
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'queued',
             job_id = NULL,
             worker_key_id = NULL,
             leased_at = NULL,
             last_heartbeat = NULL,
             pending_until = NULL,
             progress = 0,
             error_message = NULL,
             error_at = NULL,
             cleared = 0,
             created_at = NOW()
         WHERE video_id = ? AND status = 'error'`,
        [videoId]
    );

    if (result.affectedRows === 0) {
        return false;
    }

    // Reset the video status and clear encryption key
    await pool.execute(
        `UPDATE videos
         SET status = 'queued',
             processing_progress = 0,
             processing_error = NULL,
             processing_job_id = NULL,
             encryption_key = NULL
         WHERE video_id = ?`,
        [videoId]
    );

    return true;
}

// Reset stale tasks (no heartbeat for 2+ minutes) — poll-based fallback.
// Handles R2 cleanup and full field reset. Per-task atomic to avoid races.
async function resetStaleTasks() {
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');

    // Find stale tasks (need details before we lose the job_id)
    const [staleTasks] = await pool.execute(
        `SELECT pq.job_id, pq.video_id, v.hashed_video_id
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.status IN ('leased', 'processing')
         AND pq.last_heartbeat < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`
    );

    if (staleTasks.length === 0) return 0;

    let resetCount = 0;
    for (const task of staleTasks) {
        // Atomically reset this specific task (re-checks staleness to avoid race)
        const [result] = await pool.execute(
            `UPDATE processing_queue
             SET status = 'queued', job_id = NULL, worker_key_id = NULL,
                 leased_at = NULL, last_heartbeat = NULL, pending_until = NULL,
                 progress = 0, error_message = NULL, error_at = NULL
             WHERE job_id = ? AND status IN ('leased', 'processing')
             AND last_heartbeat < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
            [task.job_id]
        );

        if (result.affectedRows === 0) continue; // Heartbeat arrived — skip

        resetCount++;
        clearStaleTimer(task.job_id);
        console.log(`Stale poll: reset job ${task.job_id} (video ${task.video_id})`);

        // Clean up partial R2 output (fire-and-forget — don't block the poll response)
        if (task.job_id) {
            cleanR2Prefix(`${task.hashed_video_id}/${task.job_id}/`).catch(err => {
                console.error(`R2 cleanup failed for stale job ${task.job_id}:`, err.message);
            });
        }

        // Reset video status and clear encryption key
        await pool.execute(
            `UPDATE videos
             SET status = 'queued', processing_progress = 0,
                 processing_error = NULL, processing_job_id = NULL, encryption_key = NULL
             WHERE video_id = ? AND status IN ('worker_downloading', 'processing', 'worker_uploading')`,
            [task.video_id]
        );
    }

    return resetCount;
}

async function getTaskByJobId(jobId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT pq.*, v.course_id, v.hashed_video_id, v.r2_source_key, v.original_filename
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ?`,
        [jobId]
    );
    return rows[0] || null;
}

// Abort a job and requeue it (called when worker gracefully shuts down).
// Cleans up any partial R2 output, then resets the task back to queued.
async function abortAndRequeue(jobId) {
    clearStaleTimer(jobId);
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');

    const [taskRows] = await pool.execute(
        `SELECT pq.video_id, v.hashed_video_id, pq.job_id
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ?`,
        [jobId]
    );

    if (taskRows.length === 0) {
        return false;
    }

    const { video_id, hashed_video_id, job_id } = taskRows[0];

    // Clean up any partial HLS output from the aborted job
    if (job_id) {
        try {
            await cleanR2Prefix(`${hashed_video_id}/${job_id}/`);
        } catch (err) {
            console.error(`R2 cleanup failed for aborted job ${jobId}:`, err.message);
        }
    }

    // Reset processing_queue row back to queued
    await pool.execute(
        `UPDATE processing_queue
         SET status = 'queued',
             job_id = NULL,
             worker_key_id = NULL,
             leased_at = NULL,
             last_heartbeat = NULL,
             pending_until = NULL,
             progress = 0,
             error_message = NULL,
             error_at = NULL
         WHERE job_id = ? AND status IN ('leased', 'processing', 'aborted')`,
        [jobId]
    );

    // Reset video status back to queued and clear encryption key
    await pool.execute(
        `UPDATE videos
         SET status = 'queued',
             processing_progress = 0,
             processing_error = NULL,
             processing_job_id = NULL,
             encryption_key = NULL
         WHERE video_id = ?`,
        [video_id]
    );

    return true;
}

module.exports = {
    createTask,
    leaseNextTask,
    updateTaskStatus,
    completeTask,
    reportError,
    resetStaleTasks,
    getTaskByJobId,
    generateShortJobId,
    resetExpiredPendingTasks,
    checkAvailableTask,
    leaseTask,
    generateUploadUrls,
    retryFailedVideo,
    abortAndRequeue,
    clearStaleTimer
};
