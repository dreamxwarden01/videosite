const backgroundTasks = require('../lib/backgroundTasks');
const crypto = require('crypto');
const { getPool } = require('../config/database');
const videoCache = require('./cache/videoCache');
const transcodeCache = require('./cache/transcodeProgressCache');
const queueCache = require('./cache/queueCache');
const posterLifecycle = require('./posterLifecycle');
const { legacyPosterKey, jobPosterKey } = require('./posterPaths');
const { isWorkerKeyId } = require('../lib/workerIdentity');

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
    const timerId = backgroundTasks.timeout(async () => {
        if (staleTimers.get(jobId) !== timerId) return;
        const stillCurrent = () => staleTimers.get(jobId) === timerId;
        let retry = false;
        try {
            retry = (await resetSingleStaleTask(jobId, stillCurrent)).retry;
        } catch {
            retry = true;
            console.error('Stale task check unavailable; retaining recovery timer');
        } finally {
            if (stillCurrent()) {
                staleTimers.delete(jobId);
                if (retry) startStaleTimer(jobId);
            }
        }
    }, STALE_TIMEOUT_MS);
    // Don't let the timer keep the process alive on shutdown
    timerId?.unref?.();
    staleTimers.set(jobId, timerId);
}

function clearStaleTimer(jobId) {
    const existing = staleTimers.get(jobId);
    if (existing) {
        backgroundTasks.cancel(existing);
        staleTimers.delete(jobId);
    }
}

// Timer-triggered: reset a single stale job. Partial R2 segments under
// `{hashed_video_id}/{job_id}/` are left in place — they'll be swept up at
// video-delete time via the `{hashed_video_id}/` prefix in pending_deletes.
// New attempts get a fresh job_id, so the orphaned subdirectory does not
// interfere with playback. The separate poster key is retired on reset.
async function readStaleHeartbeat(jobId) {
    let timeout;
    try {
        return await Promise.race([
            transcodeCache.getProgress(jobId).then(value => ({ available: true, value })),
            new Promise(resolve => { timeout = setTimeout(() => resolve({ available: false }), 1000); }),
        ]);
    } catch { return { available: false }; }
    finally { clearTimeout(timeout); }
}

async function resetSingleStaleTask(jobId, timerCurrent) {
    let retry = false;
    await resetJob(jobId, { source: 'stale_task', timerCurrent, onUncertain: () => { retry = true; } });
    return { retry };
}

async function createTask(videoId) {
    const pool = getPool();
    await pool.execute(
        'INSERT INTO processing_queue (video_id) VALUES (?)',
        [videoId]
    );
    await queueCache.markHasWork();
}

