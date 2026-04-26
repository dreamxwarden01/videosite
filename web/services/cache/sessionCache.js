// User session hot-path cache.
//
// Layout:
//   session:user:{sid}       hash  {user_id, last_sign_in, last_seen, ip_address, user_agent}
//   user:sessions:{user_id}  set   member = sid (one entry per active session)
//   dirty:session:user       set   member = sid (drained by Phase 5 flusher)
//
// The DB `sessions` table stays as the audit / admin-view backing store.
// Writes that change session lifecycle (create / delete / terminate) hit
// both stores immediately; per-request `last_seen` updates only land in
// Redis until the periodic flusher picks them up.
//
// Idle timeout is enforced by Redis TTL (sliding) rather than an explicit
// check — refreshing the TTL on each request keeps the session alive, and
// natural expiry handles abandoned sessions. Absolute TTL (max_days) still
// requires an explicit `last_sign_in` check on the caller side.

const { getClient } = require('../redis');

const sessionKey = (sid) => `session:user:${sid}`;
const userIndexKey = (uid) => `user:sessions:${uid}`;
const DIRTY_SET = 'dirty:session:user';

// Convert a Date or epoch-ms-or-iso to a numeric epoch ms string for storage.
function toEpochMs(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return String(value.getTime());
    if (typeof value === 'number') return String(value);
    return String(new Date(value).getTime());
}

// Parse a stored hash back into a usable object. Empty fields → null.
function parseHash(hash) {
    if (!hash || Object.keys(hash).length === 0) return null;
    return {
        user_id: hash.user_id ? parseInt(hash.user_id, 10) : null,
        last_sign_in: hash.last_sign_in ? parseInt(hash.last_sign_in, 10) : null,
        last_seen: hash.last_seen ? parseInt(hash.last_seen, 10) : null,
        ip_address: hash.ip_address || null,
        user_agent: hash.user_agent || null,
    };
}

// Create a Redis-side session record. Caller is responsible for the DB INSERT
// (which already happens in createSession). ttlSeconds = idle timeout.
async function createSession(sid, { userId, lastSignIn, lastSeen, ipAddress, userAgent }, ttlSeconds) {
    const redis = getClient();
    const fields = {
        user_id: String(userId),
        last_sign_in: toEpochMs(lastSignIn),
        last_seen: toEpochMs(lastSeen),
        ip_address: ipAddress || '',
        user_agent: userAgent || '',
    };
    await redis.multi()
        .hset(sessionKey(sid), fields)
        .expire(sessionKey(sid), ttlSeconds)
        .sadd(userIndexKey(userId), sid)
        .exec();
}

// Fetch the cached session. Returns null on miss or empty key.
async function getSession(sid) {
    const hash = await getClient().hgetall(sessionKey(sid));
    return parseHash(hash);
}

// Update last_seen / ip / ua on each request and refresh the sliding TTL.
// Marks the sid dirty so Phase 5's flusher picks up the DB write.
async function updateActivity(sid, { lastSeen, ipAddress, userAgent }, ttlSeconds) {
    const redis = getClient();
    const fields = { last_seen: toEpochMs(lastSeen) };
    if (ipAddress !== undefined) fields.ip_address = ipAddress || '';
    if (userAgent !== undefined) fields.user_agent = userAgent || '';
    await redis.multi()
        .hset(sessionKey(sid), fields)
        .expire(sessionKey(sid), ttlSeconds)
        .sadd(DIRTY_SET, sid)
        .exec();
}

// Clear a single session from Redis. Caller is responsible for the DB DELETE.
async function deleteSession(sid, userId) {
    const redis = getClient();
    const tx = redis.multi();
    tx.del(sessionKey(sid));
    tx.srem(DIRTY_SET, sid);
    if (userId) tx.srem(userIndexKey(userId), sid);
    await tx.exec();
}

// Cascade-clear: yank all of a user's sessions plus their meta/perms caches.
// Used on deactivation, password change by admin, and "log out everywhere".
// Returns the list of sids that were cleared so the caller can DELETE the
// matching DB rows (or infer "delete all WHERE user_id = ?").
async function deleteAllForUser(userId) {
    const redis = getClient();
    const sids = await redis.smembers(userIndexKey(userId));
    const tx = redis.multi();
    for (const sid of sids) {
        tx.del(sessionKey(sid));
        tx.srem(DIRTY_SET, sid);
    }
    tx.del(userIndexKey(userId));
    tx.del(`user:meta:${userId}`);
    tx.del(`user:perms:${userId}`);
    await tx.exec();
    return sids;
}

// Variant that excludes one sid (used by "log out other sessions").
async function deleteAllForUserExcept(userId, exceptSid) {
    const redis = getClient();
    const sids = (await redis.smembers(userIndexKey(userId))).filter(s => s !== exceptSid);
    if (sids.length === 0) return [];
    const tx = redis.multi();
    for (const sid of sids) {
        tx.del(sessionKey(sid));
        tx.srem(DIRTY_SET, sid);
        tx.srem(userIndexKey(userId), sid);
    }
    await tx.exec();
    return sids;
}

// Look up all sids for a user (for the admin "view sessions" overlay).
async function getUserSids(userId) {
    return getClient().smembers(userIndexKey(userId));
}

// Pull the current Redis-side state for a list of sids, so the admin /
// profile session view can overlay live values (last_seen, ip, ua) on top
// of the DB rows.
async function getMany(sids) {
    if (!sids || sids.length === 0) return {};
    const redis = getClient();
    const tx = redis.multi();
    for (const sid of sids) tx.hgetall(sessionKey(sid));
    const results = await tx.exec();
    const out = {};
    for (let i = 0; i < sids.length; i++) {
        const [, hash] = results[i] || [];
        const parsed = parseHash(hash);
        if (parsed) out[sids[i]] = parsed;
    }
    return out;
}

module.exports = {
    createSession,
    getSession,
    updateActivity,
    deleteSession,
    deleteAllForUser,
    deleteAllForUserExcept,
    getUserSids,
    getMany,
};
