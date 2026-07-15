const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { getPool, idBuf } = require('../../config/database');
const { getUserById } = require('../../services/userService');
const { getUserSessions, deleteUserSessions } = require('../../config/session');
const { generateToken, generateFileToken, getTokenValiditySeconds } = require('../../services/tokenService');
const { getUserMfaMethods, isUserMfaEnabled, maskEmail } = require('../../services/mfaService');
const UAParser = require('ua-parser-js');

function formatUserAgent(ua) {
    if (!ua) return 'Unknown';
    const parsed = UAParser(ua);
    const browser = parsed.browser.name || 'Unknown browser';
    const browserVer = parsed.browser.version ? ' ' + parsed.browser.version : '';
    const os = parsed.os.name || 'Unknown OS';
    const osVer = parsed.os.version ? ' ' + parsed.os.version : '';
    return `${browser}${browserVer} on ${os}${osVer}`;
}

// GET /api/courses — course list for home page
router.get('/courses', requireAuth, async (req, res) => {
    try {
        const courseListCache = require('../../services/cache/courseListCache');
        const enrollmentCache = require('../../services/cache/enrollmentCache');

        const user = res.locals.user;

        // The cached base holds one row per course — active AND inactive — with
        // NO per-user data. We compose the caller's visible list in-app on every
        // request: filter to active, then scope by the CALLER's own permissions
        // / enrollment. The composed result is NEVER cached, so one user's course
        // set can't leak to another.
        const base = (await courseListCache.getBase()).filter(c => c.is_active === 1);

        let visible;
        if (user.permissions.allCourseAccess) {
            visible = base;
        } else {
            // getUserEnrollments returns an array of int course_ids. Normalise to
            // Number on both sides so a Set membership test can't silently miss
            // on a type drift — a mismatch would show an enrolled user ZERO courses.
            const enrolled = new Set(
                (await enrollmentCache.getUserEnrollments(user.user_id)).map(Number)
            );
            visible = base.filter(c => enrolled.has(Number(c.course_id)));
        }

        res.json({
            courses: visible.map(c => ({
                course_id: c.course_id,
                course_code: c.course_code,
                course_name: c.course_name,
                module_label: c.module_label,
                video_count: c.video_count,
                last_video_at: c.last_video_at || null,
            }))
        });
    } catch (err) {
        console.error('API courses error:', err);
        res.status(500).json({ error: 'Failed to load courses.' });
    }
});