async function finishTaskEffects(videoId, jobId, requeue = false) {
    if (jobId) clearStaleTimer(jobId);
    const work = [() => videoCache.invalidate(videoId)];
    if (jobId) work.push(() => transcodeCache.clearJob(jobId));
    if (requeue) work.push(() => queueCache.markHasWork());
    const results = await Promise.allSettled(work.map(run => Promise.resolve().then(run)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
}

async function updateTaskStatus(jobId, status, progress = null, errorMessage = null, workerKeyId = null) {
    if (!isWorkerKeyId(workerKeyId)) return { found: false };
    if (status === 'error') return reportError(jobId, errorMessage || 'Unknown error', workerKeyId);
    if (!['leased', 'processing'].includes(status)) return { found: false };
    const result = await posterLifecycle.withCurrentJob(jobId, workerKeyId, async (db, video, job) => {
        if (!posterLifecycle.ACTIVE.has(job.status) || !posterLifecycle.ACTIVE_VIDEO.has(video.status)) return null;
        await db.execute(`UPDATE processing_queue SET status=?,last_heartbeat=NOW(),
            progress=COALESCE(?,progress),error_message=COALESCE(?,error_message) WHERE task_id=?`,
        [status, progress, errorMessage, job.task_id]);
        await db.execute(`UPDATE videos SET status=?,processing_progress=COALESCE(?,processing_progress),
            processing_error=COALESCE(?,processing_error) WHERE video_id=?`,
        [status === 'leased' ? 'worker_downloading' : 'processing', progress, errorMessage, video.video_id]);
        return { videoId: video.video_id };
    });
    if (result) { await videoCache.invalidate(result.videoId); startStaleTimer(jobId); }
    return { found: !!result };
}

async function completeTask(jobId, durationSeconds = null, hasPoster = false, workerKeyId = null) {
    if (!isWorkerKeyId(workerKeyId)) return false;
    const result = await posterLifecycle.withCurrentJob(jobId, workerKeyId, async (db, video, job) => {
        if (job.status === 'completed') return video.status === 'finished' ? { videoId: video.video_id } : null;
        if (!posterLifecycle.ACTIVE.has(job.status) || !posterLifecycle.ACTIVE_VIDEO.has(video.status)) return null;
        let posterPath = video.poster_path;
        if (hasPoster) {
            // Old workers report only at completion. A pre-upgrade signed PUT
            // has no planned path and therefore used the legacy stable key.
            posterPath = posterPath || legacyPosterKey(video.course_id, video.video_id);
            const expected = jobPosterKey(video.course_id, video.video_id, jobId);
            if (posterPath !== expected && posterPath !== legacyPosterKey(video.course_id, video.video_id)) {
                throw new Error('invalid_poster_generation');
            }
        }
        // Capture source cleanup in this commit. A later replacement must not
        // have its new source removed by an asynchronous video-id-only lookup.
        if (video.r2_source_key) {
            const match = /^source\/([A-Za-z0-9]{12})\/source\.[^/]+$/.exec(video.r2_source_key);
            if (!match) throw new Error('invalid_source_cleanup_target');
            await require('./deletionService').enqueuePrefix(`source/${match[1]}/`, {
                connection: db, source: 'transcode_completed',
            });
        }
        await db.execute(`UPDATE processing_queue SET status='completed',progress=100,last_heartbeat=NOW() WHERE task_id=?`, [job.task_id]);
        await db.execute(`UPDATE videos SET status='finished',processing_progress=100,
            duration_seconds=COALESCE(?,duration_seconds),has_poster=IF(?,1,has_poster),
            poster_path=?,r2_source_key=NULL WHERE video_id=?`,
        [durationSeconds, hasPoster ? 1 : 0, posterPath, video.video_id]);
        return { videoId: video.video_id };
    });
    if (!result) return false;
    await finishTaskEffects(result.videoId, jobId);
    return true;
}

async function reportError(jobId, errorMessage, workerKeyId = null) {
    if (!isWorkerKeyId(workerKeyId)) return { found: false };
    const result = await posterLifecycle.withCurrentJob(jobId, workerKeyId, async (db, video, job) => {
        if (job.status === 'error') return video.status === 'error' ? { videoId: video.video_id } : null;
        if (!posterLifecycle.ACTIVE.has(job.status) || !posterLifecycle.ACTIVE_VIDEO.has(video.status)) return null;
        await posterLifecycle.resetPoster(db, video, 'transcode_failed');
        await db.execute(`UPDATE processing_queue SET status='error',last_heartbeat=NOW(),
            error_message=?,error_at=NOW() WHERE task_id=?`, [errorMessage, job.task_id]);
        await db.execute(`UPDATE videos SET status='error',processing_error=? WHERE video_id=?`, [errorMessage, video.video_id]);
        return { videoId: video.video_id };
    });
    if (result) {
        await finishTaskEffects(result.videoId, jobId);
    }
    return { found: !!result };
}

async function resetJob(jobId, { workerKeyId = null, source = 'transcode_aborted', timerCurrent = null, onUncertain = null } = {}) {
    const result = await posterLifecycle.withCurrentJob(jobId, workerKeyId, async (db, video, job) => {
        if ((!posterLifecycle.ACTIVE.has(job.status) && job.status !== 'aborted') || !posterLifecycle.ACTIVE_VIDEO.has(video.status)) return null;
        if (source === 'stale_task') {
            // The only cache read under these locks is strictly bounded. A
            // heartbeat may have arrived while the SQL lock was unavailable.
            const check = await readStaleHeartbeat(jobId);
            if (!check.available) { onUncertain?.(); return null; }
            if (timerCurrent && !timerCurrent()) return null;
            const latest = check.value;
            // Polling lacks a local no-heartbeat proof. A still-current timer
            // can recover a dead job after Redis lost its marker; a newer local
            // heartbeat replaces that timer and fences this callback.
            if (!latest) {
                if (!timerCurrent || !timerCurrent()) return null;
            } else if (!Number.isFinite(latest.last_heartbeat) || latest.last_heartbeat <= 0) {
                onUncertain?.(); return null;
            } else if (Date.now() - latest.last_heartbeat <= STALE_TIMEOUT_MS) return null;
        }
        await posterLifecycle.resetPoster(db, video, source);
        await db.execute(`UPDATE processing_queue SET status='queued',job_id=NULL,worker_key_id=NULL,
            leased_at=NULL,last_heartbeat=NULL,pending_until=NULL,progress=0,error_message=NULL,error_at=NULL
            WHERE task_id=?`, [job.task_id]);
        await db.execute(`UPDATE videos SET status='queued',processing_progress=0,processing_error=NULL,
            processing_job_id=NULL,encryption_key=NULL WHERE video_id=?`, [video.video_id]);
        return { videoId: video.video_id };
    });
    if (!result) return false;
    await finishTaskEffects(result.videoId, jobId, true);
    return true;
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
    if (!isWorkerKeyId(workerKeyId)) return { videoId, status: 'notfound' };
    const pool = getPool();

    const jobId = await generateJobId();

    const task = await posterLifecycle.withVideo(videoId, async (db, video, jobs) => {
        if (jobs.length !== 1 || jobs[0].status !== 'pending') return { unavailable: true };
        const job = jobs[0];
        await posterLifecycle.resetPoster(db, video, 'poster_lease_reset');
        await db.execute(`UPDATE processing_queue SET status='leased',job_id=?,worker_key_id=?,
            leased_at=NOW(),last_heartbeat=NOW(),pending_until=NULL WHERE task_id=?`,
        [jobId, workerKeyId, job.task_id]);
        await db.execute(`UPDATE videos SET status='worker_downloading',processing_job_id=?,
            encryption_key=NULL WHERE video_id=?`, [jobId, video.video_id]);
        return { ...job, ...video, job_id: jobId, worker_key_id: workerKeyId };
    });
    if (!task) return { videoId, status: 'notfound' };
    if (task.unavailable) return { videoId, status: 'taken' };
    startStaleTimer(jobId);
    await videoCache.invalidate(task.video_id);

    // Seed the coalesced progress cache. Status RPCs perform one batched SQL
    // authority read, then write their running progress only to Redis.
    await transcodeCache.initOnLease(jobId, task.video_id, task.hashed_video_id, task.course_id, 'leased', 'worker_downloading');
    // A reset/replacement can commit between lease commit and this Redis write.
    // Recheck after warming: either it clears our marker after this point, or
    // this check observes retirement and removes the late marker itself.
    const [stillCurrent] = await pool.execute(`SELECT 1 FROM processing_queue pq JOIN videos v ON v.video_id=pq.video_id
        WHERE pq.job_id=? AND pq.worker_key_id=? AND pq.status IN ('leased','processing')
          AND v.processing_job_id=pq.job_id`, [jobId, workerKeyId]);
    if (!stillCurrent.length) {
        clearStaleTimer(jobId);
        await transcodeCache.clearJob(jobId);
        return { videoId, status: 'notfound' };
    }

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
            segment_duration: p.segment_duration,
            gop_seconds: parseFloat(p.gop_seconds)
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
//   - failed   → reportError (moves to 'error' and retires its poster atomically)
//   - aborted  → abortAndRequeue (requeue without counting as a fault)
// Returns a parallel array of { jobId, ack } so the worker can drop unknown ids.
async function reportJobStatuses(jobs, workerKeyId = null) {
    if (!isWorkerKeyId(workerKeyId)) return Array.isArray(jobs) ? jobs.map(job => ({ jobId: typeof job?.jobId === 'string' ? job.jobId : null, ack: false })) : [];
    if (!Array.isArray(jobs) || jobs.length === 0) return [];
    if (jobs.length > 256) throw new Error('status_batch_too_large');

    // Map stage keyword → (queue_status, video_status)
    const stageMap = {
        downloading: { queue: 'leased',     video: 'worker_downloading' },
        processing:  { queue: 'processing', video: 'processing' },
        transcoding: { queue: 'processing', video: 'processing' },
        uploading:   { queue: 'processing', video: 'worker_uploading' }
    };

    // One authority read per batched RPC. Progress writes remain coalesced in
    // Redis; a surviving old cache entry cannot keep a retired writer alive.
    const ids = [...new Set(jobs.map(job => job?.jobId).filter(id => typeof id === 'string' && /^[A-Za-z0-9]{12}$/.test(id)))];
    const current = new Map();
    if (ids.length) {
        const [rows] = await getPool().execute(`SELECT pq.job_id,pq.video_id,pq.status,pq.worker_key_id,
            v.course_id,v.hashed_video_id,v.status AS video_status FROM processing_queue pq
            JOIN videos v ON v.video_id=pq.video_id
            WHERE pq.job_id IN (${ids.map(() => '?').join(',')}) AND v.processing_job_id=pq.job_id
              AND (? IS NULL OR pq.worker_key_id=?)`, [...ids, workerKeyId, workerKeyId]);
        for (const row of rows) current.set(row.job_id, current.has(row.job_id) ? null : row);
    }
    const results = [];
    for (const job of jobs) {
        if (!job || !job.jobId) { results.push({ jobId: null, ack: false }); continue; }
        const { jobId, status } = job;
        const authoritative = current.get(jobId);
        if (!authoritative) { results.push({ jobId, ack: false }); continue; }
        let found = false;
        try {
            if (status === 'running') {
                if (!posterLifecycle.ACTIVE.has(authoritative.status)
                    || !posterLifecycle.ACTIVE_VIDEO.has(authoritative.video_status)) {
                    results.push({ jobId, ack: false }); continue;
                }
                // Heartbeat writes remain Redis-only. The batched SQL snapshot
                // above establishes current lease ownership and attempt identity.
                const stageKey = (job.stage || '').toLowerCase();
                const mapped = stageMap[stageKey] || stageMap.processing;
                const progress = typeof job.progress === 'number' ? job.progress : null;

                found = await transcodeCache.recordHeartbeat(
                    jobId, mapped.queue, mapped.video, progress, stageKey || 'processing'
                );

                // Warm from this RPC's current-owner snapshot on cache loss.
                // A reset racing this write is caught by the next authority read;
                // it cannot keep an old job alive indefinitely through Redis.
                if (!found) {
                    await transcodeCache.initOnLease(jobId, authoritative.video_id, authoritative.hashed_video_id,
                        authoritative.course_id, mapped.queue, mapped.video);
                    found = await transcodeCache.recordHeartbeat(
                        jobId, mapped.queue, mapped.video, progress, stageKey || 'processing'
                    );
                }

                // Refresh the in-process stale timer so an abandoned worker
                // is detected without waiting for the poll-based sweep.
                if (found) startStaleTimer(jobId);
            } else if (status === 'failed') {
                // Terminal: write DB immediately, drop the cache.
                const r = await reportError(jobId, job.errorMessage || 'Unknown error', workerKeyId);
                found = !!r.found;
            } else if (status === 'aborted') {
                found = await abortAndRequeue(jobId, workerKeyId);
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
    // Per-video poster thumbnail (poster.jpg). The worker writes one of
    // these into the job output dir alongside the manifest, so the existing
    // upload sweep picks it up like any other rendition file.
    if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) {
        return 'image/jpeg';
    }
    return 'application/octet-stream';
}

// Generate presigned PUT URLs for uploading HLS output files. Each batch checks
// the current SQL lease and owner, including media-only batches after the early
// poster. Signing runs after releasing locks; no storage call is made in SQL.
//
// Key layout per filename:
//   - "poster.jpg" → `posters/{course_id}/{video_id}/{job_id}.jpg`, prepared
//      under the current-lease lock before a URL is issued. Readiness is separate
//      from this planned path; late cleanup never targets a newer generation.
//   - everything else → `{hashed_video_id}/{job_id}/{filename}` (job-scoped
//      so retries land in a fresh subtree and orphans clear when the parent
//      hash prefix is reaped).
async function generateUploadUrls(jobId, filenames, workerKeyId = null) {
    if (!isWorkerKeyId(workerKeyId)) return null;
    let poster = null;
    if (filenames.includes('poster.jpg')) {
        poster = await posterLifecycle.preparePosterUpload(jobId, workerKeyId);
        if (!poster) return null;
    }
    // Redis progress is an overlay, not authority to mint new write URLs. A
    // stale cache surviving reset must not re-authorize an old attempt.
    const current = await posterLifecycle.withCurrentJob(jobId, workerKeyId, async (_db, video, job) => {
        if (!posterLifecycle.ACTIVE.has(job.status) || !posterLifecycle.ACTIVE_VIDEO.has(video.status)) return null;
        return { hashedVideoId: video.hashed_video_id, courseId: video.course_id, videoId: video.video_id };
    });
    if (!current) return null;
    const { hashedVideoId, courseId, videoId } = current;

    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { getR2Client, getR2BucketName } = require('../config/r2');

    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const urls = {};

    for (const filename of filenames) {
        const key = filename === 'poster.jpg'
            ? poster.key
            : `${hashedVideoId}/${jobId}/${filename}`;
        const contentType = contentTypeForFile(filename);
        const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' });
        urls[filename] = await getSignedUrl(r2, command, { expiresIn: 43200 }); // 12 hours
    }

    return { urls };
}

// Re-queue a failed video for transcoding.
// Partial output from the previous failed job stays under
// `{hashed_video_id}/{old_job_id}/` — the retry gets a new job_id and writes
// to its own subdirectory. Orphans get swept at video-delete time via the
// hash-prefix entry in pending_deletes.
async function retryFailedVideo(videoId) {
    const result = await posterLifecycle.withVideo(videoId, async (db, video, jobs) => {
        if (video.status !== 'error' || jobs.length !== 1 || jobs[0].status !== 'error') return null;
        const job = jobs[0];
        await posterLifecycle.resetPoster(db, video, 'transcode_retry');
        await db.execute(`UPDATE processing_queue SET status='queued',job_id=NULL,worker_key_id=NULL,
            leased_at=NULL,last_heartbeat=NULL,pending_until=NULL,progress=0,error_message=NULL,error_at=NULL,
            cleared=0,created_at=NOW() WHERE task_id=?`, [job.task_id]);
        await db.execute(`UPDATE videos SET status='queued',processing_progress=0,processing_error=NULL,
            processing_job_id=NULL,encryption_key=NULL WHERE video_id=?`, [video.video_id]);
        return { videoId: video.video_id, jobId: job.job_id };
    });
    if (!result) return false;
    await finishTaskEffects(result.videoId, result.jobId, true);
    return true;
}

// Reset stale tasks (no heartbeat for STALE_TIMEOUT_MS) — poll-based fallback.
// Backstop for the in-process timer (which is lost on server restart). Reads
// last_heartbeat from Redis (source of truth for live workers); the DB
// last_heartbeat lags by one flush cycle and isn't reliable here.
//
// Partial R2 segments from the dead worker are left in place — they'll be
// swept at video-delete time via the `{hashed_video_id}/` prefix entry in
// pending_deletes. The retry attempt gets a fresh job_id, writing to a new
// subdirectory.
async function resetStaleTasks() {
    const pool = getPool();

    // Pull every in-flight task from DB; we'll filter by Redis next.
    const [inFlight] = await pool.execute(
        `SELECT pq.job_id, pq.video_id
         FROM processing_queue pq
         WHERE pq.status IN ('leased', 'processing') AND pq.job_id IS NOT NULL`
    );

    if (inFlight.length === 0) return 0;

    const now = Date.now();
    const staleTasks = [];
    for (const task of inFlight) {
        const check = await readStaleHeartbeat(task.job_id);
        if (!check.available) { if (!staleTimers.has(task.job_id)) startStaleTimer(task.job_id); continue; }
        const cached = check.value;
        // A miss is not immediate evidence of death. Arm a local no-heartbeat
        // window if none survived restart; a healthy worker's next batch replaces
        // it. This also recovers leases whose initial Redis write failed.
        if (!cached || !cached.last_heartbeat) {
            if (!staleTimers.has(task.job_id)) startStaleTimer(task.job_id);
            continue;
        }
        if (now - cached.last_heartbeat > STALE_TIMEOUT_MS) staleTasks.push(task);
    }

    if (staleTasks.length === 0) return 0;

    let resetCount = 0;
    for (const task of staleTasks) {
        // resetJob rechecks freshness after acquiring the SQL locks.
        if (await resetJob(task.job_id, { source: 'stale_task' })) resetCount++;
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
// Partial R2 output from the aborted job stays under
// `{hashed_video_id}/{job_id}/` — the requeue picks up a new job_id on next
// lease and writes to a fresh subdirectory. Orphans get swept at
// video-delete time via the hash-prefix entry in pending_deletes. Posters are
// retired separately in the same reset transaction.
async function abortAndRequeue(jobId, workerKeyId = null) {
    if (!isWorkerKeyId(workerKeyId)) return false;
    return resetJob(jobId, { workerKeyId });
}

// Replacement commits source/attempt state, poster retirement, old-output
// cleanup and the upload-session receipt together. No R2 request occurs here.
async function replaceVideoSource(session, actualSize, receiptOnly = false) {
    const result = await posterLifecycle.withVideo(session.video_id, async (db, video, jobs) => {
        const [[upload]] = await db.execute('SELECT * FROM upload_sessions WHERE upload_id=? FOR UPDATE', [session.upload_id]);
        if (!upload || Number(upload.video_id) !== Number(video.video_id)
            || upload.object_key !== session.object_key || !['completing', 'completed'].includes(upload.status)) return null;
        if (upload.status === 'completed') return { videoId: video.video_id, oldJobs: [], replayed: true };
        if (receiptOnly) return null;
        const deletion = require('./deletionService');
        const sourceDir = key => {
            const match = /^source\/([A-Za-z0-9]{12})\/source\.[^/]+$/.exec(key || '');
            if (!match) throw new Error('invalid_source_cleanup_target');
            return `source/${match[1]}/`;
        };
        sourceDir(upload.object_key);
        // Recover a response-lost pre-upgrade replacement without deleting its
        // own accepted source. New replacements have the receipt in this commit.
        if (video.r2_source_key === upload.object_key) {
            if (!jobs.length && video.status === 'queued') await db.execute('INSERT INTO processing_queue(video_id) VALUES(?)', [video.video_id]);
            await db.execute("UPDATE upload_sessions SET status='completed',completed_at=NOW() WHERE upload_id=?", [upload.upload_id]);
            return { videoId: video.video_id, oldJobs: [], replayed: true };
        }
        if (video.r2_source_key) await deletion.enqueuePrefix(sourceDir(video.r2_source_key), { connection: db, source: 'video_replace' });
        if (video.processing_job_id) {
            if (!/^[A-Za-z0-9]{64}$/.test(video.hashed_video_id) || !/^[A-Za-z0-9_-]{1,64}$/.test(video.processing_job_id)) throw new Error('invalid_output_cleanup_target');
            const active = jobs.some(job => posterLifecycle.ACTIVE.has(job.status))
                || ['worker_downloading', 'processing', 'worker_uploading'].includes(video.status);
            await deletion.enqueuePrefix(`${video.hashed_video_id}/${video.processing_job_id}/`, {
                connection: db, source: 'video_replace', execute_at: new Date(Date.now() + (active ? 120000 : 0)),
            });
        }
        await posterLifecycle.resetPoster(db, video, 'video_replace');
        await db.execute('DELETE FROM processing_queue WHERE video_id=?', [video.video_id]);
        await db.execute(`UPDATE videos SET r2_source_key=?,original_filename=?,file_size_bytes=?,
            status='queued',processing_job_id=NULL,encryption_key=NULL,processing_progress=0,
            processing_error=NULL,duration_seconds=NULL,video_type='cmaf' WHERE video_id=?`,
        [upload.object_key, upload.original_filename, actualSize, video.video_id]);
        await db.execute('INSERT INTO processing_queue(video_id) VALUES(?)', [video.video_id]);
        await db.execute('DELETE FROM watch_progress WHERE video_id=?', [video.video_id]);
        await db.execute("UPDATE upload_sessions SET status='completed',completed_at=NOW() WHERE upload_id=?", [upload.upload_id]);
        return { videoId: video.video_id, oldJobs: jobs.map(job => job.job_id).filter(Boolean), replayed: false };
    });
    if (!result) return false;
    for (const oldJob of result.oldJobs) clearStaleTimer(oldJob);
    const effects = [() => videoCache.invalidate(result.videoId), () => queueCache.markHasWork(),
        ...result.oldJobs.map(oldJob => () => transcodeCache.clearJob(oldJob))];
    if (!result.replayed) effects.push(() => require('./cache/watchProgressCache').clearForVideo(result.videoId));
    const settled = await Promise.allSettled(effects.map(run => Promise.resolve().then(run)));
    const failed = settled.find(value => value.status === 'rejected');
    if (failed) throw failed.reason;
    return true;
}

module.exports = {
    createTask,
    replaceVideoSource,
    updateTaskStatus,
    completeTask,
    confirmPosterReady: posterLifecycle.confirmPosterReady,
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
