#!/usr/bin/env node
// Re-queue orphaned watch-progress cache entries for flushing.
//
// The flusher parsed the cached user_id with parseInt(), which stopped being
// correct when user_id became a 32-char hex UUID at the identity migration.
// '019ef1…' parsed to 19, still passed the integer guard, so the flusher read a
// key that never existed, read the miss as "already cleared", and removed the
// dirty marker WITHOUT writing. The accumulated hashes were left behind with
// nothing pointing at them.
//
// Fixing the flusher stops the bleeding but does not reattach what was already
// orphaned: an entry is only re-marked dirty when that user watches that video
// again. This walks progress:watch:* and puts every entry holding real progress
// back on the dirty set so the next flush writes it.
//
// Safe to run repeatedly: adding to a set is idempotent, and the flusher deletes
// each hash once it has been written. Nothing is destroyed here — worst case an
// already-clean entry gets flushed again as a no-op delta of 0 (skipped below).
//
// Run inside the app (needs its env + Redis):
//   docker exec -i <container> node scripts/recover-watch-progress.js [--apply]
// Without --apply it only reports.

const { connect, getClient } = require('../services/redis');

const APPLY = process.argv.includes('--apply');
const DIRTY = 'dirty:watch';

(async () => {
    await connect();
    const redis = getClient();
    const prefix = redis.options.keyPrefix || '';

    // SCAN rather than KEYS — this may run against a live production Redis.
    const found = [];
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}progress:watch:*`, 'COUNT', 500);
        cursor = next;
        found.push(...keys);
    } while (cursor !== '0');

    const already = new Set(await redis.smembers(DIRTY));
    let requeued = 0, skippedEmpty = 0, alreadyDirty = 0;

    for (const fullKey of found) {
        // ioredis applies keyPrefix to commands, so strip it before reusing the key.
        const k = prefix && fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
        const member = k.replace(/^progress:watch:/, ''); // "{uid}:{vid}"
        const hash = await redis.hgetall(k);
        const delta = parseFloat(hash?.delta || '0');
        if (!hash || !Number.isFinite(delta) || delta <= 0) { skippedEmpty++; continue; }
        if (already.has(member)) { alreadyDirty++; continue; }
        if (APPLY) await redis.sadd(DIRTY, member);
        requeued++;
        console.log(`  ${APPLY ? 're-queued' : 'would re-queue'}  ${member}  (+${delta.toFixed(1)}s)`);
    }

    console.log(`\nprogress entries found : ${found.length}`);
    console.log(`already queued         : ${alreadyDirty}`);
    console.log(`nothing to write       : ${skippedEmpty}`);
    console.log(`${APPLY ? 're-queued' : 'WOULD re-queue'}             : ${requeued}`);
    if (!APPLY && requeued > 0) console.log('\nre-run with --apply to queue them.');
    if (APPLY && requeued > 0) console.log('\nThe next flush (<=15 min, or on graceful shutdown) writes them to watch_progress.');

    redis.disconnect();
})().catch((e) => { console.error('recover failed:', e.message); process.exit(1); });
