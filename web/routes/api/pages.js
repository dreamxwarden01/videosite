const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { getPool } = require('../../config/database');
const { getUserById, verifyPassword, updateUser } = require('../../services/userService');
const { getUserSessions, deleteUserSessions } = require('../../config/session');
const { generateToken, getTokenValiditySeconds } = require('../../services/tokenService');
const mfaService = require('../../services/mfaService');
const { getUserMfaMethods, isUserMfaEnabled, maskEmail, validateChallenge, consumeChallenge } = mfaService;
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
        const pool = getPool();
        const user = res.locals.user;
        let courses;

        if (user.permissions.allCourseAccess) {
            const [rows] = await pool.execute(
                `SELECT c.*,
                    (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) as video_count,
                    (SELECT MAX(COALESCE(v.updated_at, v.created_at)) FROM videos v WHERE v.course_id = c.course_id) as last_video_at
                 FROM courses c WHERE c.is_active = 1 ORDER BY c.course_name ASC`
            );
            courses = rows;
        } else {
            const [rows] = await pool.execute(
                `SELECT c.*,
                    (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) as video_count,
                    (SELECT MAX(COALESCE(v.updated_at, v.created_at)) FROM videos v WHERE v.course_id = c.course_id) as last_video_at
                 FROM courses c
                 JOIN enrollments e ON c.course_id = e.course_id
                 WHERE e.user_id = ? AND c.is_active = 1
                 ORDER BY c.course_name ASC`,
                [user.user_id]
            );
            courses = rows;
        }

        res.json({
            courses: courses.map(c => ({
                course_id: c.course_id,
                course_name: c.course_name,
                description: c.description,
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
        const ALLOWED_LIMITS = [10, 20, 50];
        const rawLimit = parseInt(req.query.limit);
        const limit = ALLOWED_LIMITS.includes(rawLimit) ? rawLimit : 10;
        const offset = (page - 1) * limit;

        const courseCache = require('../../services/cache/courseCache');
        const enrollmentCache = require('../../services/cache/enrollmentCache');

        const course = await courseCache.getCourseMeta(courseId);
        if (!course || course.is_active !== 1) {
            return res.status(404).json({ error: 'Course not found.' });
        }

        // Check course access
        if (!user.permissions.allCourseAccess) {
            const enrolled = await enrollmentCache.isEnrolledInCourse(user.user_id, courseId);
            if (!enrolled) {
                return res.status(403).json({ error: 'You are not enrolled in this course.' });
            }
        }

        const [countRows] = await pool.execute(
            'SELECT COUNT(*) as total FROM videos WHERE course_id = ?',
            [courseId]
        );

        const lim = parseInt(limit);
        const off = parseInt(offset);
        const [videos] = await pool.execute(
            `SELECT * FROM videos WHERE course_id = ?
             ORDER BY (week IS NULL) ASC, CAST(week AS UNSIGNED) ASC,
                      (lecture_date IS NULL) ASC, lecture_date ASC,
                      created_at ASC
             LIMIT ${lim} OFFSET ${off}`,
            [courseId]
        );
        await require('../../services/cache/transcodeProgressCache').applyLiveOverlayToVideos(videos);

        const total = countRows[0].total;

        res.json({
            course: {
                course_id: course.course_id,
                course_name: course.course_name,
                description: course.description,
                is_active: course.is_active,
            },
            videos: videos.map(v => ({
                video_id: v.video_id,
                course_id: v.course_id,
                title: v.title,
                description: v.description,
                week: v.week,
                lecture_date: v.lecture_date,
                duration_seconds: v.duration_seconds,
                status: v.status,
                processing_progress: v.processing_progress,
            })),
            pagination: {
                page,
                totalPages: Math.ceil(total / limit) || 1,
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
        let hlsUrl = `https://${publicDomain}${basePath}master.m3u8`;
        let dashUrl = null;

        const hmacToken = await generateToken(basePath);
        const tokenValiditySeconds = await getTokenValiditySeconds();
        if (hmacToken) {
            hlsUrl += `?verify=${encodeURIComponent(hmacToken)}`;
        }

        // CMAF videos also expose a DASH manifest for Shaka on non-Apple clients.
        // WatchPage picks between hlsUrl and dashUrl based on UA.
        if (videoType === 'cmaf') {
            dashUrl = `https://${publicDomain}${basePath}manifest.mpd`;
            if (hmacToken) {
                dashUrl += `?verify=${encodeURIComponent(hmacToken)}`;
            }
        }

        let resumePosition = 0;
        const watchProgressCache = require('../../services/cache/watchProgressCache');
        let pos = await watchProgressCache.getLastPosition(user.user_id, videoId);
        if (pos === null) {
            const [watchRows] = await pool.execute(
                'SELECT last_position FROM watch_progress WHERE user_id = ? AND video_id = ?',
                [user.user_id, videoId]
            );
            if (watchRows.length > 0) pos = watchRows[0].last_position;
        }
        if (pos !== null && video.duration_seconds) {
            const duration = video.duration_seconds;
            if (pos > duration * 0.05 && pos < duration * 0.90) {
                resumePosition = pos;
            }
        }

        res.json({
            video: {
                video_id: video.video_id,
                title: video.title,
                description: video.description,
                week: video.week,
                lecture_date: video.lecture_date,
                duration_seconds: video.duration_seconds,
                course_id: video.course_id,
                course_name: course ? course.course_name : null,
            },
            hlsUrl,
            dashUrl,
            videoType,
            resumePosition,
            hmacToken: hmacToken || '',
            r2PublicDomain: publicDomain || '',
            tokenValiditySeconds,
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
                maskedEmail: profile.email ? maskEmail(profile.email) : null,
                hasEmail: !!profile.email,
                role_name: profile.role_name || 'user',
                created_at: profile.created_at,
            },
            sessions: sanitizedSessions,
            canChangePassword: user.permissions.changeOwnPassword,
        });
    } catch (err) {
        console.error('API profile error:', err);
        res.status(500).json({ error: 'Failed to load profile.' });
    }
});

// PUT /api/profile/display-name — change display name (no verification needed)
router.put('/profile/display-name', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const { displayName } = req.body;

        if (!displayName || typeof displayName !== 'string' || !displayName.trim()) {
            return res.status(422).json({ error: 'Display name is required' });
        }
        const trimmed = displayName.trim();
        if (trimmed.length > 30) {
            return res.status(422).json({ error: 'Display name must be 30 characters or fewer' });
        }
        if (!/^[A-Za-z0-9 ]+$/.test(trimmed)) {
            return res.status(422).json({ error: 'Display name can only contain letters, digits, and spaces' });
        }

        await updateUser(user.user_id, { display_name: trimmed });
        res.status(204).end();
    } catch (err) {
        console.error('API display name change error:', err);
        res.status(500).json({ error: 'Failed to update display name' });
    }
});

// POST /api/profile/password — change own password
router.post('/profile/password', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        if (!user.permissions.changeOwnPassword) {
            return res.status(403).json({ error: 'Permission denied' });
        }

        const { currentPassword, newPassword, confirmPassword } = req.body;

        if (!currentPassword || !newPassword || !confirmPassword) {
            return res.status(422).json({ error: 'All fields are required' });
        }
        if (/\s/.test(currentPassword) || /\s/.test(newPassword) || /\s/.test(confirmPassword)) {
            return res.status(422).json({ error: 'Spaces are not allowed in passwords' });
        }
        if (newPassword !== confirmPassword) {
            return res.status(422).json({ error: 'New passwords do not match' });
        }
        if (newPassword.length < 8) {
            return res.status(422).json({ error: 'Password must be at least 8 characters' });
        }

        const fullUser = await getUserById(user.user_id);
        const valid = await verifyPassword(fullUser.password_hash, currentPassword);
        if (!valid) {
            return res.status(422).json({ error: 'Current password is incorrect' });
        }

        await updateUser(user.user_id, { password: newPassword });
        // Track password change timestamp
        const pool = require('../config/database').getPool();
        await pool.execute('UPDATE users SET password_changed_at = NOW() WHERE user_id = ?', [user.user_id]);
        await deleteUserSessions(user.user_id, user.session_id);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
        console.error('API password change error:', err);
        res.status(500).json({ error: 'Failed to change password' });
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
            'SELECT email, password_changed_at FROM users WHERE user_id = ?',
            [user.user_id]
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
            requireMFA: !!user.permissions.requireMFA,
            hasEmail,
            maskedEmail: hasEmail ? maskEmail(userRow.email) : null,
            passwordChangedAt: userRow ? userRow.password_changed_at : null,
        });
    } catch (err) {
        console.error('API profile/security error:', err);
        res.status(500).json({ error: 'Failed to load security info' });
    }
});

