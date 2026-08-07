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

const { getClient, scanKeys } = require('../redis');

const DIRTY = 'dirty:watch';
const key = (uid, vid) => `progress:watch:${uid}:${vid}`;
const memberId = (uid, vid) => `${uid}:${vid}`;
// "progress:watch:{uid}:{vid}" -> "{uid}:{vid}". Taken from the END of the key so
// it cannot be thrown off by extra leading segments (a key prefix, say).
const memberFromKey = (k) => k.split(':').slice(-2).join(':');
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

// Settle exactly what the flusher just wrote, INSTEAD of deleting the hash.
//
// deleteEntry() blew away the whole entry, so a /watch-progress landing between
// the flusher's read and its cleanup — it HINCRBYFLOATs onto `delta` — was
// discarded without ever reaching the DB. Subtracting only the written amount
// leaves any concurrent remainder intact. Nothing left (allowing for float dust)
// means the entry is removed and the dirty marker cleared; a remainder stays
// dirty for the next cycle.
//
// Note: if this call fails AFTER the DB write committed, the next cycle re-reads
// the same delta and counts it twice. Two systems, no shared transaction — but
// over-counting on a rare Redis failure beats silently losing watch time on every
// concurrent report, which is what deleting did.
async function settleDelta(uid, vid, written) {
    const redis = getClient();
    const k = key(uid, vid);
    const remaining = parseFloat(await redis.hincrbyfloat(k, 'delta', -written));
    if (!Number.isFinite(remaining) || remaining <= 0.001) {
        await redis.multi().del(k).srem(DIRTY, memberId(uid, vid)).exec();
        return 0;
    }
    return remaining;
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
    // scanKeys handles the key prefix on both ends and returns UN-prefixed keys;
    // a bare redis.scan() here matched nothing, so this purge silently did nothing.
    const toDelete = await scanKeys(`progress:watch:*:${videoId}`);
    if (toDelete.length === 0) return;

    // Also drop the matching dirty members so the flusher doesn't try to
    // UPSERT a row that's about to be cascade-deleted.
    const dirtyMembers = toDelete.map(memberFromKey);
    const tx = redis.multi();
    tx.del(...toDelete);
    tx.srem(DIRTY, ...dirtyMembers);
    await tx.exec();
}

async function clearForVideos(videoIds) {
    for (const vid of videoIds) await clearForVideo(vid);
}

// Scan + delete every cached entry for a given user (all videos). Used by the
// admin per-user playback-stats reset. userId is the canonical lower-hex sub
// (the exact form used in the key, since recordProgress keys on user.user_id).
async function clearForUser(userId) {
    const redis = getClient();
    const toDelete = await scanKeys(`progress:watch:${userId}:*`);
    if (toDelete.length === 0) return;
    const dirtyMembers = toDelete.map(memberFromKey);
    const tx = redis.multi();
    tx.del(...toDelete);
    tx.srem(DIRTY, ...dirtyMembers);
    await tx.exec();
}

// Delete this user's cached entries for a specific set of videos (the per-user,
// per-course reset). Direct key hits — no scan needed.
async function clearForUserVideos(userId, videoIds) {
    if (!videoIds || videoIds.length === 0) return;
    const redis = getClient();
    const keys = videoIds.map(v => key(userId, v));
    const members = videoIds.map(v => memberId(userId, v));
    const tx = redis.multi();
    tx.del(...keys);
    tx.srem(DIRTY, ...members);
    await tx.exec();
}

// Wipe everything. For admin "clear all playback stats".
async function clearAll() {
    const redis = getClient();
    const keys = await scanKeys('progress:watch:*');
    for (let i = 0; i < keys.length; i += 500) {
        const batch = keys.slice(i, i + 500);
        if (batch.length) await redis.del(...batch);
    }
    await redis.del(DIRTY);
}

module.exports = {
    recordProgress,
    applyRateLimit,
    getLastPosition,
    readHash,
    deleteEntry,
    settleDelta,
    getDirtyMembers,
    getAllPending,
    removeDirty,
    clearForVideo,
    clearForVideos,
    clearForUser,
    clearForUserVideos,
    clearAll,
};
