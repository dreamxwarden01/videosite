// Transcoding-progress cache.
//
// Per the user's spec, only in-progress heartbeats are coalesced; lease /
// error / abort / complete go to DB immediately. The cache acts as both:
//   1. The fast write path for /api/worker/task/status running heartbeats
//      (every ~2s per active job).
//   2. The "is this job still alive?" gate — populated on lease, cleared on
//      any terminal/abort/delete. The worker's status callback uses the
//      cache's existence as the ack signal: missing → ack=false → drop job.
//
// Layout:
//   progress:transcode:{job_id}  hash {queue_status, video_status, progress, stage, last_heartbeat}
//   dirty:transcode              set member = job_id

const { getClient } = require('../redis');

const DIRTY = 'dirty:transcode';
const key = (jobId) => `progress:transcode:${jobId}`;

// Populate cache when a job is leased (creates the existence marker so
// subsequent heartbeats find the job alive without a DB query).
// hashed_video_id is stored here so generateUploadUrls can build R2 paths
// without re-fetching the videos JOIN on every upload-URL batch.
async function initOnLease(jobId, videoId, hashedVideoId, queueStatus, videoStatus) {
    const redis = getClient();
    await redis.hset(key(jobId), {
        video_id: String(videoId),
        hashed_video_id: hashedVideoId || '',
        queue_status: queueStatus,
        video_status: videoStatus,
        progress: '0',
        stage: 'downloading',
        last_heartbeat: String(Date.now()),
    });
}

// Heartbeat update: returns true if the cache entry exists (job is alive),
// false if it was cleared (terminal / aborted / video deleted).
async function recordHeartbeat(jobId, queueStatus, videoStatus, progress, stage) {
    const redis = getClient();
    const exists = await redis.exists(key(jobId));
    if (!exists) return false;

    const fields = {
        queue_status: queueStatus,
        video_status: videoStatus,
        last_heartbeat: String(Date.now()),
    };
    if (progress !== null && progress !== undefined) fields.progress = String(progress);
    if (stage) fields.stage = stage;

    await redis.multi()
        .hset(key(jobId), fields)
        .sadd(DIRTY, jobId)
        .exec();
    return true;
}

// Read cached state for an admin overlay.
async function getProgress(jobId) {
    const hash = await getClient().hgetall(key(jobId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return {
        video_id: hash.video_id ? parseInt(hash.video_id, 10) : null,
        hashed_video_id: hash.hashed_video_id || null,
        queue_status: hash.queue_status || null,
        video_status: hash.video_status || null,
        progress: hash.progress !== undefined ? parseInt(hash.progress, 10) : null,
        stage: hash.stage || null,
        last_heartbeat: hash.last_heartbeat ? parseInt(hash.last_heartbeat, 10) : null,
    };
}

// Bulk read for the admin transcoding-jobs page.
async function getMany(jobIds) {
    if (!jobIds || jobIds.length === 0) return {};
    const redis = getClient();
    const tx = redis.multi();
    for (const id of jobIds) tx.hgetall(key(id));
    const results = await tx.exec();
    const out = {};
    for (let i = 0; i < jobIds.length; i++) {
        const [, hash] = results[i] || [];
        if (!hash || Object.keys(hash).length === 0) continue;
        out[jobIds[i]] = {
            video_id: hash.video_id ? parseInt(hash.video_id, 10) : null,
            queue_status: hash.queue_status || null,
            video_status: hash.video_status || null,
            progress: hash.progress !== undefined ? parseInt(hash.progress, 10) : null,
            stage: hash.stage || null,
            last_heartbeat: hash.last_heartbeat ? parseInt(hash.last_heartbeat, 10) : null,
        };
    }
    return out;
}

// Read+remove pair for the flusher. Returns the data + atomically clears
// the dirty marker (the hash itself stays so the admin overlay still works
// while the job is in flight).
async function readForFlush(jobId) {
    const hash = await getClient().hgetall(key(jobId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return {
        progress: hash.progress !== undefined ? parseInt(hash.progress, 10) : null,
        last_heartbeat: hash.last_heartbeat ? parseInt(hash.last_heartbeat, 10) : null,
    };
}

async function getDirtyMembers() {
    return getClient().smembers(DIRTY);
}

async function removeDirty(jobId) {
    await getClient().srem(DIRTY, jobId);
}

// Terminal states (complete / error / abort) and admin deletes drop both
// the hash and the dirty marker so subsequent heartbeats see "not alive".
async function clearJob(jobId) {
    const redis = getClient();
    await redis.multi()
        .del(key(jobId))
        .srem(DIRTY, jobId)
        .exec();
}

async function clearJobs(jobIds) {
    if (!jobIds || jobIds.length === 0) return;
    for (const id of jobIds) await clearJob(id);
}

// Apply live in-flight progress to a list of DB video rows. Mutates each
// row's `status` and `processing_progress` from the cached values when an
// active job is in flight. Returns the same array for chaining.
//
// Used by the user / admin video-list endpoints — Phase 6 stopped writing
// `videos.status` and `videos.processing_progress` per heartbeat (only the
// initial 'worker_downloading' from leaseTask + the terminal states make
// it to DB), so without this overlay the list shows "worker downloading 0%"
// for the entire transcoding run.
async function applyLiveOverlayToVideos(videoRows) {
    if (!videoRows || videoRows.length === 0) return videoRows;
    const jobIds = videoRows
        .filter(v => v.processing_job_id && v.status !== 'finished' && v.status !== 'error')
        .map(v => v.processing_job_id);
    if (jobIds.length === 0) return videoRows;

    const live = await getMany(jobIds);
    for (const v of videoRows) {
        if (!v.processing_job_id) continue;
        const overlay = live[v.processing_job_id];
        if (!overlay) continue;
        if (overlay.video_status) v.status = overlay.video_status;
        if (overlay.progress !== null && overlay.progress !== undefined) {
            v.processing_progress = overlay.progress;
        }
    }
    return videoRows;
}

module.exports = {
    initOnLease,
    recordHeartbeat,
    getProgress,
    getMany,
    readForFlush,
    getDirtyMembers,
    removeDirty,
    clearJob,
    clearJobs,
    applyLiveOverlayToVideos,
};
