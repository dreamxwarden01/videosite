const crypto = require('crypto');
const { getPool } = require('../config/database');
const videoCache = require('./cache/videoCache');
const transcodeCache = require('./cache/transcodeProgressCache');
const queueCache = require('./cache/queueCache');

// Base62 12-char job ID generator (matches hashed_video_id family).
// Collision probability in a 62^12 space is astronomically low (~10^-14 at
// 10k concurrent jobs), but the column has no UNIQUE constraint so a freak
// collision would silently double-write to the same job_id. The retry loop
// keeps the old behavior: generate → SELECT → retry if taken.
const JOB_ID_BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function generateJobIdCandidate() {
    const buf = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) out += JOB_ID_BASE62[buf[i] % 62];
    return out;
}
async function generateJobId() {
    const pool = getPool();
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generateJobIdCandidate();
        const [existing] = await pool.execute(
            'SELECT 1 FROM processing_queue WHERE job_id = ? LIMIT 1',
            [candidate]
        );
        if (existing.length === 0) return candidate;
    }
    // 10 consecutive collisions in a 62^12 space is effectively impossible —
    // if it happens, the DB is almost certainly corrupted or the PRNG broken.
    throw new Error('generateJobId: 10 consecutive collisions — aborting');
}

// --- Per-job stale detection timers ---
// Each active job gets a 2-minute timer that resets on every heartbeat.
// When the timer fires, the job is checked and reset if truly stale.
const staleTimers = new Map(); // jobId → timeoutId
// 2 minutes of no heartbeat = stale. The check reads last_heartbeat from
// Redis (the source of truth for live workers); DB last_heartbeat lags by
// one flush cycle and isn't reliable here.
const STALE_TIMEOUT_MS = 2 * 60 * 1000;

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

    // Double-check staleness via Redis (the source of truth for live workers).
    // The in-process timer fires after STALE_TIMEOUT_MS of no in-process
    // heartbeat, but a late heartbeat could have just landed in Redis between
    // the timer schedule and now — so we re-read last_heartbeat from cache.
    const cached = await transcodeCache.getProgress(jobId);
    if (cached && cached.last_heartbeat && Date.now() - cached.last_heartbeat < STALE_TIMEOUT_MS) {
        return; // Heartbeat is fresh — not stale.
    }

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

    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'queued', job_id = NULL, worker_key_id = NULL,
             leased_at = NULL, last_heartbeat = NULL, pending_until = NULL,
             progress = 0, error_message = NULL, error_at = NULL
         WHERE job_id = ? AND status IN ('leased', 'processing')`,
        [jobId]
    );

    if (result.affectedRows === 0) return; // Job state changed concurrently.

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
    await videoCache.invalidate(task.video_id);
    await transcodeCache.clearJob(jobId);
    await queueCache.markHasWork();
}

async function createTask(videoId) {
    const pool = getPool();
    await pool.execute(
        'INSERT INTO processing_queue (video_id) VALUES (?)',
        [videoId]
    );
    await queueCache.markHasWork();
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

    // Guard: never downgrade a terminal state (completed / error) back to a
    // processing state. Stale worker status reports can race with a successful
    // /tasks/complete when the same worker holds another in-flight job — the
    // job that just completed may still be in the worker's next /tasks/status
    // batch because the job goroutine hasn't finished its defer cleanup yet.
    // Without this guard that batch would flip the row from 'completed' back
    // to 'processing', re-arm the stale timer, and 2 minutes later the stale
    // sweep would wipe the already-uploaded HLS output from R2.
    //
    // Admin-driven resets (retryFailedVideo, video replace) update the queue
    // row directly and don't route through updateTaskStatus, so they're
    // unaffected by this guard.
    const [result] = await pool.execute(
        `UPDATE processing_queue SET ${fields.join(', ')}
         WHERE job_id = ? AND status NOT IN ('completed', 'error')`,
        values
    );

    // affectedRows === 0 means either the job_id doesn't exist OR the row is
    // already in a terminal state. Either way, tell the worker to drop the
    // job — there's nothing left to update on the server side.
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
    await transcodeCache.clearJob(jobId);
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

// Reset expired pending tasks (check-then-lease timeout)
async function resetExpiredPendingTasks() {
    const pool = getPool();
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'queued', pending_until = NULL
         WHERE status = 'pending' AND pending_until < NOW()`
    );
    if (result.affectedRows > 0) await queueCache.markHasWork();
}