// GET /api/courses/:courseId — course detail + paginated videos
router.get('/courses/:courseId', requireAuth, async (req, res) => {
    try {
        const pool = getPool();
        const user = res.locals.user;
        const courseId = parseInt(req.params.courseId);
        const page = parseInt(req.query.page) || 1;
        // Fit-to-height paging (like the account portal): the client measures
        // how many rows fit and asks for exactly that many. Clamp to a sane
        // range instead of the old fixed [10,20,50] set.
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 60);

        const courseCache = require('../../services/cache/courseCache');
        const enrollmentCache = require('../../services/cache/enrollmentCache');

        const course = await courseCache.getCourseMeta(courseId);
        if (!course || course.is_active !== 1) {
            return res.status(404).json({ error: 'Course not found.', code: 'COURSE_NOT_FOUND' });
        }

        // Check course access
        if (!user.permissions.allCourseAccess) {
            const enrolled = await enrollmentCache.isEnrolledInCourse(user.user_id, courseId);
            if (!enrolled) {
                return res.status(403).json({ error: 'You are not enrolled in this course.', code: 'COURSE_FORBIDDEN' });
            }
        }

        const [countRows] = await pool.execute(
            'SELECT COUNT(*) as total FROM videos WHERE course_id = ?',
            [courseId]
        );

        const total = countRows[0].total;
        const lim = limit;
        const totalPages = Math.max(1, Math.ceil(total / lim));
        // Clamp an out-of-range page to the LAST page: a stale/oversized page
        // number (e.g. the client's remembered page after its measured page size
        // grew and reduced the page count) returns the last page's rows instead
        // of an empty set.
        const effPage = Math.min(Math.max(page, 1), totalPages);
        const off = (effPage - 1) * lim;
        // Sort — whitelisted so the fragments are safe to interpolate. A NULL
        // module_number / lecture_date always sinks to the bottom regardless of order.
        //   default: module_number → lecture date → id
        //   date:    lecture date → module_number → id      (date promoted to front)
        //   name:    title → module_number → lecture date → id   (name promoted to front)
        const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';
        const sort = ['default', 'date', 'name'].includes(req.query.sort) ? req.query.sort : 'default';
        const orderBy =
            sort === 'name'
                ? `title ${dir}, (module_number IS NULL) ASC, CAST(module_number AS UNSIGNED) ${dir}, (lecture_date IS NULL) ASC, lecture_date ${dir}, video_id ${dir}`
                : sort === 'date'
                    ? `(lecture_date IS NULL) ASC, lecture_date ${dir}, (module_number IS NULL) ASC, CAST(module_number AS UNSIGNED) ${dir}, video_id ${dir}`
                    : `(module_number IS NULL) ASC, CAST(module_number AS UNSIGNED) ${dir}, (lecture_date IS NULL) ASC, lecture_date ${dir}, video_id ${dir}`;
        const [videos] = await pool.execute(
            `SELECT * FROM videos WHERE course_id = ?
             ORDER BY ${orderBy}
             LIMIT ${lim} OFFSET ${off}`,
            [courseId]
        );
        await require('../../services/cache/transcodeProgressCache').applyLiveOverlayToVideos(videos);

        // Per-video poster signing. The course list page swaps the
        // play-icon for a thumbnail when a video has has_poster=1, but the
        // R2 URL needs a per-file HMAC token to clear the WAF rule's
        // file-scope branch (the prefix-scope token only signs the manifest
        // path region, not the .jpg sitting at the per-course poster key).
        // We mint one token per row up front so the client doesn't have to
        // refresh per-image — the validity matches the playback token.
        //
        // The poster path is `/posters/{course_id}/{video_id}.jpg` — stable
        // across re-encodes so a replacement video overwrites in place, and
        // course delete sweeps the entire `posters/{course_id}/` prefix in
        // one go. The client reconstructs the full URL from courseId +
        // video_id + this token, so we no longer ship posterPath.
        //
        // Mint only when has_poster=1; otherwise the client falls back to
        // the play-icon glyph without ever touching R2.
        const publicDomain = process.env.R2_PUBLIC_DOMAIN || '';
        const posterVideos = await Promise.all(videos.map(async (v) => {
            const out = {
                video_id: v.video_id,
                course_id: v.course_id,
                title: v.title,
                description: v.description,
                module_number: v.module_number,
                lecture_date: v.lecture_date,
                duration_seconds: v.duration_seconds,
                status: v.status,
                processing_progress: v.processing_progress,
            };
            if (v.has_poster) {
                const posterPath = `/posters/${v.course_id}/${v.video_id}.jpg`;
                const posterToken = await generateFileToken(posterPath);
                out.posterToken = posterToken || '';
            }
            return out;
        }));

        res.json({
            course: {
                course_id: course.course_id,
                course_code: course.course_code,
                course_name: course.course_name,
                module_label: course.module_label,
                is_active: course.is_active,
            },
            videos: posterVideos,
            r2PublicDomain: publicDomain,
            pagination: {
                page: effPage,
                totalPages,
                total,
                limit
            }
        });
    } catch (err) {
        console.error('API course detail error:', err);
        res.status(500).json({ error: 'Failed to load course.' });
    }
});

