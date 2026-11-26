const backgroundTasks = require('../lib/backgroundTasks');
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
//   - Only explicit NoSuchKey is idempotent success; other failures stay queued.
//   - On success: hard-delete the row.
//   - Failure is persisted with the actual row attempt count and a next-run
//     delay (60s transient, 5min permanent). No failed cleanup is discarded.
//   - Abort this turn; other due rows may run at the next tick.

const { ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getPool } = require('../config/database');
const { getR2Client, getR2BucketName } = require('../config/r2');
const { sendR2Request, errorCode, errorSummary, hash, emit } = require('../lib/r2RequestLog');

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
 * `opts.connection` optionally joins the caller's SQL transaction.
 */
async function enqueueKey(key, opts = {}) {
    if (!key) throw new Error('enqueueKey: key is required');
    const pool = opts.connection || getPool();
    const executeAt = opts.execute_at instanceof Date ? opts.execute_at : new Date();
    if (!Number.isFinite(executeAt.getTime())) throw new TypeError('Invalid deletion time');
    await pool.execute(
        `INSERT INTO pending_deletes (mode, target, execute_at, source)
         VALUES ('key', ?, FROM_UNIXTIME(?), ?)`,
        [key, executeAt.getTime() / 1000, opts.source || null]
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
    const pool = opts.connection || getPool();
    const executeAt = opts.execute_at instanceof Date ? opts.execute_at : new Date();
    if (!Number.isFinite(executeAt.getTime())) throw new TypeError('Invalid deletion time');
    await pool.execute(
        `INSERT INTO pending_deletes (mode, target, hashed_video_id, execute_at, source)
         VALUES ('prefix', ?, ?, FROM_UNIXTIME(?), ?)`,
        [prefix, opts.hashed_video_id || null, executeAt.getTime() / 1000, opts.source || null]
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
 * Only an explicit NoSuchKey is treated as absent. A generic 404 can mean
 * NoSuchBucket/configuration failure and must not discard the cleanup intent.
 */
async function deleteOneObject(bucket, key, context) {
    const r2 = getR2Client();
    try {
        await sendR2Request(r2, new DeleteObjectCommand({ Bucket: bucket, Key: key }), context);
        return true;
    } catch (err) {
        if (errorCode(err) === 'NoSuchKey') return true;
        throw err;
    }
}

/**
 * Walk the prefix and check every batch result. Failed batches remain queued;
 * a later sweep lists surviving keys instead of replaying successful keys.
 *
 * Throws on R2 failure (caller's retry/backoff loop handles it).
 */
async function deletePrefixSweep(bucket, prefix, context) {
    const r2 = getR2Client();
    let continuationToken;
    const seenTokens = new Set();
    do {
        if (backgroundTasks.stopping) return false;
        const listResult = await sendR2Request(r2, new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }), context);

        const contents = listResult.Contents || [];
        if (contents.length > 0) {
            // Chunk into batches of DELETE_BATCH_SIZE; S3 caps at 1000 per call.
            for (let i = 0; i < contents.length; i += DELETE_BATCH_SIZE) {
                if (backgroundTasks.stopping) return false;
                const batch = contents.slice(i, i + DELETE_BATCH_SIZE);
                const result = await sendR2Request(r2, new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: {
                        Objects: batch.map(obj => ({ Key: obj.Key })),
                        Quiet: true,
                    },
                }), context);
                const failures = (result.Errors || []).filter(error => errorCode(error) !== 'NoSuchKey');
                if (failures.length) {
                    const error = new Error(`Batch deletion failed for ${failures.length} objects`);
                    error.name = 'R2BatchDeleteError';
                    error.objectErrors = errorSummary(failures);
                    error.retryable = failures.every(item => isTransientCode(errorCode(item)));
                    error.throttled = failures.some(item => isThrottleCode(errorCode(item)));
                    throw error;
                }
            }
        }

        continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
        if (listResult.IsTruncated) {
            if (typeof continuationToken !== 'string' || !continuationToken || seenTokens.has(continuationToken)) {
                const error = new Error('Invalid R2 listing continuation');
                error.name = 'R2PaginationError';
                throw error;
            }
            seenTokens.add(continuationToken);
        }
    } while (continuationToken);
    if (backgroundTasks.stopping) return false;
    const remaining = await sendR2Request(r2, new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }), context);
    if (remaining.Contents?.length || remaining.IsTruncated) {
        const error = new Error('R2 prefix still contains objects');
        error.name = 'R2PrefixNotEmpty';
        error.retryable = true;
        throw error;
    }
    return true;
}

function isThrottleCode(code) { return ['SlowDown', 'TooManyRequests', 'Throttling', 'ThrottlingException', 'RequestLimitExceeded'].includes(code); }
function isTransientCode(code) {
    return isThrottleCode(code) || ['InternalError', 'ServiceUnavailable', 'RequestTimeout', 'RequestTimeoutException', 'OperationAborted'].includes(code);
}
function retryable(error) {
    if (typeof error.retryable === 'boolean') return error.retryable;
    const status = error.$metadata?.httpStatusCode;
    if (status === 429 || status === 408 || status >= 500 || isTransientCode(errorCode(error))) return true;
    if (status >= 400 && status < 500) return false;
    return true; // Network/unclassified failure: keep the bounded retry policy.
}