// Reserve up to maxCount queued tasks atomically (queued → pending, 10s hold).
// Returns array of video_ids. Uses FOR UPDATE SKIP LOCKED so parallel workers
// don't collide on the same candidate rows.
async function reserveTasks(maxCount) {
    if (!Number.isInteger(maxCount) || maxCount <= 0) return [];

    const pool = getPool();

    // Stale-task reset and pending-TTL reset are handled by a 60s timer in
    // server.js — no longer per-poll. The in-process per-job timer
    // (startStaleTimer) still catches mid-flight worker death within 2 min.

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query(
            `SELECT task_id, video_id
             FROM processing_queue
             WHERE status = 'queued'
             ORDER BY created_at ASC
             LIMIT ?
             FOR UPDATE SKIP LOCKED`,
            [maxCount]
        );

        if (rows.length === 0) {
            await conn.commit();
            return [];
        }

        const taskIds = rows.map(r => r.task_id);
        await conn.query(
            `UPDATE processing_queue
             SET status = 'pending', pending_until = DATE_ADD(NOW(), INTERVAL 10 SECOND)
             WHERE task_id IN (?)`,
            [taskIds]
        );

        await conn.commit();
        return rows.map(r => r.video_id);
    } catch (err) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw err;
    } finally {
        conn.release();
    }
}

// Lease a specific pending task. Returns a per-video result object that can
// include status: "leased" (full spec), "taken" (lost the race), or "notfound"
// (videoId not in queue). Called directly and via the batched leaseTasks wrapper.
async function leaseTask(videoId, workerKeyId) {
    const pool = getPool();

    const jobId = await generateJobId();

    // Atomically update pending → leased for this specific video
    const [result] = await pool.execute(
        `UPDATE processing_queue
         SET status = 'leased', job_id = ?, worker_key_id = ?, leased_at = NOW(),
             last_heartbeat = NOW(), pending_until = NULL
         WHERE video_id = ? AND status = 'pending'`,
        [jobId, workerKeyId, videoId]
    );

    if (result.affectedRows === 0) {
        // Either the row is not pending (lost the race) or doesn't exist at all.
        const [existRows] = await pool.execute(
            'SELECT 1 FROM processing_queue WHERE video_id = ? LIMIT 1',
            [videoId]
        );
        return { videoId, status: existRows.length > 0 ? 'taken' : 'notfound' };
    }

    // Get task details for download URL generation
    const [rows] = await pool.execute(
        `SELECT pq.*, v.course_id, v.hashed_video_id, v.r2_source_key, v.original_filename, v.video_type
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.job_id = ?`,
        [jobId]
    );

    if (rows.length === 0) {
        return { isLeaseSuccess: false, jobId: null, downloadUrl: null };
    }

    const task = rows[0];

    // The worker only processes CMAF jobs now — legacy TS support was removed
    // when the last in-flight TS job drained. Already-finished video_type='ts'
    // rows still serve via /api/keys for playback, but no new TS work enters
    // the pipeline. Clear any stale key column on every lease so the row's
    // shape matches the unencrypted CMAF output.
    await pool.execute(
        "UPDATE videos SET status = 'worker_downloading', processing_job_id = ?, encryption_key = NULL WHERE video_id = ?",
        [jobId, task.video_id]
    );
    await videoCache.invalidate(task.video_id);

    // Seed the heartbeat cache. Subsequent /worker/tasks/status (running)
    // hits HEXISTS this key as the "is the job alive" gate — no DB query.
    await transcodeCache.initOnLease(jobId, task.video_id, task.hashed_video_id, 'leased', 'worker_downloading');

    // Generate presigned download URL
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { getR2Client, getR2BucketName } = require('../config/r2');

    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const command = new GetObjectCommand({ Bucket: bucket, Key: task.r2_source_key });
    const downloadUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    // Fetch transcoding profiles, audio normalization, and site-wide audio bitrate
    const {
        getEffectiveProfiles, getAudioNormalizationSettings, getAudioBitrateDefault
    } = require('./transcodingProfileService');
    const [courseRows] = await pool.execute(
        'SELECT audio_normalization FROM courses WHERE course_id = ?',
        [task.course_id]
    );
    const courseAudioNorm = courseRows.length > 0 ? courseRows[0].audio_normalization === 1 : true;

    const profiles = await getEffectiveProfiles(task.course_id);
    const normSettings = await getAudioNormalizationSettings();
    const audioBitrateKbps = await getAudioBitrateDefault();

    startStaleTimer(jobId);
    return {
        isLeaseSuccess: true, jobId, downloadUrl, videoId: task.video_id,
        audioBitrateKbps,
        outputProfiles: profiles.map(p => ({
            name: p.name, width: p.width, height: p.height,
            video_bitrate_kbps: p.video_bitrate_kbps,
            fps_limit: p.fps_limit,
            codec: p.codec, profile: p.profile, preset: p.preset,
            segment_duration: p.segment_duration, gop_size: p.gop_size
        })),
        audioNormalization: courseAudioNorm,
        audioNormalizationTarget: parseFloat(normSettings.target),
        audioNormalizationPeak: parseFloat(normSettings.peak),
        audioNormalizationMaxGain: parseFloat(normSettings.maxGain)
    };
}

