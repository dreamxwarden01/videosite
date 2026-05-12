// Periodic write-coalescing flusher.
//
// High-frequency Redis writes (session last_seen / ip / ua, plus watch and
// transcode progress in later phases) accumulate on dirty:* sets while the
// authoritative DB row stays untouched. This module drains those sets every
// FLUSH_INTERVAL_MS, applying batched UPDATEs.
//
// Flush is best-effort — failed UPDATEs leave the sid in the dirty set for
// the next cycle to retry. A small race exists where a request can re-mark
// a sid dirty between our HGETALL and SREM; the worst-case impact is one
// flush cycle of staleness for that field, which is fine for last_seen /
// ip / ua (display-only).

const { getClient } = require('./redis');
const { getPool } = require('../config/database');
const watchCache = require('./cache/watchProgressCache');
const transcodeCache = require('./cache/transcodeProgressCache');
const uploadHeartbeatCache = require('./cache/uploadHeartbeatCache');

const FLUSH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BATCH_SIZE = 500;

const DIRTY_SESSION_USER = 'dirty:session:user';
const SESSION_USER_KEY = (sid) => `session:user:${sid}`;
const DIRTY_SESSION_WORKER = 'dirty:session:worker';
const SESSION_WORKER_KEY = (token) => `session:worker:${token}`;

async function flushDirtyUserSessions() {
    const redis = getClient();
    const sids = await redis.smembers(DIRTY_SESSION_USER);
    if (sids.length === 0) return 0;

    const pool = getPool();
    let flushed = 0;

    for (let i = 0; i < sids.length; i += BATCH_SIZE) {
        const batch = sids.slice(i, i + BATCH_SIZE);
        for (const sid of batch) {
            try {
                const hash = await redis.hgetall(SESSION_USER_KEY(sid));
                if (!hash || !hash.last_seen) {
                    // Hash evicted or session deleted — nothing to flush.
                    await redis.srem(DIRTY_SESSION_USER, sid);
                    continue;
                }
                const lastSeen = new Date(parseInt(hash.last_seen, 10));
                await pool.execute(
                    'UPDATE sessions SET last_seen = ?, ip_address = ?, user_agent = ? WHERE session_id = ?',
                    [lastSeen, hash.ip_address || null, hash.user_agent || null, sid]
                );
                await redis.srem(DIRTY_SESSION_USER, sid);
                flushed++;
            } catch (err) {
                console.error(`Session flusher: failed for sid ${sid.slice(0, 8)}…: ${err.message}`);
                // Leave in dirty set for next cycle.
            }
        }
    }
    return flushed;
}

// Drain dirty:session:worker → UPDATE worker_sessions.last_seen. Worker
// session keys are bearer tokens; the cached hash holds session_id, which
// is the DB primary key. ip_address is set on session creation and never
// updated mid-session (any IP mismatch kills the session), so only
// last_seen is coalesced.
async function flushDirtyWorkerSessions() {
    const redis = getClient();
    const tokens = await redis.smembers(DIRTY_SESSION_WORKER);
    if (tokens.length === 0) return 0;

    const pool = getPool();
    let flushed = 0;

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        const batch = tokens.slice(i, i + BATCH_SIZE);
        for (const token of batch) {
            try {
                const hash = await redis.hgetall(SESSION_WORKER_KEY(token));
                if (!hash || !hash.last_seen || !hash.session_id) {
                    await redis.srem(DIRTY_SESSION_WORKER, token);
                    continue;
                }
                const lastSeen = new Date(parseInt(hash.last_seen, 10));
                await pool.execute(
                    'UPDATE worker_sessions SET last_seen = ? WHERE session_id = ?',
                    [lastSeen, hash.session_id]
                );
                await redis.srem(DIRTY_SESSION_WORKER, token);
                flushed++;
            } catch (err) {
                console.error(`Worker session flusher: failed for token ${token.slice(0, 8)}…: ${err.message}`);
                // Leave in dirty set for next cycle.
            }
        }
    }
    return flushed;
}

// Drain dirty:watch into watch_progress. The cached `delta` is added to the
// existing watch_seconds in a single UPSERT; last_position + last_watch_at
// are overwritten with the cache values. After a successful UPSERT we DEL
// the hash so the next /watch-progress starts a fresh delta accumulator.
async function flushDirtyWatch() {
    const redis = getClient();
    const members = await watchCache.getDirtyMembers();
    if (members.length === 0) return 0;

    const pool = getPool();
    let flushed = 0;

    for (let i = 0; i < members.length; i += BATCH_SIZE) {
        const batch = members.slice(i, i + BATCH_SIZE);
        for (const member of batch) {
            try {
                const [uidStr, vidStr] = member.split(':');
                const uid = parseInt(uidStr, 10);
                const vid = parseInt(vidStr, 10);
                if (!Number.isInteger(uid) || !Number.isInteger(vid)) {
                    await watchCache.removeDirty(member);
                    continue;
                }

                const data = await watchCache.readHash(uid, vid);
                if (!data) {
                    // Hash evicted or already cleared (e.g., video deleted).
                    await watchCache.removeDirty(member);
                    continue;
                }

                const lastWatchAt = new Date(data.updated_at);
                await pool.execute(
                    `INSERT INTO watch_progress (user_id, video_id, watch_seconds, last_position, last_watch_at)
                     VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        watch_seconds = watch_seconds + VALUES(watch_seconds),
                        last_position = VALUES(last_position),
                        last_watch_at = VALUES(last_watch_at)`,
                    [uid, vid, data.delta, data.last_position, lastWatchAt]
                );

                // Clear the hash + dirty marker. Subsequent /watch-progress starts
                // a fresh delta accumulator from 0.
                await watchCache.deleteEntry(uid, vid);
                flushed++;
            } catch (err) {
                console.error(`Watch flusher: failed for ${member}: ${err.message}`);
                // Leave in dirty set for next cycle.
            }
        }
    }
    return flushed;
}

