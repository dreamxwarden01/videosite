// Negative cache for the worker queue.
//
// Workers poll /api/worker/tasks/available continuously, and ~99% of polls
// return empty (no queued tasks). This sentinel lets the empty path skip
// the SELECT FOR UPDATE + UPDATE atomic reserve entirely — just one Redis
// GET. The cache is "I checked recently and the queue had nothing": when
// new work appears, every add-work path DELs this key so the next poll
// falls back to the DB. The 30-min TTL is just a safety net; correctness
// is driven by explicit invalidation.

const { getClient } = require('../redis');

const KEY = 'worker:queue_empty';
const TTL = 30 * 60;

async function isLikelyEmpty() {
    return (await getClient().get(KEY)) === '1';
}

// Called by reserveTasks when the DB returns no candidates. Caches that
// fact so the next poll within TTL is a Redis GET only.
async function markEmpty() {
    await getClient().set(KEY, '1', 'EX', TTL);
}

// Called from every path that adds work to the queue (createTask, retry,
// abort-and-requeue, stale-reset, pending-TTL-reset). DEL is cheap and
// idempotent; safe to call even when the key wasn't set.
async function markHasWork() {
    await getClient().del(KEY);
}

module.exports = { isLikelyEmpty, markEmpty, markHasWork };