// Batched lease — runs leaseTask sequentially for each videoId and returns
// an array of per-video results. A "leased" result carries the full job spec;
// "taken" / "notfound" results only carry the videoId so the worker can skip.
async function leaseTasks(videoIds, workerKeyId) {
    if (!Array.isArray(videoIds) || videoIds.length === 0) return [];
    const results = [];
    for (const videoId of videoIds) {
        try {
            const r = await leaseTask(videoId, workerKeyId);
            if (r && r.isLeaseSuccess) {
                results.push({
                    videoId: r.videoId,
                    status: 'leased',
                    jobId: r.jobId,
                    downloadUrl: r.downloadUrl,
                    audioBitrateKbps: r.audioBitrateKbps,
                    outputProfiles: r.outputProfiles,
                    audioNormalization: r.audioNormalization,
                    audioNormalizationTarget: r.audioNormalizationTarget,
                    audioNormalizationPeak: r.audioNormalizationPeak,
                    audioNormalizationMaxGain: r.audioNormalizationMaxGain
                });
            } else if (r && r.status === 'taken') {
                results.push({ videoId, status: 'taken' });
            } else {
                results.push({ videoId, status: 'notfound' });
            }
        } catch (err) {
            console.error(`leaseTask failed for video ${videoId}:`, err.message);
            results.push({ videoId, status: 'error' });
        }
    }
    return results;
}