// GET /api/watch/:videoId — video metadata + playback URL + HMAC token
router.get('/watch/:videoId', requireAuth, async (req, res) => {
    try {
        const pool = getPool();
        const videoId = parseInt(req.params.videoId);
        const user = res.locals.user;

        if (!user.permissions.allowPlayback) {
            return res.status(403).json({ error: 'Playback is not allowed.', code: 'no_playback_permission' });
        }

        const videoCache = require('../../services/cache/videoCache');
        const courseCache = require('../../services/cache/courseCache');
        const enrollmentCache = require('../../services/cache/enrollmentCache');

        const video = await videoCache.getVideoMeta(videoId);
        if (!video || video.status !== 'finished') {
            return res.status(404).json({ error: 'Video not found or not ready.', code: 'video_not_found' });
        }

        if (!user.permissions.allCourseAccess) {
            const enrolled = await enrollmentCache.isEnrolledInCourse(user.user_id, video.course_id);
            if (!enrolled) {
                return res.status(403).json({ error: 'You are not enrolled in this course.', code: 'no_course_enrollment' });
            }
        }

        const course = await courseCache.getCourseMeta(video.course_id);

        const publicDomain = process.env.R2_PUBLIC_DOMAIN;
        const basePath = `/${video.hashed_video_id}/${video.processing_job_id}/`;
        const videoType = video.video_type || 'ts';

        const hmacToken = await generateToken(basePath);
        const tokenValiditySeconds = await getTokenValiditySeconds();

        // Per-file poster token for Media Session artwork (iOS Dynamic
        // Island, Android notification shade). Only minted when the video
        // actually has a poster; the watch page just omits the artwork
        // entry from MediaMetadata when this comes back null/empty.
        // Path is `/posters/{course_id}/{video_id}.jpg` — the client
        // reconstructs the URL from the values it already has on
        // res.json.video below, so we don't ship posterPath.
        let posterToken = null;
        if (video.has_poster) {
            const posterPath = `/posters/${video.course_id}/${video.video_id}.jpg`;
            posterToken = await generateFileToken(posterPath);
        }

        // Resume position rules:
        //   1. Videos shorter than 120s always restart from the beginning —
        //      a "resume" 5–10s into a 60s video is more annoying than useful.
        //   2. The existing 5% / 90% guard rails still apply: positions in
        //      the opening intro (< 5%) or the outro (> 90%) round to "play
        //      from the start" / "let it auto-advance," respectively.
        //   3. Within the qualifying band we resume 3s before the last
        //      reported position. The position we record on pause and on
        //      page-hide is the exact frame the user quit at, so resuming
        //      there feels jarring — replaying the last 3s gives them a
        //      bit of context to catch up without manually rewinding.
        let resumePosition = 0;
        if (video.duration_seconds && video.duration_seconds >= 120) {
            const watchProgressCache = require('../../services/cache/watchProgressCache');
            let pos = await watchProgressCache.getLastPosition(user.user_id, videoId);
            if (pos === null) {
                const [watchRows] = await pool.execute(
                    'SELECT last_position FROM watch_progress WHERE user_id = ? AND video_id = ?',
                    [idBuf(user.user_id),videoId]
                );
                if (watchRows.length > 0) pos = watchRows[0].last_position;
            }
            if (pos !== null) {
                const duration = video.duration_seconds;
                if (pos > duration * 0.05 && pos < duration * 0.90) {
                    resumePosition = Math.max(0, pos - 3);
                }
            }
        }

        res.json({
            video: {
                video_id: video.video_id,
                title: video.title,
                description: video.description,
                module_number: video.module_number,
                lecture_date: video.lecture_date,
                duration_seconds: video.duration_seconds,
                course_id: video.course_id,
                course_code: course ? course.course_code : null,
                course_name: course ? course.course_name : null,
                module_label: course ? course.module_label : null,
            },
            // Client constructs the manifest URL itself: pick master.m3u8 or
            // manifest.mpd based on videoType + UA, then prepend
            // `https://${r2PublicDomain}` and append `?verify=${hmacToken}`.
            // Server returns the building blocks rather than two pre-built
            // URLs so the bundle decides HLS vs DASH locally — no UA sniffing
            // needed on the server.
            videoPath: basePath,
            videoType,
            resumePosition,
            hmacToken: hmacToken || '',
            r2PublicDomain: publicDomain || '',
            tokenValiditySeconds,
            posterToken: posterToken || '',
        });
    } catch (err) {
        console.error('API watch error:', err);
        res.status(500).json({ error: 'Failed to load video.' });
    }
});

// GET /api/profile — user profile + sessions
router.get('/profile', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const profile = await getUserById(user.user_id);
        const sessions = await getUserSessions(user.user_id);

        const sanitizedSessions = sessions.map(s => ({
            deviceName: formatUserAgent(s.user_agent),
            isCurrent: s.session_id === user.session_id,
            ip_address: s.ip_address,
            last_seen: s.last_seen,
            last_sign_in: s.last_sign_in,
        }));

        res.json({
            profile: {
                user_id: profile.user_id,
                username: profile.username,
                display_name: profile.display_name,
                avatar: profile.sso_avatar || null,
                maskedEmail: profile.email ? maskEmail(profile.email) : null,
                hasEmail: !!profile.email,
                role_name: profile.role_name || 'user',
                created_at: profile.created_at,
            },
            sessions: sanitizedSessions,
        });
    } catch (err) {
        console.error('API profile error:', err);
        res.status(500).json({ error: 'Failed to load profile.' });
    }
});

// POST /api/profile/sessions/terminate-all — terminate all other sessions
router.post('/profile/sessions/terminate-all', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        await deleteUserSessions(user.user_id, user.session_id);
        res.json({ success: true, message: 'All other sessions terminated' });
    } catch (err) {
        console.error('API terminate all sessions error:', err);
        res.status(500).json({ error: 'Failed to terminate sessions' });
    }
});

// GET /api/profile/security — security overview for profile page
router.get('/profile/security', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const pool = getPool();

        const mfaEnabled = await isUserMfaEnabled(user.user_id);
        const methods = await getUserMfaMethods(user.user_id);

        const [[userRow]] = await pool.execute(
            'SELECT email FROM users WHERE user_id = ?',
            [idBuf(user.user_id)]
        );

        const hasEmail = !!(userRow && userRow.email);

        res.json({
            mfaEnabled,
            methods: methods.map(m => ({
                id: m.id,
                method_type: m.method_type,
                label: m.label,
                created_at: m.created_at,
            })),
            hasEmail,
            maskedEmail: hasEmail ? maskEmail(userRow.email) : null,
        });
    } catch (err) {
        console.error('API profile/security error:', err);
        res.status(500).json({ error: 'Failed to load security info' });
    }
});

module.exports = router;