// Drain dirty:transcode into processing_queue (only progress + last_heartbeat).
// Never overwrites terminal status (completed/error) — the WHERE guard makes
// the UPDATE a no-op for any row that's already finished. Hash + dirty marker
// stay until clearJob() is called from a terminal/abort/delete path; that
// way the admin overlay continues serving the live state until the job ends.
async function flushDirtyTranscode() {
    const redis = getClient();
    const jobIds = await transcodeCache.getDirtyMembers();
    if (jobIds.length === 0) return 0;

    const pool = getPool();
    let flushed = 0;

    for (let i = 0; i < jobIds.length; i += BATCH_SIZE) {
        const batch = jobIds.slice(i, i + BATCH_SIZE);
        for (const jobId of batch) {
            try {
                const data = await transcodeCache.readForFlush(jobId);
                if (!data) {
                    // Cache evicted or job cleared — nothing to flush.
                    await transcodeCache.removeDirty(jobId);
                    continue;
                }
                const lastHeartbeat = data.last_heartbeat ? new Date(data.last_heartbeat) : new Date();
                const setParts = ['last_heartbeat = ?'];
                const vals = [lastHeartbeat];
                if (data.progress !== null && data.progress !== undefined) {
                    setParts.push('progress = ?');
                    vals.push(data.progress);
                }
                vals.push(jobId);
                await pool.execute(
                    `UPDATE processing_queue SET ${setParts.join(', ')}
                     WHERE job_id = ? AND status NOT IN ('completed', 'error')`,
                    vals
                );
                await transcodeCache.removeDirty(jobId);
                flushed++;
            } catch (err) {
                console.error(`Transcode flusher: failed for ${jobId}: ${err.message}`);
                // Leave in dirty set for next cycle.
            }
        }
    }
    return flushed;
}

// Drain dirty:upload_heartbeat into upload_sessions.last_heartbeat.
// Upload heartbeats fire every 5 s per active upload; coalescing into
// Redis avoids hammering upload_sessions with per-tick UPDATEs. The
// stale-detection logic reads from Redis (the live source of truth), so
// the DB column only needs to be near-current for the cold-start sweep
// (resetStaleUploads) after a server restart.
//
// The Redis hash stays after flush (cache is still valid until terminal
// state); only the dirty marker is removed. Caller-driven `clearHeartbeat`
// on abort/complete is what evicts the hash.
async function flushDirtyUploadHeartbeats() {
    const ids = await uploadHeartbeatCache.getDirtyMembers();
    if (ids.length === 0) return 0;

    const pool = getPool();
    let flushed = 0;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        for (const uploadId of batch) {
            try {
                const data = await uploadHeartbeatCache.readForFlush(uploadId);
                if (!data) {
                    await uploadHeartbeatCache.removeDirty(uploadId);
                    continue;
                }
                const lastHeartbeat = new Date(data.last_heartbeat);
                await pool.execute(
                    `UPDATE upload_sessions SET last_heartbeat = ?
                     WHERE upload_id = ? AND status = 'active'`,
                    [lastHeartbeat, uploadId]
                );
                await uploadHeartbeatCache.removeDirty(uploadId);
                flushed++;
            } catch (err) {
                console.error(`Upload heartbeat flusher: failed for ${uploadId}: ${err.message}`);
                // Leave in dirty set for next cycle.
            }
        }
    }
    return flushed;
}

let intervalHandle = null;

function start() {
    if (intervalHandle) return;
    intervalHandle = setInterval(async () => {
        try {
            const sessionsN = await flushDirtyUserSessions();
            const workerSessionsN = await flushDirtyWorkerSessions();
            const watchN = await flushDirtyWatch();
            const transcodeN = await flushDirtyTranscode();
            const uploadHbN = await flushDirtyUploadHeartbeats();
            if (sessionsN > 0 || workerSessionsN > 0 || watchN > 0 || transcodeN > 0 || uploadHbN > 0) {
                console.log(`Flusher: drained ${sessionsN} user sessions, ${workerSessionsN} worker sessions, ${watchN} watch, ${transcodeN} transcode, ${uploadHbN} upload-hb to DB`);
            }
        } catch (err) {
            console.error('Flusher tick error:', err.message);
        }
    }, FLUSH_INTERVAL_MS);
    if (intervalHandle.unref) intervalHandle.unref();
}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

// Drain everything synchronously. Called on graceful shutdown so coalesced
// data lands in DB before exit. Loops a few times to catch late writes.
async function flushAll() {
    let total = 0;
    for (let i = 0; i < 5; i++) {
        const s = await flushDirtyUserSessions();
        const ws = await flushDirtyWorkerSessions();
        const w = await flushDirtyWatch();
        const t = await flushDirtyTranscode();
        const u = await flushDirtyUploadHeartbeats();
        total += s + ws + w + t + u;
        if (s === 0 && ws === 0 && w === 0 && t === 0 && u === 0) break;
    }
    return total;
}

module.exports = {
    start, stop, flushAll,
    flushDirtyUserSessions, flushDirtyWorkerSessions,
    flushDirtyWatch, flushDirtyTranscode,
    flushDirtyUploadHeartbeats,
};
