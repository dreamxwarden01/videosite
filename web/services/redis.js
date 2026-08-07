// Redis client wrapper. Single shared connection, lazy-connect, fail-fast at boot.
//
// Required server config (set in redis.conf, not by the client):
//   maxmemory 8gb                 — capacity bound (already set by operator)
//   maxmemory-policy volatile-lru — only evict keys with TTL; protects dirty
//                                   progress hashes and dirty:* sets from
//                                   eviction even under memory pressure
//   appendonly yes                — AOF persistence so dirty data survives
//   appendfsync everysec          — ~1s worst-case loss on crash
//
// At boot we run sanity checks against the server's reported config and warn
// loudly if these don't match expectations — but we don't fail the boot,
// because some hosts disable CONFIG and operators may have valid reasons to
// deviate.

const Redis = require('ioredis');

let client = null;

function buildOptions() {
    return {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        db: parseInt(process.env.REDIS_DB || '0'),
        // Project-level key prefix. ioredis prepends this to every declared KEY
        // argument (writes, reads, MULTI) so the per-cache `key()` factories stay
        // un-prefixed in code and we get
        // a clean namespace at the wire level. Costs ~10 bytes per key in
        // RAM, buys collision-safety when an operator points another app
        // (SSO, email queue, dev script) at the same Redis instance.
        // Override via env if you ever want to disable (empty string) or
        // pick a different namespace per deployment.
        keyPrefix: process.env.REDIS_KEY_PREFIX !== undefined
            ? process.env.REDIS_KEY_PREFIX
            : 'videosite:',
        // Lazy-connect so requiring this module is a no-op until connect()
        // is explicitly called (lets the install flow boot without Redis).
        lazyConnect: true,
        // Don't queue commands while disconnected — surface errors immediately
        // so callers can decide whether to fall through to DB.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            if (times > 10) return null;
            return Math.min(times * 200, 2000);
        },
    };
}

// Connect, PING to verify, and run server-config sanity checks. Throws on
// connect/PING failure — callers should treat that as fatal at boot.
async function connect() {
    if (client) return client;

    const opts = buildOptions();
    client = new Redis(opts);

    client.on('error', (err) => {
        console.error('Redis client error:', err.message);
    });

    await client.connect();
    await client.ping();

    // Sanity-check server config; warn if not as expected.
    try {
        const [, policy] = await client.config('GET', 'maxmemory-policy');
        if (policy && policy !== 'volatile-lru') {
            console.warn(`Redis: maxmemory-policy is "${policy}", expected "volatile-lru" — dirty progress could be evicted under memory pressure.`);
        }
        const [, aof] = await client.config('GET', 'appendonly');
        if (aof && aof !== 'yes') {
            console.warn(`Redis: appendonly is "${aof}", expected "yes" — dirty progress is not persisted between flushes; a crash could lose up to 15min of writes.`);
        }
    } catch (err) {
        // Some managed Redis hosts block CONFIG; not a fatal error.
        console.warn('Redis: could not verify server config (CONFIG may be disabled):', err.message);
    }

    console.log(`Redis connected to ${opts.host}:${opts.port} (db=${opts.db}, prefix="${opts.keyPrefix}").`);
    return client;
}

// Connectivity test for the install flow — connects to a candidate host
// without retaining a global client. Returns true on success, throws on failure.
async function testConnection({ host, port, password, db }) {
    const probe = new Redis({
        host: host || 'localhost',
        port: parseInt(port || '6379'),
        password: password || undefined,
        db: parseInt(db || '0'),
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // no retry on probe — fail fast
    });
    try {
        await probe.connect();
        await probe.ping();
        return true;
    } finally {
        try { await probe.quit(); } catch (_) { /* ignore */ }
    }
}

async function quit() {
    if (!client) return;
    try {
        await client.quit();
    } catch (err) {
        console.error('Redis quit error:', err.message);
    }
    client = null;
}

function getClient() {
    if (!client) {
        throw new Error('Redis not connected. Call connect() first.');
    }
    return client;
}

// SCAN with the key prefix handled on BOTH ends — always use this, never a bare
// redis.scan().
//
// ioredis prefixes declared KEY arguments, but a SCAN's MATCH is just a string
// argument to it, so a pattern written the way the rest of the code writes keys
// silently matches NOTHING. That is not hypothetical: every SCAN-based purge in
// this codebase was a no-op, which let deleted watch_progress rows be resurrected
// by the next flush and left invalidateAllRoles doing nothing at boot.
//
// The replies come back FULLY prefixed, which then get prefixed AGAIN if handed
// to DEL — so this strips the prefix and returns keys in the same un-prefixed
// space every other function here works in.
async function scanKeys(pattern, count = 500) {
    const redis = getClient();
    const prefix = redis.options.keyPrefix || '';
    const out = [];
    let cursor = '0';
    do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', prefix + pattern, 'COUNT', count);
        cursor = next;
        for (const k of batch) out.push(prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k);
    } while (cursor !== '0');
    return out;
}

module.exports = { connect, quit, getClient, testConnection, scanKeys };
