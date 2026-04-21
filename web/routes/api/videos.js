const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { getPool } = require('../../config/database');
const { getVideoById, updateVideo, deleteVideo, cleanR2Prefix } = require('../../services/videoService');
const { generateToken, getTokenValiditySeconds } = require('../../services/tokenService');
const { retryFailedVideo } = require('../../services/processingService');
const { checkPermission } = require('../../middleware/permissions');

// GET /api/videos/:id/playback
router.get('/videos/:id/playback', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const videoId = parseInt(req.params.id);

        if (!user.permissions.allowPlayback) {
            return res.json({ hlsUrl: null, isPlaybackAllowed: false, resumePosition: null });
        }

        const video = await getVideoById(videoId);
        if (!video || video.status !== 'finished') {
            return res.status(404).json({ error: 'Video not found or not ready' });
        }

        // Check course access
        if (!user.permissions.allCourseAccess) {
            const pool = getPool();
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, video.course_id]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'Not enrolled in this course' });
            }
        }

        const publicDomain = process.env.R2_PUBLIC_DOMAIN;
        const videoType = video.video_type || 'ts';
        const basePath = `/${video.hashed_video_id}/${video.processing_job_id}/`;
        let hlsUrl = `https://${publicDomain}${basePath}master.m3u8`;
        let dashUrl = null;

        // CMAF videos get both an HLS and a DASH manifest URL. Shaka on non-Apple
        // clients loads the DASH one; Apple (Safari/iOS/iPadOS) uses native HLS
        // off the same master.m3u8 via #EXT-X-DEFINE QUERYPARAM substitution.
        if (videoType === 'cmaf') {
            const token = await generateToken(basePath);
            if (token) {
                const q = `?verify=${encodeURIComponent(token)}`;
                hlsUrl = `${hlsUrl}${q}`;
                dashUrl = `https://${publicDomain}${basePath}manifest.mpd${q}`;
            } else {
                dashUrl = `https://${publicDomain}${basePath}manifest.mpd`;
            }
        }

        // Get resume position
        let resumePosition = null;
        const pool = getPool();
        const [watchRows] = await pool.execute(
            'SELECT last_position FROM watch_progress WHERE user_id = ? AND video_id = ?',
            [user.user_id, videoId]
        );
        if (watchRows.length > 0 && video.duration_seconds) {
            const pos = watchRows[0].last_position;
            const duration = video.duration_seconds;
            if (pos > duration * 0.05 && pos < duration * 0.90) {
                resumePosition = pos;
            }
        }

        res.json({ hlsUrl, dashUrl, videoType, isPlaybackAllowed: true, resumePosition });
    } catch (err) {
        console.error('Playback API error:', err);
        res.status(500).json({ error: 'Failed to get playback info' });
    }
});

// POST /api/updatewatch
//
// Body: { video_id: int, position: float, delta?: float }
//
// `delta` is the number of watched seconds the client wants credited this call.
// The client accumulates real-time-elapsed locally and flushes in chunks
// (normally ~10s on the tick threshold, but also on pause and on back-button
// click — sometimes with a delta of zero, purely to persist last_position
// after the user scrubbed while paused).
//
// Back-compat: if `delta` is absent, credit 10 (legacy pre-rollout bundle).
//
// Anti-abuse: any delta > 60 has its watch-time contribution dropped (0-credit)
// but the upsert still runs so last_position tracks. 60s is tight — legitimate
// bursts fit (a single ~30s network blip on retry), abusive claims don't. No
// comparison against last_watch_at: two devices viewing the same video
// concurrently is a real use case that would false-positive.
router.post('/updatewatch', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const { video_id, position, delta } = req.body;

        if (!video_id || position === undefined) {
            return res.status(400).json({ error: 'video_id and position are required' });
        }

        // Decide how many seconds to credit.
        //   delta absent          → 10 (back-compat with old client bundles)
        //   delta 0..60 finite    → credit that amount (0 = position-only flush)
        //   delta > 60 or invalid → 0 (watch time dropped, still updates position)
        let credit = 10;
        if (delta !== undefined) {
            const d = Number(delta);
            if (!Number.isFinite(d) || d < 0 || d > 60) {
                credit = 0;
            } else {
                credit = d;
            }
        }

        const pool = getPool();
        const videoId = parseInt(video_id);

        // Get video's course
        const [videoRows] = await pool.execute(
            'SELECT course_id FROM videos WHERE video_id = ?',
            [videoId]
        );
        if (videoRows.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check course access
        if (!user.permissions.allCourseAccess) {
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, videoRows[0].course_id]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'No access to this course' });
            }
        }

        // Always upsert — credit may be 0, in which case watch_seconds is
        // unchanged (watch_seconds + 0) but last_position still refreshes. That
        // handles pause-with-no-new-playback (user scrubbed while paused) and
        // silently-dropped delta>60 reports (position is still trusted — it's
        // a harmless number, unlike the watch-time claim which we capped).
        await pool.execute(
            `INSERT INTO watch_progress (user_id, video_id, watch_seconds, last_position, last_watch_at)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
                watch_seconds = watch_seconds + ?,
                last_position = VALUES(last_position),
                last_watch_at = NOW()`,
            [user.user_id, videoId, credit, parseFloat(position), credit]
        );

        res.status(204).end();
    } catch (err) {
        console.error('Update watch error:', err);
        res.status(500).json({ error: 'Failed to update watch progress' });
    }
});

