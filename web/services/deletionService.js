// Deletion queue: durable, retryable R2 object deletion.
//
// Replaces the scattered fire-and-forget `cleanR2Prefix.catch(log)` calls
// across course/video/material/processing services with a single mechanism:
//
//   - enqueueKey(key, opts)       — defer a single-object delete
//   - enqueuePrefix(prefix, opts) — defer a list+batch-delete sweep
//   - hasPendingForHash(hash)     — collision check used by video hash gen
//   - runReaper()                 — drain one turn; called on boot + 60s tick
//
// Reaper semantics (see plan §2):
//   - Serial across rows. Picks one row per iteration:
//       SELECT … WHERE execute_at <= NOW() ORDER BY execute_at LIMIT 1
//   - Up to 5 attempts per row per turn with backoff [0, 250, 500, 1000, 2000] ms.
//   - Empty ListObjectsV2 result = success (idempotent retry-safe).
//   - 4xx errors (incl. 404) are terminal — counted as success, not retried.
//   - On success: hard-delete the row.
//   - On all 5 attempts failing: persist attempts += 5, last_error,
//     last_attempt_at; abort the turn (R2 presumed unhealthy, don't waste
//     effort on the rest of the queue).
//   - Next turn picks up where this turn left off.

const { ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getPool } = require('../config/database');
const { getR2Client, getR2BucketName } = require('../config/r2');

// --- Tunables ---
const MAX_ATTEMPTS_PER_TURN = 5;
const BACKOFF_MS = [0, 250, 500, 1000, 2000];
const DELETE_BATCH_SIZE = 1000; // S3 DeleteObjects supports up to 1000 keys per call

// Reaper interval (ms). Env-overridable for tests / tuning.
const REAPER_INTERVAL_MS = parseInt(process.env.DELETION_REAPER_INTERVAL_MS || '60000', 10);

// --- Enqueue helpers ---

/**
 * Enqueue a single R2 object key for deletion.
 * `opts.execute_at` is a Date (default: now). `opts.source` is an
 * operator-visible tag for diagnostics (e.g. 'material_delete').
 */
async function enqueueKey(key, opts = {}) {
    if (!key) throw new Error('enqueueKey: key is required');
    const pool = getPool();
    const executeAt = opts.execute_at instanceof Date ? opts.execute_at : new Date();
    await pool.execute(
        `INSERT INTO pending_deletes (mode, target, execute_at, source)
         VALUES ('key', ?, ?, ?)`,
        [key, executeAt, opts.source || null]
    );
}

/**
 * Enqueue a prefix sweep (list + batch-delete everything under the prefix).
 * `opts.hashed_video_id` denormalizes the hash for the collision check at
 * video creation time. Populate it for video-output prefixes; leave null
 * for source / attachment / material prefixes.
 */
async function enqueuePrefix(prefix, opts = {}) {
    if (!prefix) throw new Error('enqueuePrefix: prefix is required');
    const pool = getPool();
    const executeAt = opts.execute_at instanceof Date ? opts.execute_at : new Date();
    await pool.execute(
        `INSERT INTO pending_deletes (mode, target, hashed_video_id, execute_at, source)
         VALUES ('prefix', ?, ?, ?, ?)`,
        [prefix, opts.hashed_video_id || null, executeAt, opts.source || null]
    );
}

/**
 * Is the given hash present in any pending_deletes row?
 * Used by `generateHashedVideoId` to avoid handing out a new video a hash
 * that's about to be nuked by the reaper.
 */
async function hasPendingForHash(hashedVideoId) {
    if (!hashedVideoId) return false;
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT 1 FROM pending_deletes WHERE hashed_video_id = ? LIMIT 1',
        [hashedVideoId]
    );
    return rows.length > 0;
}

// --- R2 operations ---

/**
 * Delete a single object. Returns true on success.
 * 4xx (including 404 / NoSuchKey) is treated as success: the object is gone
 * either way, and S3 DeleteObject is a no-op on missing keys anyway.
 */
