const express = require('express');
const router = express.Router();
const { validateWorkerKey, createWorkerSession } = require('../../services/workerAuthService');
const { requireWorkerSession } = require('../../middleware/workerAuth');
const { getClientIp } = require('../../middleware/auth');
const {
    reserveTasks, leaseTasks, reportJobStatuses,
    completeTask, generateUploadUrls,
} = require('../../services/processingService');

// Stale-task reset moved to a 60s setInterval in server.js — no longer a
// per-poll cost on every /worker/tasks/available hit.

// POST /api/worker/auth — issue a bearer token.
// No middleware on this route; it's the entry point.
router.post('/worker/auth', async (req, res) => {
    try {
        const { keyId, keySecret } = req.body || {};
        if (!keyId || !keySecret) {
            return res.status(400).json({ error: 'keyId and keySecret are required' });
        }

        const valid = await validateWorkerKey(keyId, keySecret);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid or revoked worker key' });
        }

        const ip = getClientIp(req) || '';
        const { bearerToken, expiresInSeconds } = await createWorkerSession(keyId, ip);

        res.json({ bearerToken, expiresInSeconds });
    } catch (err) {
        console.error('Worker auth error:', err);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// GET /api/worker/tasks/available?availableSlot=N — reserve up to N tasks atomically.
router.get('/worker/tasks/available', requireWorkerSession, async (req, res) => {
    try {
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
router.post('/worker/tasks/lease', requireWorkerSession, async (req, res) => {
    try {
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
// Request: { jobId, durationSeconds? }
// Response: 204 on success, 404 if jobId unknown.
router.post('/worker/tasks/complete', requireWorkerSession, async (req, res) => {
    try {
        const { jobId, durationSeconds } = req.body || {};
        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        const found = await completeTask(jobId, durationSeconds || null);
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
