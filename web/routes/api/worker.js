const express = require('express');
const router = express.Router();
const {
    validateWorkerKey, createWorkerSession,
    getWorkerKeyStatus, deactivateWorkerKey,
    checkAndRecordAuthAttempt,
    STATUS_ACTIVE, STATUS_PAUSED,
} = require('../../services/workerAuthService');
const { requireWorkerSession } = require('../../middleware/workerAuth');
const { getClientIp } = require('../../middleware/auth');
const { normalizeIP } = require('../../services/ipHelpers');
const {
    reserveTasks, leaseTasks, reportJobStatuses,
    completeTask, generateUploadUrls,
} = require('../../services/processingService');

// Stale-task reset moved to a 60s setInterval in server.js — no longer a
// per-poll cost on every /worker/tasks/available hit.

// POST /api/worker/auth — issue a bearer token.
// No middleware on this route; it's the entry point.
//
// Order of checks is deliberate: credentials first, leak detection second.
// Recording the IP only after the secret matches means a wrong-secret probe
// from a random IP can't fill the recent-list and false-positive a legit
// reauth from the operator. The leak detector lives in workerAuthService.
router.post('/worker/auth', async (req, res) => {
    try {
        const { keyId, keySecret } = req.body || {};
        if (!keyId || !keySecret) {
            return res.status(400).json({ error: 'keyId and keySecret are required' });
        }

        const status = await validateWorkerKey(keyId, keySecret);
        if (!status) {
            return res.status(401).json({ error: 'Invalid or deactivated worker key' });
        }

        // Leak detection. Runs only on a credential-validated request so it
        // can't be poisoned by external probing. A 'leak' verdict means we
        // saw this IP before for this key within the live 60s window, with a
        // different IP currently holding the most-recent slot — the ping-pong
        // signature an attacker reauth would produce.
        const ip = getClientIp(req) || '';
        const normalizedIp = normalizeIP(ip);
        const verdict = await checkAndRecordAuthAttempt(keyId, normalizedIp);
        if (verdict === 'leak') {
            await deactivateWorkerKey(keyId);
            return res.status(401).json({ error: 'Credential leak detected; key has been deactivated.' });
        }

        const { bearerToken, expiresInSeconds } = await createWorkerSession(keyId, ip);

        res.json({ bearerToken, expiresInSeconds });
    } catch (err) {
        console.error('Worker auth error:', err);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// GET /api/worker/tasks/available?availableSlot=N — reserve up to N tasks atomically.
//
// Returns an empty list when the key is paused — the worker keeps polling
// without realising work is being withheld, which is exactly what we want
// (no behavioural change on the worker side; the admin holds the lever).
// A deactivated key would have had its session killed at deactivation time,
// so we shouldn't see one here, but if a race lets a request through we 401.
router.get('/worker/tasks/available', requireWorkerSession, async (req, res) => {
    try {
        const status = await getWorkerKeyStatus(req.worker.keyId);
        if (status !== STATUS_ACTIVE && status !== STATUS_PAUSED) {
            return res.status(401).json({ error: 'Worker key is no longer active' });
        }
        if (status === STATUS_PAUSED) {
            return res.json({ tasks: [] });
        }

        const slotRaw = parseInt(req.query.availableSlot, 10);
        const slots = Number.isFinite(slotRaw) && slotRaw > 0 ? Math.min(slotRaw, 32) : 0;
        if (slots <= 0) {
            return res.json({ tasks: [] });
        }

        // ~99% of polls return empty. Skip the DB SELECT + UPDATE if the
        // negative cache says so; every add-work path DELs the sentinel.
        const queueCache = require('../../services/cache/queueCache');
        if (await queueCache.isLikelyEmpty()) {
            return res.json({ tasks: [] });
        }

        const videoIds = await reserveTasks(slots);
        if (videoIds.length === 0) {
            // DB confirmed empty — cache the result so subsequent polls
            // short-circuit until new work arrives or the TTL expires.
            await queueCache.markEmpty();
        }
        res.json({ tasks: videoIds.map(v => ({ videoId: v })) });
    } catch (err) {
        console.error('Worker tasks/available error:', err);
        res.status(500).json({ error: 'Failed to check available tasks' });
    }
});

// POST /api/worker/tasks/lease — lease an array of previously-reserved videoIds.
// Request: { videoIds: [1234, 1235, ...] }
// Response: { results: [ { videoId, status: "leased"|"taken"|"notfound", ...spec } ] }
//
// Re-checks the key status; a paused / deactivated key shouldn't be granted
// leases even if a task somehow made it into reserveTasks before the status
// changed. Failure shape matches a normal "can't lease" so the worker just
// treats it as nothing-to-do and keeps polling.
router.post('/worker/tasks/lease', requireWorkerSession, async (req, res) => {
    try {
        const status = await getWorkerKeyStatus(req.worker.keyId);
        if (status !== STATUS_ACTIVE) {
            return res.json({ results: [] });
        }

        const { videoIds } = req.body || {};
        if (!Array.isArray(videoIds) || videoIds.length === 0) {
            return res.status(400).json({ error: 'videoIds[] is required' });
        }

        const results = await leaseTasks(videoIds, req.worker.keyId);
        res.json({ results });
    } catch (err) {
        console.error('Worker tasks/lease error:', err);
        res.status(500).json({ error: 'Failed to lease tasks' });
    }
});

// POST /api/worker/tasks/status — batched per-job status update.
// Request: { jobs: [ { jobId, status, stage?, progress?, errorMessage? }, ... ] }
// Response: { results: [ { jobId, ack }, ... ] }
router.post('/worker/tasks/status', requireWorkerSession, async (req, res) => {
    try {
        const { jobs } = req.body || {};
        if (!Array.isArray(jobs)) {
            return res.status(400).json({ error: 'jobs[] is required' });
        }

        const results = await reportJobStatuses(jobs);
        res.json({ results });
    } catch (err) {
        console.error('Worker tasks/status error:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// POST /api/worker/tasks/complete — single-job completion.
// Request: { jobId, durationSeconds?, hasPoster? }
// Response: 204 on success, 404 if jobId unknown.
router.post('/worker/tasks/complete', requireWorkerSession, async (req, res) => {
    try {
        const { jobId, durationSeconds, hasPoster } = req.body || {};
        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        const found = await completeTask(jobId, durationSeconds || null, hasPoster === true);
        if (!found) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('Worker tasks/complete error:', err);
        res.status(500).json({ error: 'Failed to complete task' });
    }
});

// POST /api/worker/tasks/upload-urls — presigned PUT URLs for HLS output.
router.post('/worker/tasks/upload-urls', requireWorkerSession, async (req, res) => {
    try {
        const { jobId, filenames } = req.body || {};
        if (!jobId || !Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({ error: 'jobId and filenames[] are required' });
        }

        const result = await generateUploadUrls(jobId, filenames);
        if (!result) {
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json(result);
    } catch (err) {
        console.error('Worker upload-urls error:', err);
        res.status(500).json({ error: 'Failed to generate upload URLs' });
    }
});

module.exports = router;
