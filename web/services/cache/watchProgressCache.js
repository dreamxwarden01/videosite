// Watch progress write-coalescing cache.
//
// The cache stores a delta accumulator + the latest position per (user, video).
// /api/watch-progress HINCRBYFLOATs the delta and HSETs the position; the periodic
// flusher (services/flusher.js) drains dirty:watch every 15 min, applies the
// accumulated delta to watch_progress.watch_seconds, and overwrites
// last_position + last_watch_at.
//
// Cache layout:
//   progress:watch:{user_id}:{video_id}  hash {delta, last_position, updated_at}
//   dirty:watch                          set member = "{user_id}:{video_id}"
//
// We accumulate `delta` (not the absolute watch_seconds) so we never have to
// know the current DB value to serve a /watch-progress — the flusher's UPSERT
// adds the delta to the existing row's watch_seconds in a single SQL.
//
// Resume reads (playback start, watch page) check this cache first for the
// freshest last_position, then fall through to watch_progress on miss.

const { getClient } = require('../redis');

const DIRTY = 'dirty:watch';
const key = (uid, vid) => `progress:watch:${uid}:${vid}`;
const memberId = (uid, vid) => `${uid}:${vid}`;
const rateLimitKey = (uid, vid) => `ratelimit:watch:${uid}:${vid}`;
const RATE_LIMIT_TTL = 120;       // seconds — anchor expires after 2 min of no accepted reports
const RATE_LIMIT_TOLERANCE_MS = 2000; // covers clock drift / network jitter / GC pauses

// Anti-cheat: anchor on the wall-clock time of the last *accepted* report.
// Reject (drop credit to 0) when claimed watch_seconds since the anchor
// exceed real elapsed time by more than RATE_LIMIT_TOLERANCE_MS.
//
// Important rules:
//   - Stored in milliseconds. Whole-second timestamps would lose ~1s of
//     precision per pair of reports just from floor() rounding, eating
//     into our tolerance budget for free.
//   - A miss (first report, or 120s gap = TTL expired) is always accepted
//     and anchors. The upstream `delta > 60` cap bounds what a fresh anchor
//     can grant.
//   - On rejection we DO NOT refresh the anchor — subsequent reports
//     compare against the last legitimate baseline, not the rejection. This
//     also keeps two parallel clients of the same user from trampling each
//     other's anchors and starving both into permanent rejection.
//   - Rate-limit data stays in Redis only; the flusher never touches it.
async function applyRateLimit(userId, videoId, credit) {
    const redis = getClient();
    const k = rateLimitKey(userId, videoId);
    const nowMs = Date.now();

    const prev = await redis.get(k);
    if (prev === null) {
        await redis.set(k, String(nowMs), 'EX', RATE_LIMIT_TTL);
        return credit;
    }

    const lastAccumulatedMs = parseInt(prev, 10);
    if (!Number.isFinite(lastAccumulatedMs)) {
        await redis.set(k, String(nowMs), 'EX', RATE_LIMIT_TTL);
        return credit;
    }

    const elapsedMs = nowMs - lastAccumulatedMs;
    const claimedMs = credit * 1000;
    if (claimedMs > elapsedMs + RATE_LIMIT_TOLERANCE_MS) {
        return 0;
    }

    await redis.set(k, String(nowMs), 'EX', RATE_LIMIT_TTL);
    return credit;
}

// Record one /watch-progress tick. credit may be 0 (position-only refresh).
async function recordProgress(userId, videoId, position, credit) {
    const redis = getClient();
    const k = key(userId, videoId);
    await redis.multi()
        .hincrbyfloat(k, 'delta', credit)
        .hset(k, 'last_position', position, 'updated_at', String(Date.now()))
        .sadd(DIRTY, memberId(userId, videoId))
        .exec();
}

// Get the freshest last_position from cache. Returns null on miss; callers
// fall back to watch_progress.last_position from DB.
async function getLastPosition(userId, videoId) {
    const v = await getClient().hget(key(userId, videoId), 'last_position');
    if (v === null || v === undefined) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

// Read the full hash for the flusher.
async function readHash(uid, vid) {
    const hash = await getClient().hgetall(key(uid, vid));
    if (!hash || Object.keys(hash).length === 0) return null;
    return {
        delta: parseFloat(hash.delta || '0'),
        last_position: parseFloat(hash.last_position || '0'),
        updated_at: hash.updated_at ? parseInt(hash.updated_at, 10) : Date.now(),
    };
}

async function deleteEntry(uid, vid) {
    const redis = getClient();
    await redis.multi()
        .del(key(uid, vid))
        .srem(DIRTY, memberId(uid, vid))
        .exec();
}

async function getDirtyMembers() {
    return getClient().smembers(DIRTY);
}

// Read every dirty entry's hash in one batch. Returns
// Map<"uid:vid", {delta, last_position, updated_at}>. Empty entries (evicted
// or already cleared) are skipped. Used by the admin playback-stats overlay.
async function getAllPending() {
    const redis = getClient();
    const members = await redis.smembers(DIRTY);
    if (members.length === 0) return {};

    const tx = redis.multi();
    for (const m of members) {
        const [u, v] = m.split(':');
        tx.hgetall(`progress:watch:${u}:${v}`);
    }
    const results = await tx.exec();

    const out = {};
    for (let i = 0; i < members.length; i++) {
        const [, hash] = results[i] || [];
        if (!hash || Object.keys(hash).length === 0) continue;
        out[members[i]] = {
            delta: parseFloat(hash.delta || '0'),
            last_position: parseFloat(hash.last_position || '0'),
            updated_at: hash.updated_at ? parseInt(hash.updated_at, 10) : Date.now(),
        };
    }
    return out;
}

async function removeDirty(member) {
    await getClient().srem(DIRTY, member);
}

// Scan + delete every cached entry for a given video. Used by the replace /
// delete-video / delete-course flows so a re-uploaded source doesn't resume
// at the old video's position.
async function clearForVideo(videoId) {
    const redis = getClient();
    const pattern = `progress:watch:*:${videoId}`;
    let cursor = '0';
    const toDelete = [];
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        toDelete.push(...batch);
    } while (cursor !== '0');

    if (toDelete.length === 0) return;

    // Also drop the matching dirty members so the flusher doesn't try to
    // UPSERT a row that's about to be cascade-deleted.
    const dirtyMembers = toDelete.map(k => {
        const parts = k.split(':');
        return `${parts[2]}:${parts[3]}`;
    });
    const tx = redis.multi();
    tx.del(...toDelete);
    tx.srem(DIRTY, ...dirtyMembers);
    await tx.exec();
}

async function clearForVideos(videoIds) {
    for (const vid of videoIds) await clearForVideo(vid);
}

// Wipe everything. For admin "clear all playback stats".
async function clearAll() {
    const redis = getClient();
    let cursor = '0';
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', 'progress:watch:*', 'COUNT', 500);
        cursor = next;
        if (batch.length > 0) await redis.del(...batch);
    } while (cursor !== '0');
    await redis.del(DIRTY);
}

module.exports = {
    recordProgress,
    applyRateLimit,
    getLastPosition,
    readHash,
    deleteEntry,
    getDirtyMembers,
    getAllPending,
    removeDirty,
    clearForVideo,
    clearForVideos,
    clearAll,
};