async function deleteOneObject(bucket, key) {
    const r2 = getR2Client();
    try {
        await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (err) {
        const status = err.$metadata?.httpStatusCode;
        if (status && status >= 400 && status < 500) return true; // gone is fine
        throw err;
    }
}

/**
 * List + batch-delete everything under the prefix. Repeats until the prefix
 * is empty. Empty list on the first call = idempotent success.
 *
 * Throws on R2 failure (caller's retry/backoff loop handles it).
 */
async function deletePrefixSweep(bucket, prefix) {
    const r2 = getR2Client();
    let continuationToken;
    do {
        const listResult = await r2.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }));

        const contents = listResult.Contents || [];
        if (contents.length > 0) {
            // Chunk into batches of DELETE_BATCH_SIZE; S3 caps at 1000 per call.
            for (let i = 0; i < contents.length; i += DELETE_BATCH_SIZE) {
                const batch = contents.slice(i, i + DELETE_BATCH_SIZE);
                await r2.send(new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: {
                        Objects: batch.map(obj => ({ Key: obj.Key })),
                        Quiet: true,
                    },
                }));
            }
        }

        continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
    } while (continuationToken);
}

// --- Reaper ---

let reaperRunning = false;
let reaperIntervalHandle = null;

/**
 * Drain one turn of the queue. Idempotent across calls (in-flight is
 * guarded by `reaperRunning` so the 60s interval can't trample a still-
 * running drain).
 */
async function runReaper() {
    if (reaperRunning) return;
    reaperRunning = true;
    try {
        const bucket = getR2BucketName();
        if (!bucket) return; // No bucket configured — nothing to delete.

        const pool = getPool();

        // Process rows one at a time until either (a) no more due rows or
        // (b) a row fails all 5 attempts (R2 presumed unhealthy, abort).
        while (true) {
            const [rows] = await pool.execute(
                `SELECT id, mode, target FROM pending_deletes
                 WHERE execute_at <= NOW()
                 ORDER BY execute_at ASC
                 LIMIT 1`
            );
            if (rows.length === 0) break;

            const row = rows[0];
            const ok = await processRow(bucket, row);
            if (!ok) {
                // R2 looks down — abort the turn, leave remaining rows for next tick.
                break;
            }
        }
    } catch (err) {
        console.error('Deletion reaper error:', err.message);
    } finally {
        reaperRunning = false;
    }
}

/**
 * Run one row through up to MAX_ATTEMPTS_PER_TURN attempts.
 * Returns true on success (row was deleted from DB), false if all attempts
 * failed (row stays, attempts/last_error persisted).
 */
async function processRow(bucket, row) {
    const pool = getPool();
    let lastErr = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TURN; attempt++) {
        if (BACKOFF_MS[attempt] > 0) {
            await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        }
        try {
            if (row.mode === 'key') {
                await deleteOneObject(bucket, row.target);
            } else {
                await deletePrefixSweep(bucket, row.target);
            }
            await pool.execute('DELETE FROM pending_deletes WHERE id = ?', [row.id]);
            return true;
        } catch (err) {
            lastErr = err;
            // 4xx are terminal — if deleteOneObject threw it, the helper
            // already swallowed 4xx; getting here means it's 5xx or network.
            // Just retry.
        }
    }

    // All MAX_ATTEMPTS_PER_TURN attempts failed. Persist diagnostic state
    // and signal the reaper to abort the turn.
    const message = lastErr ? (lastErr.message || String(lastErr)) : 'unknown';
    console.error(`Pending delete row ${row.id} (${row.mode} ${row.target}) failed after ${MAX_ATTEMPTS_PER_TURN} attempts: ${message}`);
    try {
        await pool.execute(
            `UPDATE pending_deletes
             SET attempts = attempts + ?, last_attempt_at = NOW(), last_error = ?
             WHERE id = ?`,
            [MAX_ATTEMPTS_PER_TURN, message.slice(0, 4000), row.id]
        );
    } catch (dbErr) {
        // If the DB write itself fails we can't do much — the row remains
        // pending (good); next turn will try again.
        console.error('Failed to persist pending_deletes failure state:', dbErr.message);
    }
    return false;
}

// --- Lifecycle ---

/**
 * Start the periodic reaper. Called once from server.js after DB is up.
 * Runs an immediate boot drain so rows whose execute_at passed during
 * downtime get picked up right away.
 */
function startReaper() {
    if (reaperIntervalHandle) return; // already started
    // Boot drain — fire-and-forget; any error is logged inside runReaper.
    runReaper();
    reaperIntervalHandle = setInterval(runReaper, REAPER_INTERVAL_MS);
    if (reaperIntervalHandle.unref) reaperIntervalHandle.unref();
}

function stopReaper() {
    if (reaperIntervalHandle) {
        clearInterval(reaperIntervalHandle);
        reaperIntervalHandle = null;
    }
}

module.exports = {
    enqueueKey,
    enqueuePrefix,
    hasPendingForHash,
    runReaper,
    startReaper,
    stopReaper,
};
