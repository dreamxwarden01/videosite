'use strict';
const { getPool } = require('../config/database');
const videoCache = require('./cache/videoCache');
const { JOB_ID, legacyPosterKey, jobPosterKey, ownedPosterKey, confirmedPosterKey } = require('./posterPaths');
const { isWorkerKeyId } = require('../lib/workerIdentity');

const ACTIVE = new Set(['leased', 'processing']);
const ACTIVE_VIDEO = new Set(['worker_downloading', 'processing', 'worker_uploading']);

// Every lifecycle writer locks the video before its queue rows, matching video
// and course deletion. Never hold these locks across an R2 or HTTP request.
async function withVideo(videoId, work) {
    const db = await getPool().getConnection();
    let commitStarted = false, reusable = true;
    try {
        await db.beginTransaction();
        const [[video]] = await db.execute('SELECT * FROM videos WHERE video_id=? FOR UPDATE', [videoId]);
        let result = null;
        if (video) {
            const [jobs] = await db.execute('SELECT * FROM processing_queue WHERE video_id=? FOR UPDATE', [video.video_id]);
            result = await work(db, video, jobs);
        }
        commitStarted = true;
        await db.commit();
        return result;
    } catch (error) {
        if (commitStarted) reusable = false;
        try { await db.rollback(); } catch { reusable = false; }
        if (commitStarted) {
            // A lost COMMIT reply may still have changed readiness. Only evict
            // refillable metadata here; do not cancel writers on an unknown result.
            await videoCache.invalidate(videoId).catch(() => {});
        }
        throw error;
    } finally {
        if (reusable) db.release();
        else db.destroy();
    }
}

async function withCurrentJob(jobId, workerKeyId, work) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return null;
    const [matches] = await getPool().execute('SELECT video_id FROM processing_queue WHERE job_id=?', [jobId]);
    if (matches.length !== 1) return null;
    return withVideo(matches[0].video_id, async (db, video, jobs) => {
        const current = jobs.filter(job => job.job_id === jobId);
        if (current.length !== 1 || video.processing_job_id !== jobId) return null;
        const job = current[0];
        if (workerKeyId != null && String(job.worker_key_id) !== String(workerKeyId)) return null;
        return work(db, video, job);
    });
}

async function resetPoster(db, video, source) {
    let old = null;
    if (video.poster_path != null) {
        old = ownedPosterKey(video, video.poster_path);
        if (!old) throw new Error('invalid_poster_cleanup_target');
    } else if (video.has_poster || video.processing_job_id) {
        // Compatibility with a pre-upgrade in-flight PUT whose URL used the
        // legacy key, even when completion never set has_poster.
        old = legacyPosterKey(video.course_id, video.video_id);
    }
    if (old) await require('./deletionService').enqueueKey(old, {
        connection: db, source, execute_at: new Date(Date.now() + 2 * 60 * 1000),
    });
    await db.execute('UPDATE videos SET has_poster=0,poster_path=NULL WHERE video_id=?', [video.video_id]);
    return old;
}

async function preparePosterUpload(jobId, workerKeyId) {
    if (!isWorkerKeyId(workerKeyId)) return null;
    const result = await withCurrentJob(jobId, workerKeyId, async (db, video, job) => {
        if (!ACTIVE.has(job.status) || !ACTIVE_VIDEO.has(video.status)) return null;
        const key = jobPosterKey(video.course_id, video.video_id, jobId);
        if (video.poster_path !== key) {
            await resetPoster(db, video, 'poster_generation');
            await db.execute('UPDATE videos SET poster_path=? WHERE video_id=?', [key, video.video_id]);
        }
        return { videoId: video.video_id, key };
    });
    if (result) await videoCache.invalidate(result.videoId);
    return result;
}

async function confirmPosterReady(jobId, workerKeyId) {
    if (!isWorkerKeyId(workerKeyId)) return false;
    const result = await withCurrentJob(jobId, workerKeyId, async (db, video, job) => {
        if (job.status === 'completed') {
            return video.status === 'finished' && confirmedPosterKey(video) ? { videoId: video.video_id } : null;
        }
        if (!ACTIVE.has(job.status) || !ACTIVE_VIDEO.has(video.status)) return null;
        const key = jobPosterKey(video.course_id, video.video_id, jobId);
        if (video.poster_path !== key) return null;
        await db.execute('UPDATE videos SET has_poster=1 WHERE video_id=?', [video.video_id]);
        return { videoId: video.video_id };
    });
    // An invalidation failure remains retryable. The committed SQL update and
    // duplicate acknowledgement are idempotent, so a later retry repairs Redis.
    if (result) await videoCache.invalidate(result.videoId);
    return !!result;
}

module.exports = { ACTIVE, ACTIVE_VIDEO, withVideo, withCurrentJob, resetPoster, preparePosterUpload, confirmPosterReady };
