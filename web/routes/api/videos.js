const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { getPool } = require('../../config/database');
const { getVideoById, updateVideo, deleteVideo, cleanR2Prefix } = require('../../services/videoService');
const { generateToken, getTokenValiditySeconds } = require('../../services/tokenService');
const { retryFailedVideo } = require('../../services/processingService');
const { checkPermission } = require('../../middleware/permissions');
const videoCache = require('../../services/cache/videoCache');
const enrollmentCache = require('../../services/cache/enrollmentCache');
const watchProgressCache = require('../../services/cache/watchProgressCache');

// POST /api/updatewatch
//
// Body: { video_id: uint32, position: number, delta: number }
//
// `delta` is the number of watched seconds the client wants credited this call.
// The client accumulates real-time-elapsed locally and flushes in chunks
// (normally ~10s on the tick threshold, but also on pause and on back-button
// click — sometimes with a delta of zero, purely to persist last_position
// after the user scrubbed while paused).
//
// Validation (all failures → 422, and the client silently drops the flush
// without retry or rollback — a 422 only occurs when the client payload is
// malformed, which should never happen with an unmodified bundle):
//   - video_id must be a positive unsigned integer (1 .. 2^32-1).
//   - position must be a finite number, 0 ≤ position ≤ video.duration_seconds + 1.
//     The +1s tolerance covers the sub-second gap between the true video
//     duration (ffprobe emits fractional seconds, e.g. 123.45) and the
//     value stored in the DB column (INT UNSIGNED, rounded to 123). A
//     player reporting position=123.4 on the final frame would otherwise
//     be 422'd as "exceeds duration" even though it's entirely legitimate.
//   - delta must be present and a finite non-negative number. The legacy
//     "delta absent → credit 10" fallback for pre-rollout bundles is gone;
//     all supported clients send delta explicitly (0 for position-only flushes).
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

        // video_id: positive unsigned integer. Number() on the raw body value
        // accepts numeric strings too ("3" → 3) but NaN/floats/negatives fall
        // out at isInteger / range checks.
        const videoIdNum = Number(video_id);
        if (!Number.isInteger(videoIdNum) || videoIdNum <= 0 || videoIdNum > 4294967295) {
            return res.status(422).json({ error: 'invalid video_id' });
        }

        // position: finite, non-negative. Upper bound against duration is
        // checked after the lookup.
        const positionNum = Number(position);
        if (!Number.isFinite(positionNum) || positionNum < 0) {
            return res.status(422).json({ error: 'invalid position' });
        }

        // delta: required, finite, non-negative. `delta > 60` is well-formed
        // but drops credit to 0 (anti-abuse, see block comment above).
        if (delta === undefined || delta === null) {
            return res.status(422).json({ error: 'delta is required' });
        }
        const deltaNum = Number(delta);
        if (!Number.isFinite(deltaNum) || deltaNum < 0) {
            return res.status(422).json({ error: 'invalid delta' });
        }
        const credit = deltaNum > 60 ? 0 : deltaNum;

        const video = await videoCache.getVideoMeta(videoIdNum);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Position must not exceed the video's stored duration, with a +1s
        // tolerance to absorb the DB's sub-second truncation — see the
        // block comment above for the ffprobe-float → INT UNSIGNED rounding
        // rationale. NULL duration (pre-processing / metadata missing)
        // skips the upper-bound check; no legitimate playback flow reaches
        // here with duration still unset, but there's no reason to
        // hard-fail if we ever do.
        const duration = video.duration_seconds;
        if (duration !== null && positionNum > duration + 1) {
            return res.status(422).json({ error: 'position exceeds video duration' });
        }

        // Check course access (cache-backed)
        if (!user.permissions.allCourseAccess) {
            const enrolled = await enrollmentCache.isEnrolledInCourse(user.user_id, video.course_id);
            if (!enrolled) {
                return res.status(403).json({ error: 'No access to this course' });
            }
        }

        // Anti-cheat rate limit: if claimed delta exceeds wall-clock elapsed
        // since the last report (with 1s tolerance), drop credit to 0. Always
        // refreshes the 120s window — a paused viewer who resumes after 2+
        // min starts fresh.
        const finalCredit = await watchProgressCache.applyRateLimit(user.user_id, videoIdNum, credit);

        // Write to Redis, not DB. The flusher drains dirty:watch every 15 min
        // and applies the accumulated `delta` against watch_progress.watch_seconds
        // in a single UPSERT per (user, video). Credit may be 0 (position-only
        // flush) — last_position still updates so resume keeps tracking the user.
        await watchProgressCache.recordProgress(user.user_id, videoIdNum, positionNum, finalCredit);

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

// GET /api/refresh-token/:videoId — refresh HMAC playback token.
// Hot path during playback (called every few minutes per active viewer), so
// both the video lookup and the enrollment check go through the cache.
//
// Modeled as GET because it generates and returns data without changing
// server state — symmetric with the initial GET /api/watch/:videoId. Safe
// from intermediate caching: the /api Cache-Control: no-store middleware
// (server.js) already prevents browser/CDN reuse.
router.get('/refresh-token/:videoId', requireAuth, async (req, res) => {
    try {
        const videoId = parseInt(req.params.videoId);
        const user = res.locals.user;

        // Check playback permission
        if (!user.permissions.allowPlayback) {
            return res.status(403).json({ error: 'Playback not allowed' });
        }

        const video = await videoCache.getVideoMeta(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check course access
        if (!user.permissions.allCourseAccess) {
            const enrolled = await enrollmentCache.isEnrolledInCourse(user.user_id, video.course_id);
            if (!enrolled) {
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