// Handle a batched status report from the worker.
// Each entry is { jobId, status, stage?, progress?, errorMessage? }:
//   - running  → updateTaskStatus (maps stage → queue/video status)
//   - failed   → reportError (moves to 'error', increments attempts via existing logic)
//   - aborted  → abortAndRequeue (requeue without counting as a fault)
// Returns a parallel array of { jobId, ack } so the worker can drop unknown ids.
async function reportJobStatuses(jobs) {
    if (!Array.isArray(jobs) || jobs.length === 0) return [];

    // Map stage keyword → (queue_status, video_status)
    const stageMap = {
        downloading: { queue: 'leased',     video: 'worker_downloading' },
        processing:  { queue: 'processing', video: 'processing' },
        transcoding: { queue: 'processing', video: 'processing' },
        uploading:   { queue: 'processing', video: 'worker_uploading' }
    };

    const results = [];
    for (const job of jobs) {
        if (!job || !job.jobId) { results.push({ jobId: null, ack: false }); continue; }
        const { jobId, status } = job;
        let found = false;
        try {
            if (status === 'running') {
                // Heartbeat hot path: write to Redis only. The cache's
                // existence (set on lease, cleared on terminal/abort/delete)
                // is the alive-gate — no DB query per heartbeat. The flusher
                // drains dirty:transcode every 15 min into processing_queue.
                const stageKey = (job.stage || '').toLowerCase();
                const mapped = stageMap[stageKey] || stageMap.processing;
                const progress = typeof job.progress === 'number' ? job.progress : null;

                found = await transcodeCache.recordHeartbeat(
                    jobId, mapped.queue, mapped.video, progress, stageKey || 'processing'
                );

                // Cache miss path: Redis may have cold-restarted while a
                // healthy worker was still running. Re-check the DB; if the
                // job exists and isn't terminal, warm the cache and proceed.
                if (!found) {
                    const task = await getTaskByJobId(jobId);
                    if (task && task.status !== 'completed' && task.status !== 'error') {
                        await transcodeCache.initOnLease(jobId, task.video_id, task.hashed_video_id, mapped.queue, mapped.video);
                        found = await transcodeCache.recordHeartbeat(
                            jobId, mapped.queue, mapped.video, progress, stageKey || 'processing'
                        );
                    }
                }

                // Refresh the in-process stale timer so an abandoned worker
                // is detected without waiting for the poll-based sweep.
                if (found) startStaleTimer(jobId);
            } else if (status === 'failed') {
                // Terminal: write DB immediately, drop the cache.
                const r = await reportError(jobId, job.errorMessage || 'Unknown error');
                found = !!r.found;
                await transcodeCache.clearJob(jobId);
            } else if (status === 'aborted') {
                found = await abortAndRequeue(jobId);
                await transcodeCache.clearJob(jobId);
            } else {
                // Unknown status value — treat as ack:false so worker drops it.
                found = false;
            }
        } catch (err) {
            console.error(`reportJobStatuses error for job ${jobId}:`, err.message);
            found = false;
        }
        results.push({ jobId, ack: found });
    }
    return results;
}

// Map file extension to the correct MIME type for R2 storage. Covers the
// CMAF (fMP4 HLS + DASH) outputs the worker produces — .m3u8 playlists,
// .mpd manifests, .mp4 init segments, .m4s media segments.
//
// MUST mirror worker/internal/api/upload.go contentTypeForFile byte-for-byte.
// R2 rejects the PUT with SignatureDoesNotMatch if the signed URL's
// ContentType doesn't match the header the worker actually sends; the two
// implementations live in different languages but must agree on every input.
//
// For .mp4 / .m4s we branch on whether the path sits under an `/audio/`
// directory: the filename passed here is the job-relative path (e.g.
// `audio/aac_192k/init.mp4` or `video/1080p/segment_0003.m4s`), so we can
// tell init + segments under the audio rendition apart from the video
// renditions by path substring alone. audio/mp4 is purely descriptive in
// the R2 object metadata — browsers don't consume the HTTP Content-Type
// for fMP4 init/media segments (Safari reads the box structure; Shaka
// trusts the AdaptationSet's mimeType), but `aws s3api head-object` now
// returns the honest type for anyone auditing the bucket.
function contentTypeForFile(filename) {
    if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (filename.endsWith('.mpd'))  return 'application/dash+xml';
    // .m4s = CMAF media segment, .mp4 = fMP4 init segment.
    //
    // Prepend a leading "/" so relative paths ("audio/aac_192k/init.mp4")
    // and absolute paths ("/tmp/foo/audio/...") both match the same way.
    // The worker passes absolute local filesystem paths; the server passes
    // job-relative paths. Both forms must resolve to the same ContentType
    // or R2 rejects the signed PUT with SignatureDoesNotMatch.
    if (filename.endsWith('.m4s') || filename.endsWith('.mp4')) {
        return ('/' + filename).includes('/audio/') ? 'audio/mp4' : 'video/mp4';
    }
    return 'application/octet-stream';
}