// POST /api/profile/email/preflight — check what identity verification is needed
router.post('/profile/email/preflight', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const pool = getPool();

        const [[userRow]] = await pool.execute(
            'SELECT email, mfa_enabled FROM users WHERE user_id = ?',
            [user.user_id]
        );
        const hasExistingEmail = !!(userRow && userRow.email);
        const mfaEnabled = !!(userRow && userRow.mfa_enabled);

        if (mfaEnabled) {
            const bmfaToken = await mfaService.ensureBmfa(req, res);

            // Check for existing verified, unconsumed, one-time challenge
            const [[existing]] = await pool.execute(
                `SELECT id FROM mfa_challenges
                 WHERE user_id = ? AND context_type = 'bmfa' AND context_id = ?
                   AND status = 'verified' AND can_reuse = 0 AND mfa_level >= 0
                   AND message_type = 'email_verification' AND message_operation = 'email_change_identity'
                   AND expires_at > NOW()
                 LIMIT 1`,
                [user.user_id, bmfaToken]
            );

            if (existing) {
                return res.json({ needsChallenge: false, existingChallengeId: existing.id });
            }

            // Check user has usable MFA methods
            const userMethods = await mfaService.getUserMfaMethodTypes(user.user_id);
            const allowedMethods = mfaService.getAllowedMethodsForLevel(0);
            const overlap = userMethods.filter(m => allowedMethods.includes(m));
            if (overlap.length === 0) {
                return res.status(422).json({ error: 'No MFA methods available. Please set up MFA first.' });
            }

            // Create new pending challenge
            const challenge = await mfaService.createChallenge({
                userId: user.user_id,
                contextType: 'bmfa',
                contextId: bmfaToken,
                mfaLevel: 0,
                messageType: 'email_verification',
                messageOperation: 'email_change_identity',
                canReuse: false,
            });

            // Filter methods to what user actually has
            const filteredMethods = challenge.allowedMethods.filter(m => {
                if (m === 'email') return hasExistingEmail;
                return userMethods.includes(m);
            });

            const maskedEmailValue = hasExistingEmail ? maskEmail(userRow.email) : null;

            return res.json({
                needsChallenge: true,
                challengeId: challenge.id,
                allowedMethods: filteredMethods,
                maskedEmail: maskedEmailValue,
                pendingTtlSeconds: challenge.pendingTtlSeconds,
            });
        }

        // No MFA
        if (hasExistingEmail) {
            return res.json({ needsChallenge: false, needsPassword: true });
        }
        return res.json({ needsChallenge: false, needsPassword: false });
    } catch (err) {
        console.error('API profile/email/preflight error:', err);
        res.status(500).json({ error: 'Failed to check email change requirements' });
    }
});

