// Upload session heartbeat cache.
//
// Heartbeats fire every 5 s per active upload (client side) — coalescing
// the high-frequency writes into Redis and flushing to DB periodically
// avoids hammering `upload_sessions.last_heartbeat` with 1 UPDATE per
// session per 5 s.
//
// State transitions (create / abort / complete) go straight to DB and
// invalidate this cache via clearHeartbeat. Stale detection reads Redis
// first (source of truth for the live last_heartbeat); DB lags by up to
// one flush cycle and isn't reliable for the staleness check.
//
// Cache layout:
//   heartbeat:upload:{uploadId}  hash {user_id, type, last_heartbeat}
//   dirty:upload_heartbeat       set member = uploadId
//
// The hash is seeded by `init` at upload creation, refreshed by
// `recordHeartbeat`, read by `getLastHeartbeat` / `readForFlush`, and
// cleared by `clearHeartbeat` on terminal state. The `user_id` field is
// the ownership gate for `recordHeartbeat` (we don't trust the request's
// uploadId alone).

const { getClient } = require('../redis');

const DIRTY = 'dirty:upload_heartbeat';
const key = (uploadId) => `heartbeat:upload:${uploadId}`;
// 24 h TTL is a safety net for the case where a row gets cascade-deleted
// from upload_sessions without going through markCompleted/markAborted
// (e.g. `courseService.deleteCourse` removing the course). Normal
// terminal transitions go through `clearHeartbeat` and don't rely on
// the TTL.
const CACHE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Pre-cache session metadata at create time so subsequent heartbeats
 * never have to touch the DB. Called from `uploadSessionService.createSession`.
 */
async function init(uploadId, { userId, type }) {
    const redis = getClient();
    const k = key(uploadId);
    await redis.multi()
        .hset(k, {
            user_id: String(userId),
            type: String(type),
            last_heartbeat: String(Date.now()),
        })
        .expire(k, CACHE_TTL_SECONDS)
        .exec();
}

/**
 * Record one heartbeat. Returns true if accepted (session cached + owner
 * matches), false otherwise. A false return means the client should stop
 * heartbeating (session is terminal or never existed).
 */
async function recordHeartbeat(uploadId, userId) {
    const redis = getClient();
    const k = key(uploadId);
    const cached = await redis.hgetall(k);
    if (!cached || !cached.user_id) return false;
    if (parseInt(cached.user_id, 10) !== userId) return false;
    await redis.multi()
        .hset(k, 'last_heartbeat', String(Date.now()))
        .expire(k, CACHE_TTL_SECONDS)
        .sadd(DIRTY, uploadId)
        .exec();
    return true;
}

/**
 * Read last heartbeat (ms timestamp). Returns null on cache miss — caller
 * should fall back to DB.last_heartbeat.
 */
async function getLastHeartbeat(uploadId) {
    const v = await getClient().hget(key(uploadId), 'last_heartbeat');
    if (!v) return null;
    const ts = parseInt(v, 10);
    return Number.isFinite(ts) ? ts : null;
}

/**
 * Read cached session type. Returns null on miss.
 */
async function getType(uploadId) {
    const v = await getClient().hget(key(uploadId), 'type');
    return v || null;
}

/**
 * Clear cached state. Called from markCompleting / markCompleted /
 * markAborted (terminal transitions).
 */
async function clearHeartbeat(uploadId) {
    const redis = getClient();
    await redis.multi()
        .del(key(uploadId))
        .srem(DIRTY, uploadId)
        .exec();
}

async function getDirtyMembers() {
    return getClient().smembers(DIRTY);
}

async function removeDirty(uploadId) {
    await getClient().srem(DIRTY, uploadId);
}

/**
 * Read the full hash for the flusher. Returns `{ last_heartbeat }` or null
 * if evicted / cleared between dirty-set membership and read.
 */
async function readForFlush(uploadId) {
    const hash = await getClient().hgetall(key(uploadId));
    if (!hash || !hash.last_heartbeat) return null;
    return { last_heartbeat: parseInt(hash.last_heartbeat, 10) };
}

module.exports = {
    init,
    recordHeartbeat,
    getLastHeartbeat,
    getType,
    clearHeartbeat,
    getDirtyMembers,
    removeDirty,
    readForFlush,
};