// Generate presigned PUT URLs for uploading HLS output files.
// Reads hashed_video_id from the transcode-progress cache (populated by
// initOnLease) to avoid the JOIN on every upload-URL batch. Falls back
// to DB on cache miss (e.g. Redis cold-restart before any heartbeat).
async function generateUploadUrls(jobId, filenames) {
    let hashedVideoId = null;
    const cached = await transcodeCache.getProgress(jobId);
    if (cached && cached.hashed_video_id) {
        hashedVideoId = cached.hashed_video_id;
    } else {
        const pool = getPool();
        const [rows] = await pool.execute(
            `SELECT v.hashed_video_id
             FROM processing_queue pq
             JOIN videos v ON pq.video_id = v.video_id
             WHERE pq.job_id = ?`,
            [jobId]
        );
        if (rows.length === 0) return null;
        hashedVideoId = rows[0].hashed_video_id;
    }

    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { getR2Client, getR2BucketName } = require('../config/r2');

    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const urls = {};

    for (const filename of filenames) {
        const key = `${hashedVideoId}/${jobId}/${filename}`;
        const contentType = contentTypeForFile(filename);
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
    await videoCache.invalidate(videoId);
    if (oldJobId) await transcodeCache.clearJob(oldJobId);
    await queueCache.markHasWork();

    return true;
}

// Reset stale tasks (no heartbeat for STALE_TIMEOUT_MS) — poll-based fallback.
// Backstop for the in-process timer (which is lost on server restart). Reads
// last_heartbeat from Redis (source of truth for live workers); the DB
// last_heartbeat lags by one flush cycle and isn't reliable here.
async function resetStaleTasks() {
    const pool = getPool();
    const { cleanR2Prefix } = require('./videoService');

    // Pull every in-flight task from DB; we'll filter by Redis next.
    const [inFlight] = await pool.execute(
        `SELECT pq.job_id, pq.video_id, v.hashed_video_id
         FROM processing_queue pq
         JOIN videos v ON pq.video_id = v.video_id
         WHERE pq.status IN ('leased', 'processing') AND pq.job_id IS NOT NULL`
    );

    if (inFlight.length === 0) return 0;

    const now = Date.now();
    const staleTasks = [];
    for (const task of inFlight) {
        const cached = await transcodeCache.getProgress(task.job_id);
        // If cache is missing entirely (e.g. Redis restart), be conservative
        // and skip — the worker's next heartbeat will repopulate via the
        // recordHeartbeat fallback path.
        if (!cached || !cached.last_heartbeat) continue;
        if (now - cached.last_heartbeat > STALE_TIMEOUT_MS) staleTasks.push(task);
    }

    if (staleTasks.length === 0) return 0;

    let resetCount = 0;
    for (const task of staleTasks) {
        const [result] = await pool.execute(
            `UPDATE processing_queue
             SET status = 'queued', job_id = NULL, worker_key_id = NULL,
                 leased_at = NULL, last_heartbeat = NULL, pending_until = NULL,
                 progress = 0, error_message = NULL, error_at = NULL
             WHERE job_id = ? AND status IN ('leased', 'processing')`,
            [task.job_id]
        );

        if (result.affectedRows === 0) continue; // Job state changed concurrently.

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
        await videoCache.invalidate(task.video_id);
        await transcodeCache.clearJob(task.job_id);
    }

    if (resetCount > 0) await queueCache.markHasWork();
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
    await videoCache.invalidate(video_id);
    await transcodeCache.clearJob(job_id);
    await queueCache.markHasWork();

    return true;
}

module.exports = {
    createTask,
    updateTaskStatus,
    completeTask,
    reportError,
    resetStaleTasks,
    getTaskByJobId,
    generateJobId,
    resetExpiredPendingTasks,
    reserveTasks,
    leaseTask,
    leaseTasks,
    reportJobStatuses,
    generateUploadUrls,
    retryFailedVideo,
    abortAndRequeue,
    clearStaleTimer
};