// POST /api/profile/email/start — begin email change flow
router.post('/profile/email/start', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const pool = getPool();
        const { email, currentPassword } = req.body;

        // Validate email format
        if (!email || typeof email !== 'string') {
            return res.status(422).json({ error: 'Email is required' });
        }
        if (/\s/.test(email)) {
            return res.status(422).json({ error: 'Spaces are not allowed in email' });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(422).json({ error: 'Invalid email format' });
        }

        const normalizedEmail = email.toLowerCase();

        // Check email not already used by another user
        const [[existing]] = await pool.execute(
            'SELECT user_id FROM users WHERE email = ? AND user_id != ?',
            [normalizedEmail, user.user_id]
        );
        if (existing) {
            return res.status(422).json({ error: 'Email is already in use' });
        }

        // Check email not in a pending registration (within link validity)
        const [[pendingReg]] = await pool.execute(
            `SELECT email FROM pending_registrations WHERE email = ?
             AND created_at >= DATE_SUB(NOW(), INTERVAL CAST(COALESCE(
                 (SELECT setting_value FROM site_settings WHERE setting_key = 'emailed_link_validity_minutes'), '30'
             ) AS UNSIGNED) MINUTE)`,
            [normalizedEmail]
        );
        if (pendingReg) {
            return res.status(422).json({ error: 'Email is already in use' });
        }

        // Get current user state
        const [[userRow]] = await pool.execute(
            'SELECT email, mfa_enabled FROM users WHERE user_id = ?',
            [user.user_id]
        );
        const hasExistingEmail = !!(userRow && userRow.email);
        const mfaEnabled = !!(userRow && userRow.mfa_enabled);

        if (hasExistingEmail && mfaEnabled) {
            // Require MFA challenge via X-MFA-Challenge header
            const challengeId = req.headers['x-mfa-challenge'];
            if (!challengeId) {
                return res.status(403).json({ error: 'MFA verification required' });
            }
            const bmfaTokenForValidation = await mfaService.ensureBmfa(req, res);
            const validation = await validateChallenge(challengeId, user.user_id, bmfaTokenForValidation, 0);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge' });
            }
            // Challenge validated but NOT consumed — deferred to /confirm
        } else if (hasExistingEmail) {
            // Require current password
            if (!currentPassword) {
                return res.status(422).json({ error: 'Current password is required' });
            }
            const fullUser = await getUserById(user.user_id);
            const valid = await verifyPassword(fullUser.password_hash, currentPassword);
            if (!valid) {
                return res.status(422).json({ error: 'Current password is incorrect' });
            }
        }
        // If no existing email, no verification needed

        // Create email verification challenge
        const bmfaToken = await mfaService.ensureBmfa(req, res);
        const challenge = await mfaService.createChallenge({
            userId: user.user_id,
            contextType: 'bmfa',
            contextId: bmfaToken,
            mfaLevel: 0,
            messageType: 'email_verification',
            messageOperation: normalizedEmail,
            canReuse: false,
        });

        // Send OTP to the NEW email
        const sendResult = await mfaService.sendOtpToEmail(challenge.id, user.user_id, normalizedEmail);
        if (!sendResult.success) {
            if (sendResult.retryAfter || sendResult.message === 'Daily limit reached') {
                return res.status(429).json({ error: sendResult.message, retryAfter: sendResult.retryAfter || null });
            }
            return res.status(503).json({ error: sendResult.message || 'Failed to send verification email' });
        }

        // Mask email for response
        const atIdx = normalizedEmail.indexOf('@');
        const local = normalizedEmail.substring(0, atIdx);
        const domain = normalizedEmail.substring(atIdx);
        const maskedNewEmail = local.length < 3
            ? local.charAt(0) + '*'.repeat(Math.max(0, local.length - 1)) + domain
            : local.substring(0, 2) + '*'.repeat(local.length - 2) + domain;

        res.json({ success: true, challengeId: challenge.id, maskedNewEmail });
    } catch (err) {
        console.error('API profile/email/start error:', err);
        res.status(500).json({ error: 'Failed to start email change' });
    }
});