// --- Reaper ---

let reaperRunning = false;
let reaperPromise = null;
let reaperIntervalHandle = null;

/**
 * Drain one turn of the queue. Idempotent across calls (in-flight is
 * guarded by `reaperRunning` so the 60s interval can't trample a still-
 * running drain).
 */
function runReaper() {
    if (reaperPromise) return reaperPromise;
    reaperPromise = backgroundTasks.run(drainReaper).finally(() => { reaperPromise = null; });
    return reaperPromise;
}

async function drainReaper() {
    if (reaperRunning) return;
    reaperRunning = true;
    try {
        const bucket = getR2BucketName();
        if (!bucket) return; // No bucket configured — nothing to delete.

        const pool = getPool();

        // Process rows one at a time until either (a) no more due rows or
        // (b) a row fails all 5 attempts (R2 presumed unhealthy, abort).
        while (!backgroundTasks.stopping) {
            const [rows] = await pool.execute(
                `SELECT id, mode, target FROM pending_deletes
                 WHERE execute_at <= NOW()
                 ORDER BY execute_at ASC
                 LIMIT 1`
            );
            if (rows.length === 0 || backgroundTasks.stopping) break;

            const row = rows[0];
            const ok = await processRow(bucket, row);
            if (!ok) {
                // R2 looks down — abort the turn, leave remaining rows for next tick.
                break;
            }
        }
    } catch (err) {
        emit({ component: 'r2_deletion', event: 'reaper_error', phase: 'queue_read', error_code: errorCode(err) });
    } finally {
        reaperRunning = false;
    }
}

/**
 * Run one row through up to MAX_ATTEMPTS_PER_TURN attempts.
 * Returns true on success (row was deleted from DB), false on retained failure
 * or shutdown. Permanent failures stop retries early and remain visible.
 */
async function processRow(bucket, row) {
    const pool = getPool();
    let lastErr = null;
    let attempts = 0;
    let r2Complete = false;
    let phase = 'r2';

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TURN; attempt++) {
        if (attempt > 0 && backgroundTasks.stopping) return false;
        const throttled = lastErr && (lastErr.throttled || lastErr.$metadata?.httpStatusCode === 429 || isThrottleCode(errorCode(lastErr)));
        const wait = attempt > 0 ? Math.max(BACKOFF_MS[attempt], throttled ? 1000 : 0) : 0;
        if (wait > 0) {
            emit({ component: 'r2_deletion', event: 'row_retry_wait', row_id: String(row.id), next_attempt: attempt + 1, delay_ms: wait });
            await new Promise(r => setTimeout(r, wait));
            if (backgroundTasks.stopping) return false;
        }
        try {
            attempts++;
            const context = { row_id: row.id, row_attempt: attempts };
            if (row.mode === 'key') {
                await deleteOneObject(bucket, row.target, context);
            } else {
                if (!(await deletePrefixSweep(bucket, row.target, context))) return false;
            }
            r2Complete = true;
            break;
        } catch (err) {
            lastErr = err;
            if (!retryable(err)) break;
        }
    }

    if (r2Complete) {
        try {
            await pool.execute('DELETE FROM pending_deletes WHERE id = ?', [row.id]);
            emit({ component: 'r2_deletion', event: 'row_complete', row_id: String(row.id), mode: row.mode,
                target_hash: hash(row.target), row_attempts: attempts });
            return true;
        } catch (error) {
            // A DB acknowledgement failure must not replay R2 in this turn.
            // The durable row can safely be reconciled by a later sweep.
            lastErr = error;
            phase = 'db_ack';
        }
    }

    if (backgroundTasks.stopping) return false;

    // Persist bounded transient or permanent failure and retry eligibility.
    const message = JSON.stringify({ phase, code: errorCode(lastErr), status: lastErr?.$metadata?.httpStatusCode || null,
        ...(lastErr?.objectErrors || {}) });
    const nextDelaySeconds = phase === 'db_ack' || retryable(lastErr || {}) ? 60 : 300;
    emit({ component: 'r2_deletion', event: 'row_failed', row_id: String(row.id), mode: row.mode,
        target_hash: hash(row.target), row_attempts: attempts, retry_in_seconds: nextDelaySeconds,
        phase, error_code: errorCode(lastErr), ...(lastErr?.objectErrors || {}) });
    try {
        await pool.execute(
            `UPDATE pending_deletes
             SET attempts = attempts + ?, last_attempt_at = NOW(), last_error = ?,
                 execute_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
             WHERE id = ?`,
            [attempts, message, nextDelaySeconds, row.id]
        );
    } catch (dbErr) {
        // If the DB write itself fails we can't do much — the row remains
        // pending (good); next turn will try again.
        emit({ component: 'r2_deletion', event: 'failure_state_persist_error', row_id: String(row.id),
            phase: 'db_diagnostic', error_code: errorCode(dbErr) });
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
    reaperIntervalHandle = backgroundTasks.interval(runReaper, REAPER_INTERVAL_MS);
    reaperIntervalHandle?.unref?.();
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