// POST /api/videos/:id (update video info — for changeVideo permission)
router.post('/videos/:id', requireAuth, checkPermission('changeVideo'), async (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        const video = await getVideoById(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check course access
        const user = res.locals.user;
        if (!user.permissions.allCourseAccess) {
            const pool = getPool();
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, video.course_id]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'Not enrolled in this course' });
            }
        }

        const { title, description, week, lecture_date } = req.body;
        const updates = {};
        if (title !== undefined) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (week !== undefined) updates.week = week;
        if (lecture_date !== undefined) updates.lecture_date = lecture_date;

        await updateVideo(videoId, updates);
        res.status(204).end();
    } catch (err) {
        console.error('Update video error:', err);
        res.status(500).json({ error: 'Failed to update video' });
    }
});

// POST /api/videos/:id/delete
router.post('/videos/:id/delete', requireAuth, checkPermission('deleteVideo'), async (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        const video = await getVideoById(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const courseId = video.course_id;
        const user = res.locals.user;
        if (!user.permissions.allCourseAccess) {
            const pool = getPool();
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, courseId]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'Not enrolled in this course' });
            }
        }

        await deleteVideo(videoId);
        res.status(204).end();
    } catch (err) {
        console.error('Delete video error:', err);
        res.status(500).json({ error: 'Failed to delete video' });
    }
});

// POST /api/videos/:id/clean-source — delete the original source file from R2
router.post('/videos/:id/clean-source', requireAuth, checkPermission('changeVideo'), async (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        const pool = getPool();

        const [rows] = await pool.execute(
            `SELECT r2_source_key, status FROM videos WHERE video_id = ?`,
            [videoId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const video = rows[0];
        if (video.status !== 'finished') {
            return res.status(400).json({ error: 'Video is not in finished state' });
        }
        if (!video.r2_source_key) {
            return res.status(400).json({ error: 'Source file already cleaned' });
        }

        // Derive directory from r2_source_key (e.g. "source/{upload_id}/source.mp4" → "source/{upload_id}/")
        const sourceDir = video.r2_source_key.substring(0, video.r2_source_key.lastIndexOf('/') + 1);
        await cleanR2Prefix(sourceDir);
        await pool.execute('UPDATE videos SET r2_source_key = NULL WHERE video_id = ?', [videoId]);

        res.status(204).end();
    } catch (err) {
        console.error('Clean source error:', err);
        res.status(500).json({ error: 'Failed to clean source file' });
    }
});

// POST /api/videos/:id/retry  — re-queue a failed video for transcoding
router.post('/videos/:id/retry', requireAuth, checkPermission('uploadVideo'), async (req, res) => {
    try {
        const videoId = parseInt(req.params.id);
        const video = await getVideoById(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.status !== 'error') {
            return res.status(400).json({ error: 'Video is not in error state' });
        }

        // Check course access
        const user = res.locals.user;
        if (!user.permissions.allCourseAccess) {
            const pool = getPool();
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, video.course_id]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'Not enrolled in this course' });
            }
        }

        const success = await retryFailedVideo(videoId);
        if (!success) {
            return res.status(400).json({ error: 'Failed to retry — no error task found for this video' });
        }

        res.status(204).end();
    } catch (err) {
        console.error('Retry video error:', err);
        res.status(500).json({ error: 'Failed to retry video' });
    }
});

// GET /api/keys/:videoId — serve HLS AES-128 encryption key for playback
router.get('/keys/:videoId', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const videoId = parseInt(req.params.videoId);

        // Check playback permission
        if (!user.permissions.allowPlayback) {
            return res.status(403).json({ error: 'Playback not allowed' });
        }

        const pool = getPool();
        const [rows] = await pool.execute(
            'SELECT encryption_key, course_id FROM videos WHERE video_id = ? AND status = ?',
            [videoId, 'finished']
        );

        if (rows.length === 0 || !rows[0].encryption_key) {
            return res.status(404).json({ error: 'Key not found' });
        }

        const video = rows[0];

        // Check course enrollment
        if (!user.permissions.allCourseAccess) {
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, video.course_id]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'Not enrolled in this course' });
            }
        }

        // Return raw 16-byte key
        res.set('Content-Type', 'application/octet-stream');
        res.set('Cache-Control', 'no-store');
        res.send(video.encryption_key);
    } catch (err) {
        console.error('Key delivery error:', err);
        res.status(500).json({ error: 'Failed to deliver key' });
    }
});

// POST /api/videos/:id/refresh-token — refresh HMAC playback token
router.post('/videos/:id/refresh-token', requireAuth, async (req, res) => {
    try {
        const pool = getPool();
        const videoId = parseInt(req.params.id);
        const user = res.locals.user;

        // Check playback permission
        if (!user.permissions.allowPlayback) {
            return res.status(403).json({ error: 'Playback not allowed' });
        }

        // Get video path components
        const [videoRows] = await pool.execute(
            `SELECT hashed_video_id, processing_job_id, course_id FROM videos WHERE video_id = ?`,
            [videoId]
        );
        if (videoRows.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const video = videoRows[0];

        // Check course access
        if (!user.permissions.allCourseAccess) {
            const [enrollment] = await pool.execute(
                'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
                [user.user_id, video.course_id]
            );
            if (enrollment.length === 0) {
                return res.status(403).json({ error: 'Not enrolled' });
            }
        }

        // Generate new token (null if HMAC disabled or not configured)
        const basePath = `/${video.hashed_video_id}/${video.processing_job_id}/`;
        const token = await generateToken(basePath);
        const tokenValiditySeconds = await getTokenValiditySeconds();
        res.json({ token, tokenValiditySeconds });
    } catch (err) {
        console.error('Token refresh error:', err);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

module.exports = router;