// POST /api/profile/email/confirm — confirm email change with OTP
router.post('/profile/email/confirm', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const pool = getPool();
        const { challengeId, code, mfaChallengeId } = req.body;

        if (!challengeId || !code) {
            return res.status(422).json({ error: 'Challenge ID and code are required' });
        }

        // If user has MFA enabled, require the MFA identity challenge
        const [[mfaCheck]] = await pool.execute(
            'SELECT mfa_enabled, email FROM users WHERE user_id = ?',
            [user.user_id]
        );
        if (mfaCheck?.mfa_enabled && mfaCheck?.email) {
            if (!mfaChallengeId) {
                return res.status(403).json({ error: 'MFA verification required' });
            }
            const bmfaToken = await mfaService.ensureBmfa(req, res);
            const validation = await validateChallenge(mfaChallengeId, user.user_id, bmfaToken, 0);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge' });
            }
        }

        const result = await mfaService.verifyOtp(challengeId, code);
        if (!result.valid) {
            const errorResponse = { error: result.reason || 'Invalid code' };
            if (result.mustResend !== undefined) errorResponse.mustResend = result.mustResend;
            if (result.attemptsRemaining !== undefined) errorResponse.attemptsRemaining = result.attemptsRemaining;
            return res.status(422).json(errorResponse);
        }

        // Read the challenge to get message_operation (the new email)
        const challenge = await mfaService.getChallenge(challengeId);
        if (!challenge || challenge.user_id !== user.user_id) {
            return res.status(403).json({ error: 'Invalid challenge' });
        }

        const newEmail = challenge.message_operation;
        if (!newEmail) {
            return res.status(400).json({ error: 'No email found in challenge' });
        }

        // Update user email
        await pool.execute(
            'UPDATE users SET email = ? WHERE user_id = ?',
            [newEmail, user.user_id]
        );
        await require('../../services/cache/userCache').invalidate(user.user_id);

        // Consume OTP challenge
        await mfaService.consumeChallenge(challengeId);

        // Consume the MFA identity challenge if one was used
        if (mfaChallengeId) {
            await consumeChallenge(mfaChallengeId);
            const bmfaToken = await mfaService.ensureBmfa(req, res);
            await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('API profile/email/confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm email change' });
    }
});

// POST /api/profile/email/resend — resend email verification OTP
router.post('/profile/email/resend', requireAuth, async (req, res) => {
    try {
        const user = res.locals.user;
        const { challengeId } = req.body;

        if (!challengeId) {
            return res.status(422).json({ error: 'Challenge ID is required' });
        }

        // Get challenge and verify it belongs to user
        const challenge = await mfaService.getChallenge(challengeId);
        if (!challenge || challenge.user_id !== user.user_id) {
            return res.status(403).json({ error: 'Invalid challenge' });
        }

        const result = await mfaService.sendOtpToEmail(challengeId, user.user_id, challenge.message_operation);
        if (!result.success) {
            if (result.retryAfter || result.message === 'Daily limit reached') {
                return res.status(429).json({
                    error: result.message,
                    retryAfter: result.retryAfter || null,
                });
            }
            return res.status(503).json({ error: result.message || 'Failed to send code' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('API profile/email/resend error:', err);
        res.status(500).json({ error: 'Failed to resend verification email' });
    }
});

module.exports = router;
