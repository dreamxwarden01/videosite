const express = require('express');
const router = express.Router();
const { requireWorkerAuth } = require('../../services/workerAuthService');
const {
    leaseNextTask, updateTaskStatus, completeTask, reportError,
    resetStaleTasks, getTaskByJobId,
    checkAvailableTask, leaseTask, generateUploadUrls,
    abortAndRequeue
} = require('../../services/processingService');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getR2Client, getR2BucketName } = require('../../config/r2');

// Reset stale tasks on every poll (simple approach)
async function checkStaleTasks() {
    try {
        await resetStaleTasks();
    } catch (err) {
        console.error('Failed to reset stale tasks:', err.message);
    }
}

// GET /api/worker/task — poll for next task
router.get('/worker/task', requireWorkerAuth, async (req, res) => {
    try {
        await checkStaleTasks();

        const task = await leaseNextTask(req.workerKeyId);
        if (!task) {
            return res.json({ task: null });
        }

        res.json({
            task: {
                jobId: task.job_id,
                videoId: task.video_id,
                courseId: task.course_id,
                hashedVideoId: task.hashed_video_id,
                r2SourceKey: task.r2_source_key,
                originalFilename: task.original_filename
            }
        });
    } catch (err) {
        console.error('Worker task poll error:', err);
        res.status(500).json({ error: 'Failed to poll for task' });
    }
});

// POST /api/worker/task/:jobId/status — update task status
router.post('/worker/task/:jobId/status', requireWorkerAuth, async (req, res) => {
    try {
        const { status, progress, durationSeconds } = req.body;
        const validStatuses = ['leased', 'processing'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        // Update processing queue — returns { found: false } if job doesn't exist
        const result = await updateTaskStatus(req.params.jobId, status, progress);
        if (!result.found) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Handle worker-specific video status and duration updates
        const { videoStatus } = req.body;
        if (videoStatus || durationSeconds != null) {
            const task = await getTaskByJobId(req.params.jobId);
            if (task) {
                const { getPool } = require('../../config/database');
                const pool = getPool();
                const fields = [];
                const values = [];

                if (videoStatus) {
                    const validVideoStatuses = ['worker_downloading', 'processing', 'worker_uploading'];
                    if (validVideoStatuses.includes(videoStatus)) {
                        fields.push('status = ?');
                        values.push(videoStatus);
                        fields.push('processing_progress = ?');
                        values.push(progress || 0);
                    }
                }

                // Store duration when reported by worker after probe
                if (durationSeconds != null && durationSeconds > 0) {
                    fields.push('duration_seconds = ?');
                    values.push(Math.round(durationSeconds));
                }

                if (fields.length > 0) {
                    values.push(task.video_id);
                    await pool.execute(
                        `UPDATE videos SET ${fields.join(', ')} WHERE video_id = ?`,
                        values
                    );
                }
            }
        }

        res.status(204).end();
    } catch (err) {
        console.error('Worker status update error:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// POST /api/worker/task/:jobId/complete
router.post('/worker/task/:jobId/complete', requireWorkerAuth, async (req, res) => {
    try {
        const { durationSeconds } = req.body;
        const found = await completeTask(req.params.jobId, durationSeconds || null);
        if (!found) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('Worker task complete error:', err);
        res.status(500).json({ error: 'Failed to complete task' });
    }
});

// POST /api/worker/task/:jobId/abort — worker reports job was aborted, requeue it
router.post('/worker/task/:jobId/abort', requireWorkerAuth, async (req, res) => {
    try {
        const found = await abortAndRequeue(req.params.jobId);
        if (!found) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('Worker abort report error:', err);
        res.status(500).json({ error: 'Failed to process abort' });
    }
});

// POST /api/worker/task/:jobId/error
router.post('/worker/task/:jobId/error', requireWorkerAuth, async (req, res) => {
    try {
        const { message } = req.body;
        const result = await reportError(req.params.jobId, message || 'Unknown error');
        if (!result.found) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('Worker error report error:', err);
        res.status(500).json({ error: 'Failed to report error' });
    }
});

// GET /api/worker/tasks/available — check for available task (new check-then-lease protocol)
router.get('/worker/tasks/available', requireWorkerAuth, async (req, res) => {
    try {
        const result = await checkAvailableTask();
        res.json(result);
    } catch (err) {
        console.error('Worker task available check error:', err);
        res.status(500).json({ error: 'Failed to check available tasks' });
    }
});

// POST /api/worker/tasks/lease — lease a specific pending task
router.post('/worker/tasks/lease', requireWorkerAuth, async (req, res) => {
    try {
        const { videoId } = req.body;
        if (!videoId) {
            return res.status(400).json({ error: 'videoId is required' });
        }

        const result = await leaseTask(videoId, req.workerKeyId);
        res.json(result);
    } catch (err) {
        console.error('Worker task lease error:', err);
        res.status(500).json({ error: 'Failed to lease task' });
    }
});

// POST /api/worker/tasks/upload-urls — get presigned PUT URLs for uploading HLS output
router.post('/worker/tasks/upload-urls', requireWorkerAuth, async (req, res) => {
    try {
        const { jobId, filenames } = req.body;
        if (!jobId || !filenames || !Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({ error: 'jobId and filenames[] are required' });
        }

        const result = await generateUploadUrls(jobId, filenames);
        if (!result) {
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json(result);
    } catch (err) {
        console.error('Worker upload URLs error:', err);
        res.status(500).json({ error: 'Failed to generate upload URLs' });
    }
});

// GET /api/worker/task/:jobId/download-url
router.get('/worker/task/:jobId/download-url', requireWorkerAuth, async (req, res) => {
    try {
        const task = await getTaskByJobId(req.params.jobId);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        const r2 = getR2Client();
        const bucket = getR2BucketName();

        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: task.r2_source_key,
        });

        const url = await getSignedUrl(r2, command, { expiresIn: 3600 });
        res.json({ downloadUrl: url });
    } catch (err) {
        console.error('Worker download URL error:', err);
        res.status(500).json({ error: 'Failed to generate download URL' });
    }
});

module.exports = router;
