const express = require('express');
const router = express.Router();

// Middleware
const { requireAuth } = require('../../middleware/auth');
const { checkPermission, checkPermissionLevel, checkAnyPermission } = require('../../middleware/permissions');
const { requireMfaForScenario } = require('../../middleware/mfa');

// Services - Courses
const { createCourse, getCourseById, updateCourse, deleteCourse, listCourses } = require('../../services/courseService');
const { listCourseVideos } = require('../../services/videoService');

// Services - Users
const { createUser, getUserById, updateUser, deleteUser, listUsers, usernameExists, emailExists } = require('../../services/userService');
const { getAssignableRoles } = require('../../services/roleService');
const { ALL_PERMISSIONS, getUserOverrides, setUserOverride, getRolePermissions, setRolePermissions } = require('../../services/permissionService');
const { deleteUserSessions, getUserSessions } = require('../../config/session');
const UAParser = require('ua-parser-js');

// Services - Enrollment
const { addEnrollment, removeEnrollment, getAllUsersWithEnrollment, isEnrolled } = require('../../services/enrollmentService');

// Services - Roles
const { listRoles, getRoleById, createRole, updateRole, deleteRole, roleIdExists, roleNameExists, permissionLevelExists } = require('../../services/roleService');

// Services - Settings
const { getPool } = require('../../config/database');
const { generateWorkerKeyPair, revokeWorkerKey, deleteWorkerKey, listWorkerKeys } = require('../../services/workerAuthService');
const { generateSecretKey, isHmacConfigured, setSetting } = require('../../services/tokenService');

// Services - Transcoding Profiles
const { getGlobalProfiles, getCourseProfiles, saveGlobalProfiles, saveCourseProfiles, deleteCourseProfiles, getAudioNormalizationSettings, saveAudioNormalizationSettings, validateProfile } = require('../../services/transcodingProfileService');

// Services - Invitations
const { generateInvitationCode, listInvitationCodes, removeInvitationCode } = require('../../services/registrationService');

// Services - MFA
const mfaService = require('../../services/mfaService');

// Helper: format UA string (from users routes)
function formatUserAgent(ua) {
    if (!ua) return 'Unknown';
    const parsed = UAParser(ua);
    const browser = parsed.browser.name || 'Unknown browser';
    const browserVer = parsed.browser.version ? ' ' + parsed.browser.version : '';
    const os = parsed.os.name || 'Unknown OS';
    const osVer = parsed.os.version ? ' ' + parsed.os.version : '';
    return `${browser}${browserVer} on ${os}${osVer}`;
}

// Helper: block self-targeting on admin mutation endpoints
function blockSelfTarget(req, res) {
    if (parseInt(req.params.id) === res.locals.user.user_id) {
        res.status(403).json({ error: 'Cannot modify your own account through admin panel' });
        return true;
    }
    return false;
}

// Helper: require enrollment or allCourseAccess for course endpoints
function requireCourseAccess(req, res, next) {
    if (res.locals.user.permissions.allCourseAccess) return next();
    isEnrolled(res.locals.user.user_id, req.params.courseId).then(enrolled => {
        if (!enrolled) return res.status(403).json({ error: 'You do not have access to this course' });
        next();
    }).catch(err => {
        console.error('Course access check error:', err);
        res.status(500).json({ error: 'Failed to verify course access' });
    });
}

// ==========================================================================
//  COURSES
// ==========================================================================

// GET /api/admin/courses — paginated list
router.get('/admin/courses', requireAuth, checkPermission('manageCourse'), requireMfaForScenario('course'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const result = await listCourses(page);
        res.json(result);
    } catch (err) {
        console.error('API admin courses error:', err);
        res.status(500).json({ error: 'Failed to load courses.' });
    }
});

// POST /api/admin/courses — create
router.post('/admin/courses', requireAuth, checkPermission('addCourse'), requireMfaForScenario('course'), async (req, res) => {
    try {
        const { courseName, description } = req.body;
        if (!courseName) {
            return res.status(400).json({ error: 'Course name is required' });
        }

        const { courseId } = await createCourse(courseName, description, res.locals.user.user_id);
        res.json({ success: true, courseId });
    } catch (err) {
        console.error('API create course error:', err);
        res.status(500).json({ error: 'Failed to create course: ' + err.message });
    }
});

// Sanitize video objects for admin responses — strip encryption keys and other secrets
function sanitizeAdminVideo(v) {
    return {
        video_id: v.video_id,
        course_id: v.course_id,
        title: v.title,
        description: v.description,
        week: v.week,
        lecture_date: v.lecture_date,
        duration_seconds: v.duration_seconds,
        original_filename: v.original_filename,
        file_size_bytes: v.file_size_bytes,
        status: v.status,
        processing_job_id: v.processing_job_id,
        processing_progress: v.processing_progress,
        processing_error: v.processing_error,
        has_source: !!v.r2_source_key,
        created_at: v.created_at,
        updated_at: v.updated_at,
    };
}

// GET /api/admin/courses/:courseId — single course + videos
router.get('/admin/courses/:courseId', requireAuth, checkPermission('changeCourse'), requireMfaForScenario('course'), requireCourseAccess, async (req, res) => {
    try {
        const course = await getCourseById(req.params.courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found.' });
        }

        const videoResult = await listCourseVideos(req.params.courseId, 1, 100);

        res.json({ course, videos: videoResult.videos.map(sanitizeAdminVideo) });
    } catch (err) {
        console.error('API get course error:', err);
        res.status(500).json({ error: 'Failed to load course.' });
    }
});

// GET /api/admin/courses/:courseId/edit — course + profiles + audio normalization
router.get('/admin/courses/:courseId/edit', requireAuth, checkPermission('changeCourse'), requireMfaForScenario('course'), requireCourseAccess, async (req, res) => {
    try {
        const course = await getCourseById(req.params.courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found.' });
        }
        const videoResult = await listCourseVideos(req.params.courseId, 1, 100);
        const globalProfiles = await getGlobalProfiles();
        const courseProfiles = course.use_custom_profiles ? await getCourseProfiles(req.params.courseId) : [];
        const audioNormalization = await getAudioNormalizationSettings();
        res.json({ course, videos: videoResult.videos.map(sanitizeAdminVideo), globalProfiles, courseProfiles, audioNormalization });
    } catch (err) {
        console.error('API get course edit error:', err);
        res.status(500).json({ error: 'Failed to load course.' });
    }
});

// PUT /api/admin/courses/:courseId — update
router.put('/admin/courses/:courseId', requireAuth, checkPermission('changeCourse'), requireMfaForScenario('course'), requireCourseAccess, async (req, res) => {
    try {
        const { courseName, description, is_active, use_custom_profiles, audio_normalization } = req.body;
        const updates = {
            course_name: courseName,
            description,
            is_active: is_active === '1' || is_active === true || is_active === 1 ? 1 : 0
        };
        if (use_custom_profiles !== undefined) updates.use_custom_profiles = use_custom_profiles ? 1 : 0;
        if (audio_normalization !== undefined) updates.audio_normalization = audio_normalization ? 1 : 0;
        await updateCourse(req.params.courseId, updates);
        res.status(204).end();
    } catch (err) {
        console.error('API update course error:', err);
        res.status(500).json({ error: 'Failed to update course' });
    }
});

// DELETE /api/admin/courses/:courseId — delete
router.delete('/admin/courses/:courseId', requireAuth, checkPermission('deleteCourse'), requireMfaForScenario('course'), requireCourseAccess, async (req, res) => {
    try {
        await deleteCourse(req.params.courseId);
        res.status(204).end();
    } catch (err) {
        console.error('API delete course error:', err);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

// PUT /api/admin/courses/:courseId/transcoding-profiles — save course profiles
router.put('/admin/courses/:courseId/transcoding-profiles', requireAuth, checkPermission('changeCourse'), requireMfaForScenario('course'), requireCourseAccess, async (req, res) => {
    try {
        const course = await getCourseById(req.params.courseId);
        if (!course) return res.status(404).json({ error: 'Course not found' });
        if (!course.use_custom_profiles) return res.status(400).json({ error: 'Course is using global profiles' });

        const { profiles } = req.body;
        if (!Array.isArray(profiles) || profiles.length === 0) {
            return res.status(400).json({ error: 'At least one profile is required' });
        }
        for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            const parsed = {
                name: (p.name || '').trim(),
                width: parseInt(p.width, 10),
                height: parseInt(p.height, 10),
                video_bitrate_kbps: parseInt(p.video_bitrate_kbps, 10),
                audio_bitrate_kbps: parseInt(p.audio_bitrate_kbps, 10),
                segment_duration: p.segment_duration !== undefined ? parseInt(p.segment_duration, 10) : 6,
                gop_size: p.gop_size !== undefined ? parseInt(p.gop_size, 10) : 48
            };
            const errors = validateProfile(parsed);
            if (errors.length > 0) {
                return res.status(400).json({ error: `Profile ${i + 1}: ${errors.join(', ')}` });
            }
            profiles[i] = { ...p, ...parsed };
        }

        await saveCourseProfiles(req.params.courseId, profiles);
        res.status(204).end();
    } catch (err) {
        console.error('API save course profiles error:', err);
        res.status(500).json({ error: 'Failed to save course profiles' });
    }
});

// DELETE /api/admin/courses/:courseId/transcoding-profiles — reset to global
router.delete('/admin/courses/:courseId/transcoding-profiles', requireAuth, checkPermission('changeCourse'), requireMfaForScenario('course'), requireCourseAccess, async (req, res) => {
    try {
        await deleteCourseProfiles(req.params.courseId);
        res.status(204).end();
    } catch (err) {
        console.error('API delete course profiles error:', err);
        res.status(500).json({ error: 'Failed to reset course profiles' });
    }
});

// ==========================================================================
//  VIDEOS (Video Management page)
// ==========================================================================

// GET /api/admin/videos/:courseId — paginated video list for a course
router.get('/admin/videos/:courseId', requireAuth, checkAnyPermission('uploadVideo', 'changeVideo'), requireCourseAccess, async (req, res) => {
    try {
        const pool = getPool();
        const courseId = req.params.courseId;

        // Verify course exists and is active
        const [courseRows] = await pool.execute(
            'SELECT course_id, course_name FROM courses WHERE course_id = ? AND is_active = 1',
            [courseId]
        );
        if (courseRows.length === 0) {
            return res.status(404).json({ error: 'Course not found.' });
        }

        const page = parseInt(req.query.page) || 1;
        const allowedLimits = [10, 20, 50];
        const limit = allowedLimits.includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 10;
        const offset = (page - 1) * limit;

        const [countRows] = await pool.execute(
            'SELECT COUNT(*) as total FROM videos WHERE course_id = ?',
            [courseId]
        );
        const total = countRows[0].total;

        const [videos] = await pool.execute(
            `SELECT * FROM videos WHERE course_id = ?
             ORDER BY CAST(week AS UNSIGNED) DESC, week DESC, lecture_date DESC, created_at DESC, video_id DESC
             LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`,
            [courseId]
        );

        res.json({
            course: { course_id: courseRows[0].course_id, course_name: courseRows[0].course_name },
            videos: videos.map(sanitizeAdminVideo),
            total,
            page,
            totalPages: Math.ceil(total / limit)
        });
    } catch (err) {
        console.error('API admin videos error:', err);
        res.status(500).json({ error: 'Failed to load videos.' });
    }
});

// ==========================================================================
//  USERS
// ==========================================================================

// GET /api/admin/users — paginated list
router.get('/admin/users', requireAuth, checkPermission('manageUser'), requireMfaForScenario('user'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const result = await listUsers(res.locals.user.permission_level, page);
        res.json(result);
    } catch (err) {
        console.error('API admin users error:', err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

// GET /api/admin/users/new — form data for creating a user
router.get('/admin/users/new', requireAuth, checkPermission('addUser'), requireMfaForScenario('user'), async (req, res) => {
    try {
        const roles = await getAssignableRoles(res.locals.user.permission_level);
        const pool = getPool();
        const [[row]] = await pool.execute("SELECT setting_value FROM site_settings WHERE setting_key = 'registration_default_role'");
        const defaultRoleId = row ? row.setting_value : '2';
        res.json({ roles, defaultRoleId });
    } catch (err) {
        console.error('API new user form error:', err);
        res.status(500).json({ error: 'Failed to load form.' });
    }
});

// POST /api/admin/users — create
router.post('/admin/users', requireAuth, checkPermission('addUser'), requireMfaForScenario('user'), async (req, res) => {
    try {
        const { username, displayName, email, password, roleId } = req.body;

        if (!username || !password || !displayName) {
            return res.status(400).json({ error: 'Username, display name, and password are required' });
        }

        // Username: 3-20 chars, letters/digits/dashes/underscores
        const trimmedUsername = username.trim();
        if (trimmedUsername.length < 3 || trimmedUsername.length > 20) {
            return res.status(422).json({ error: 'Username must be between 3 and 20 characters' });
        }
        if (!/^[A-Za-z0-9_-]+$/.test(trimmedUsername)) {
            return res.status(422).json({ error: 'Username can only contain letters, digits, dashes, and underscores' });
        }

        if (await usernameExists(trimmedUsername)) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        // Display name: 1-30 chars, letters/digits/spaces
        const trimmedDisplayName = displayName.trim();
        if (!trimmedDisplayName || trimmedDisplayName.length > 30) {
            return res.status(422).json({ error: 'Display name must be between 1 and 30 characters' });
        }
        if (!/^[A-Za-z0-9 ]+$/.test(trimmedDisplayName)) {
            return res.status(422).json({ error: 'Display name can only contain letters, digits, and spaces' });
        }

        // Email format and uniqueness
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return res.status(422).json({ error: 'Invalid email address format' });
        }
        if (email) {
            const normalizedEmail = email.trim().toLowerCase();
            if (await emailExists(normalizedEmail)) {
                return res.status(409).json({ error: 'Email is already in use' });
            }
        }

        // Verify the selected role is assignable by this user
        const roles = await getAssignableRoles(res.locals.user.permission_level);
        const selectedRole = parseInt(roleId) || 2;
        const validRole = roles.find(r => r.role_id === selectedRole);
        if (!validRole) {
            return res.status(403).json({ error: 'Cannot assign that role' });
        }

        const userId = await createUser(trimmedUsername, trimmedDisplayName, password, selectedRole, email ? email.trim() : null);
        res.status(201).json({ userId });
    } catch (err) {
        console.error('API create user error:', err);
        res.status(500).json({ error: 'Failed to create user: ' + err.message });
    }
});

// GET /api/admin/users/:id — single user + roles + overrides
router.get('/admin/users/:id', requireAuth, checkPermission('changeUser'), requireMfaForScenario('user'), checkPermissionLevel, async (req, res) => {
    try {
        const targetUser = await getUserById(parseInt(req.params.id));
        if (!targetUser) {
            return res.status(404).json({ error: 'User not found.' });
        }
        delete targetUser.password_hash;

        const roles = await getAssignableRoles(res.locals.user.permission_level);
        const overrides = await getUserOverrides(targetUser.user_id);

        res.json({
            targetUser,
            roles,
            overrides,
            allPermissions: ALL_PERMISSIONS,
            canChangePermissions: res.locals.user.permissions.changeUserPermission,
            adminPermissions: res.locals.user.permissions
        });
    } catch (err) {
        console.error('API get user error:', err);
        res.status(500).json({ error: 'Failed to load user.' });
    }
});

// GET /api/admin/users/:id/edit — alias for edit page
router.get('/admin/users/:id/edit', requireAuth, checkPermission('changeUser'), requireMfaForScenario('user'), checkPermissionLevel, async (req, res) => {
    try {
        const targetUserId = parseInt(req.params.id);
        const targetUser = await getUserById(targetUserId);
        if (!targetUser) {
            return res.status(404).json({ error: 'User not found.' });
        }
        delete targetUser.password_hash;
        const roles = await getAssignableRoles(res.locals.user.permission_level);
        const overrides = await getUserOverrides(targetUser.user_id);

        // MFA state for the target user
        const mfaEnabled = await mfaService.isUserMfaEnabled(targetUserId);
        const mfaMethods = await mfaService.getUserMfaMethodTypes(targetUserId);

        res.json({
            targetUser,
            roles,
            overrides,
            allPermissions: ALL_PERMISSIONS,
            canChangePermissions: res.locals.user.permissions.changeUserPermission,
            adminPermissions: res.locals.user.permissions,
            mfaEnabled,
            mfaMethods
        });
    } catch (err) {
        console.error('API get user edit error:', err);
        res.status(500).json({ error: 'Failed to load user.' });
    }
});

// PUT /api/admin/users/:id — update
router.put('/admin/users/:id', requireAuth, checkPermission('changeUser'), requireMfaForScenario('user'), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        const { displayName, email, roleId, password, is_active } = req.body;
        const targetUserId = parseInt(req.params.id);
        const updates = {};

        // Display name: 1-30 chars, letters/digits/spaces
        if (displayName) {
            const trimmedDN = displayName.trim();
            if (!trimmedDN || trimmedDN.length > 30) {
                return res.status(422).json({ error: 'Display name must be between 1 and 30 characters' });
            }
            if (!/^[A-Za-z0-9 ]+$/.test(trimmedDN)) {
                return res.status(422).json({ error: 'Display name can only contain letters, digits, and spaces' });
            }
            updates.display_name = trimmedDN;
        }

        // Email change
        if (email !== undefined) {
            const newEmail = email ? email.trim() : null;
            if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
                return res.status(422).json({ error: 'Invalid email address format' });
            }
            // Check email uniqueness (users + pending_registrations)
            if (newEmail) {
                const normalizedEmail = newEmail.toLowerCase();
                if (await emailExists(normalizedEmail, targetUserId)) {
                    return res.status(409).json({ error: 'Email is already in use' });
                }
            }
            // Block email change if target user has MFA enabled
            const targetUser = await getUserById(targetUserId);
            if (targetUser && targetUser.email !== newEmail) {
                const targetMfaEnabled = await mfaService.isUserMfaEnabled(targetUserId);
                if (targetMfaEnabled) {
                    return res.status(422).json({ error: 'Cannot change email while user has MFA enabled. Reset their MFA first.' });
                }
            }
            updates.email = newEmail;
        }
        if (is_active !== undefined) updates.is_active = is_active === '1' || is_active === true || is_active === 1 ? 1 : 0;
        if (password) updates.password = password;

        if (roleId !== undefined) {
            const roles = await getAssignableRoles(res.locals.user.permission_level);
            const selectedRole = parseInt(roleId);
            if (roles.find(r => r.role_id === selectedRole)) {
                updates.role_id = selectedRole;
            }
        }

        await updateUser(targetUserId, updates);

        // If password changed by admin, terminate ALL of the user's sessions
        if (updates.password) {
            await deleteUserSessions(targetUserId);
        }

        // If deactivated, destroy their sessions
        if (updates.is_active === 0) {
            await deleteUserSessions(targetUserId);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API update user error:', err);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// PUT /api/admin/users/:id/permissions — update permission overrides
router.put('/admin/users/:id/permissions', requireAuth, checkPermission('changeUserPermission'), requireMfaForScenario('user'), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        const userId = parseInt(req.params.id);
        const { permissions } = req.body;

        if (permissions && typeof permissions === 'object') {
            const adminPerms = res.locals.user.permissions;
            for (const [key, value] of Object.entries(permissions)) {
                if (!ALL_PERMISSIONS.includes(key)) continue;
                if (!adminPerms[key]) {
                    return res.status(403).json({ error: `Cannot modify '${key}' permission that you don't have` });
                }
                await setUserOverride(userId, key, parseInt(value));
            }
        }

        res.status(204).end();
    } catch (err) {
        console.error('API update permissions error:', err);
        res.status(500).json({ error: 'Failed to update permissions' });
    }
});

// DELETE /api/admin/users/:id — delete
router.delete('/admin/users/:id', requireAuth, checkPermission('deleteUser'), requireMfaForScenario('user', { mandatory: true }), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        await deleteUserSessions(parseInt(req.params.id));
        await deleteUser(parseInt(req.params.id));
        res.status(204).end();
    } catch (err) {
        console.error('API delete user error:', err);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// GET /api/admin/users/:id/sessions
router.get('/admin/users/:id/sessions', requireAuth, checkPermission('changeUser'), requireMfaForScenario('user'), checkPermissionLevel, async (req, res) => {
    try {
        const sessions = await getUserSessions(parseInt(req.params.id));
        const sanitized = sessions.map(s => ({
            deviceName: formatUserAgent(s.user_agent),
            ip_address: s.ip_address,
            last_activity: s.last_activity,
            last_sign_in: s.last_sign_in,
            created_at: s.created_at,
        }));
        res.json({ sessions: sanitized });
    } catch (err) {
        console.error('API user sessions error:', err);
        res.status(500).json({ error: 'Failed to load sessions' });
    }
});

// POST /api/admin/users/:id/sessions/terminate-all
router.post('/admin/users/:id/sessions/terminate-all', requireAuth, checkPermission('changeUser'), requireMfaForScenario('user'), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        await deleteUserSessions(parseInt(req.params.id));
        res.status(204).end();
    } catch (err) {
        console.error('API terminate sessions error:', err);
        res.status(500).json({ error: 'Failed to terminate sessions' });
    }
});

// POST /api/admin/users/:id/reset-mfa — reset a user's MFA
router.post('/admin/users/:id/reset-mfa', requireAuth, checkPermission('changeUser'), requireMfaForScenario('user', { forceOneTime: true, mandatory: true }), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        const targetUserId = parseInt(req.params.id);
        await mfaService.resetUserMfa(targetUserId);
        res.status(204).end();
    } catch (err) {
        console.error('API reset user MFA error:', err);
        res.status(500).json({ error: 'Failed to reset MFA' });
    }
});

// ==========================================================================
//  ENROLLMENT
// ==========================================================================

// GET /api/admin/enrollment — query params: courseId, page, limit
router.get('/admin/enrollment', requireAuth, checkPermission('manageEnrolment'), requireMfaForScenario('enrollment'), async (req, res) => {
    try {
        const courseId = req.query.courseId;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = [10, 20, 50].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 10;
        const result = await listCourses(1, 999);
        let enrollmentData = null;
        let selectedCourse = null;
        let pagination = null;

        if (courseId) {
            selectedCourse = await getCourseById(courseId);
            if (selectedCourse) {
                const allUsers = await getAllUsersWithEnrollment(courseId, res.locals.user.permission_level);
                const total = allUsers.length;
                const totalPages = Math.max(1, Math.ceil(total / limit));
                const safePage = Math.min(page, totalPages);
                enrollmentData = allUsers.slice((safePage - 1) * limit, safePage * limit);
                pagination = { page: safePage, totalPages, total, limit };
            }
        }

        res.json({
            courses: result.courses,
            enrollmentData,
            selectedCourse,
            selectedCourseId: courseId || '',
            pagination
        });
    } catch (err) {
        console.error('API enrollment error:', err);
        res.status(500).json({ error: 'Failed to load enrollment data.' });
    }
});

// POST /api/admin/enrollment — add or remove
router.post('/admin/enrollment', requireAuth, checkPermission('manageEnrolment'), requireMfaForScenario('enrollment'), async (req, res) => {
    try {
        const { action, userId, courseId } = req.body;

        if (!userId || !courseId) {
            return res.status(400).json({ error: 'User and course are required' });
        }

        // Check target user's permission level
        const pool = getPool();
        const [userRows] = await pool.execute(
            'SELECT r.permission_level FROM users u JOIN roles r ON u.role_id = r.role_id WHERE u.user_id = ?',
            [userId]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (res.locals.user.permission_level >= userRows[0].permission_level) {
            return res.status(403).json({ error: 'Cannot manage enrollment for users with equal or higher authority' });
        }

        if (action === 'add') {
            await addEnrollment(parseInt(userId), courseId);
        } else if (action === 'remove') {
            await removeEnrollment(parseInt(userId), courseId);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API enrollment update error:', err);
        res.status(500).json({ error: 'Failed to update enrollment' });
    }
});

// ==========================================================================
//  ROLES
// ==========================================================================

// GET /api/admin/roles — with permissions
router.get('/admin/roles', requireAuth, checkPermission('manageRoles'), requireMfaForScenario('roles'), async (req, res) => {
    try {
        const roles = await listRoles();

        // Load permissions for each role
        const rolePermissions = {};
        for (const r of roles) {
            rolePermissions[r.role_id] = await getRolePermissions(r.role_id);
        }

        res.json({ roles, rolePermissions, allPermissions: ALL_PERMISSIONS, adminPermissions: res.locals.user.permissions });
    } catch (err) {
        console.error('API roles error:', err);
        res.status(500).json({ error: 'Failed to load roles.' });
    }
});

// POST /api/admin/roles — create
router.post('/admin/roles', requireAuth, checkPermission('manageRoles'), requireMfaForScenario('roles'), async (req, res) => {
    try {
        const { roleId, roleName, permissionLevel, description, permissions } = req.body;
        const id = parseInt(roleId);
        const level = parseInt(permissionLevel);

        if (isNaN(id) || id < 0 || id > 99) {
            return res.status(400).json({ error: 'Role ID must be 0-99' });
        }
        if (isNaN(level) || level < 0 || level > 99) {
            return res.status(400).json({ error: 'Permission level must be 0-99' });
        }
        if (!roleName) {
            return res.status(400).json({ error: 'Role name is required' });
        }

        // Only allow creating roles with higher permission level than own
        if (level <= res.locals.user.permission_level) {
            return res.status(403).json({ error: 'Cannot create a role with equal or higher authority' });
        }

        if (await roleIdExists(id)) {
            return res.status(409).json({ error: 'Role ID already exists' });
        }
        if (await roleNameExists(roleName)) {
            return res.status(409).json({ error: 'Role name already exists' });
        }
        if (await permissionLevelExists(level)) {
            return res.status(409).json({ error: 'Permission level already exists' });
        }

        await createRole(id, roleName, level, description);

        // Set permissions — admin can only grant permissions they have
        if (permissions && typeof permissions === 'object') {
            const adminPerms = res.locals.user.permissions;
            const permMap = {};
            for (const key of ALL_PERMISSIONS) {
                const wants = permissions[key] === '1' || permissions[key] === true;
                if (wants && !adminPerms[key]) {
                    return res.status(403).json({ error: `Cannot grant '${key}' permission that you don't have` });
                }
                permMap[key] = adminPerms[key] ? wants : false;
            }
            await setRolePermissions(id, permMap);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API create role error:', err);
        res.status(500).json({ error: 'Failed to create role' });
    }
});

// PUT /api/admin/roles/:id — update
router.put('/admin/roles/:id', requireAuth, checkPermission('manageRoles'), requireMfaForScenario('roles'), async (req, res) => {
    try {
        const roleId = parseInt(req.params.id);
        const { newRoleId, roleName, permissionLevel, description, permissions } = req.body;

        const role = await getRoleById(roleId);
        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }

        // Cannot edit roles with equal or higher authority
        if (role.permission_level <= res.locals.user.permission_level) {
            return res.status(403).json({ error: 'Cannot edit a role with equal or higher authority' });
        }

        const updates = {};

        // Handle role ID change
        if (newRoleId !== undefined && newRoleId !== '') {
            const parsedNewId = parseInt(newRoleId);
            if (isNaN(parsedNewId) || parsedNewId < 0 || parsedNewId > 99) {
                return res.status(400).json({ error: 'Role ID must be 0-99' });
            }
            if (parsedNewId !== roleId && await roleIdExists(parsedNewId)) {
                return res.status(409).json({ error: 'Role ID already exists' });
            }
            if (parsedNewId !== roleId) {
                updates.role_id = parsedNewId;
            }
        }

        if (roleName && roleName !== role.role_name) {
            if (await roleNameExists(roleName, roleId)) {
                return res.status(409).json({ error: 'Role name already exists' });
            }
            updates.role_name = roleName;
        }
        if (permissionLevel !== undefined && permissionLevel !== '') {
            const level = parseInt(permissionLevel);
            if (isNaN(level) || level < 0 || level > 99) {
                return res.status(400).json({ error: 'Permission level must be 0-99' });
            }
            if (level <= res.locals.user.permission_level) {
                return res.status(403).json({ error: 'Cannot set permission level equal to or higher than your own' });
            }
            if (level !== role.permission_level && await permissionLevelExists(level, roleId)) {
                return res.status(409).json({ error: 'Permission level already exists' });
            }
            updates.permission_level = level;
        }
        if (description !== undefined) updates.description = description;

        if (Object.keys(updates).length > 0) {
            await updateRole(roleId, updates);
        }

        // Determine which role ID to use for permission updates
        const effectiveRoleId = updates.role_id !== undefined ? updates.role_id : roleId;

        // Update permissions — admin can only modify permissions they have; preserve others
        if (permissions && typeof permissions === 'object') {
            const adminPerms = res.locals.user.permissions;
            const currentPerms = await getRolePermissions(effectiveRoleId);
            const permMap = {};
            for (const key of ALL_PERMISSIONS) {
                const wants = permissions[key] === '1' || permissions[key] === true;
                if (!adminPerms[key]) {
                    if (wants !== (currentPerms[key] || false)) {
                        return res.status(403).json({ error: `Cannot modify '${key}' permission that you don't have` });
                    }
                    permMap[key] = currentPerms[key] || false;
                } else {
                    permMap[key] = wants;
                }
            }
            await setRolePermissions(effectiveRoleId, permMap);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API update role error:', err);
        res.status(500).json({ error: err.message || 'Failed to update role' });
    }
});

// DELETE /api/admin/roles/:id — delete
router.delete('/admin/roles/:id', requireAuth, checkPermission('manageRoles'), requireMfaForScenario('roles'), async (req, res) => {
    try {
        const roleId = parseInt(req.params.id);
        const role = await getRoleById(roleId);

        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }

        // System roles cannot be removed
        if (role.is_system) {
            return res.status(400).json({ error: 'Cannot remove a system role' });
        }

        // Cannot remove roles with equal or higher authority
        if (role.permission_level <= res.locals.user.permission_level) {
            return res.status(403).json({ error: 'Cannot remove a role with equal or higher authority' });
        }

        await deleteRole(roleId);
        res.status(204).end();
    } catch (err) {
        console.error('API delete role error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================================================
//  SETTINGS
// ==========================================================================

// GET /api/admin/settings — all settings + worker keys + roles
router.get('/admin/settings', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const pool = getPool();
        const [settings] = await pool.execute('SELECT * FROM site_settings ORDER BY setting_key');
        const workerKeys = await listWorkerKeys();
        const [roles] = await pool.execute('SELECT role_id, role_name, permission_level FROM roles ORDER BY permission_level ASC');

        const settingsMap = {};
        for (const s of settings) {
            settingsMap[s.setting_key] = s.setting_value;
        }
        // Expose key existence before stripping secrets
        const hmacKeyConfigured = !!settingsMap.hmac_secret_key;

        // Never send secrets to client
        delete settingsMap.hmac_secret_key;

        // Strip keys managed by other pages / returned separately
        for (const key of Object.keys(settingsMap)) {
            if (key.startsWith('mfa_') || key.startsWith('audio_normalization_')) {
                delete settingsMap[key];
            }
        }

        // Strip key_secret from worker keys list (only shown once at creation)
        const sanitizedWorkerKeys = workerKeys.map(k => {
            const { key_secret, ...rest } = k;
            return rest;
        });

        const transcodingProfiles = await getGlobalProfiles();
        const audioNormalization = await getAudioNormalizationSettings();

        res.json({ settings: settingsMap, workerKeys: sanitizedWorkerKeys, roles, hmacKeyConfigured, r2PublicDomain: process.env.R2_PUBLIC_DOMAIN || '', transcodingProfiles, audioNormalization });
    } catch (err) {
        console.error('API settings error:', err);
        res.status(500).json({ error: 'Failed to load settings.' });
    }
});

// PUT /api/admin/settings — save general settings (partial updates)
router.put('/admin/settings', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const pool = getPool();
        const allowedKeys = [
            'site_name', 'site_protocol', 'site_hostname',
            'session_inactivity_days', 'session_max_days',
            'emailed_link_validity_minutes', 'registration_default_role',
            'enable_registration', 'require_invitation_code'
        ];

        // Build updates from only the fields present in the request
        const updates = {};
        for (const key of allowedKeys) {
            if (req.body[key] === undefined) continue;
            if (key === 'site_hostname') {
                updates.site_hostname = (req.body.site_hostname || '').trim().replace(/^https?:\/\//, '').split('/')[0];
            } else if (key === 'site_protocol') {
                updates.site_protocol = req.body.site_protocol || 'https';
            } else if (key === 'enable_registration' || key === 'require_invitation_code') {
                const v = req.body[key];
                updates[key] = (v === 'on' || v === true || v === 'true') ? 'true' : 'false';
            } else {
                updates[key] = String(req.body[key]);
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(204).end();
        }

        // --- Validation ---
        const errors = {};

        if (updates.site_name !== undefined) {
            if (!updates.site_name.trim()) {
                errors.site_name = 'Site name is required';
            }
        }

        if (updates.site_hostname !== undefined) {
            if (!updates.site_hostname.trim()) {
                errors.site_hostname = 'Hostname is required';
            } else if (/\s/.test(updates.site_hostname)) {
                errors.site_hostname = 'Hostname cannot contain spaces';
            }
        }

        if (updates.session_inactivity_days !== undefined) {
            if (!updates.session_inactivity_days.trim()) {
                errors.session_inactivity_days = 'This field is required';
            } else {
                const v = Number(updates.session_inactivity_days);
                if (!Number.isInteger(v) || v < 1 || v > 365) {
                    errors.session_inactivity_days = 'Must be an integer between 1 and 365';
                }
            }
        }

        if (updates.session_max_days !== undefined) {
            if (!updates.session_max_days.trim()) {
                errors.session_max_days = 'This field is required';
            } else {
                const v = Number(updates.session_max_days);
                if (!Number.isInteger(v) || v < 1 || v > 365) {
                    errors.session_max_days = 'Must be an integer between 1 and 365';
                }
            }
        }

        // Cross-field: inactivity must be <= max
        if (!errors.session_inactivity_days && !errors.session_max_days) {
            let inact = updates.session_inactivity_days !== undefined ? Number(updates.session_inactivity_days) : null;
            let max = updates.session_max_days !== undefined ? Number(updates.session_max_days) : null;
            if (inact !== null || max !== null) {
                // Fetch the missing value from DB if only one was sent
                if (inact === null || max === null) {
                    const needed = inact === null ? 'session_inactivity_days' : 'session_max_days';
                    const [rows] = await pool.execute('SELECT setting_value FROM site_settings WHERE setting_key = ?', [needed]);
                    const dbVal = rows.length ? Number(rows[0].setting_value) : (needed === 'session_inactivity_days' ? 3 : 15);
                    if (inact === null) inact = dbVal;
                    else max = dbVal;
                }
                if (inact > max) {
                    errors.session_inactivity_days = 'Inactivity timeout cannot exceed max lifetime';
                }
            }
        }

        if (updates.emailed_link_validity_minutes !== undefined) {
            if (!updates.emailed_link_validity_minutes.trim()) {
                errors.emailed_link_validity_minutes = 'This field is required';
            } else {
                const v = Number(updates.emailed_link_validity_minutes);
                if (!Number.isInteger(v) || v < 5 || v > 10080) {
                    errors.emailed_link_validity_minutes = 'Must be an integer between 5 and 10080';
                }
            }
        }

        if (updates.registration_default_role !== undefined) {
            const roleId = Number(updates.registration_default_role);
            const [roleRows] = await pool.execute('SELECT permission_level FROM roles WHERE role_id = ?', [roleId]);
            if (!roleRows.length) {
                errors.registration_default_role = 'Invalid role';
            } else if (roleRows[0].permission_level <= res.locals.user.permission_level) {
                // Role is as-or-more privileged than current user — only allow if it's already the current setting
                const [curRows] = await pool.execute("SELECT setting_value FROM site_settings WHERE setting_key = 'registration_default_role'");
                const currentRoleId = curRows.length ? curRows[0].setting_value : '2';
                if (String(roleId) !== String(currentRoleId)) {
                    errors.registration_default_role = 'Cannot set default role to a role with equal or higher privilege';
                }
            }
        }

        if (Object.keys(errors).length > 0) {
            return res.status(422).json({ errors });
        }

        // --- Persist ---
        for (const [key, value] of Object.entries(updates)) {
            await pool.execute(
                'INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
                [key, value]
            );
        }

        res.status(204).end();
    } catch (err) {
        console.error('API save settings error:', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// PUT /api/admin/settings/transcoding-profiles — save global profiles + audio normalization
router.put('/admin/settings/transcoding-profiles', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const { profiles, audioNormalization } = req.body;

        // Validate profiles
        if (!Array.isArray(profiles) || profiles.length === 0) {
            return res.status(400).json({ error: 'At least one profile is required' });
        }
        for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            const parsed = {
                name: (p.name || '').trim(),
                width: parseInt(p.width, 10),
                height: parseInt(p.height, 10),
                video_bitrate_kbps: parseInt(p.video_bitrate_kbps, 10),
                audio_bitrate_kbps: parseInt(p.audio_bitrate_kbps, 10),
                segment_duration: p.segment_duration !== undefined ? parseInt(p.segment_duration, 10) : 6,
                gop_size: p.gop_size !== undefined ? parseInt(p.gop_size, 10) : 48
            };
            const errors = validateProfile(parsed);
            if (errors.length > 0) {
                return res.status(400).json({ error: `Profile ${i + 1}: ${errors.join(', ')}` });
            }
            profiles[i] = { ...p, ...parsed };
        }

        await saveGlobalProfiles(profiles);

        // Save audio normalization settings if provided
        if (audioNormalization) {
            const target = parseFloat(audioNormalization.target);
            const peak = parseFloat(audioNormalization.peak);
            const maxGain = parseFloat(audioNormalization.maxGain);
            if (isNaN(target) || target < -50 || target > 0) return res.status(400).json({ error: 'Target loudness must be between -50 and 0' });
            if (isNaN(peak) || peak < -20 || peak > 0) return res.status(400).json({ error: 'True peak must be between -20 and 0' });
            if (isNaN(maxGain) || maxGain < 0 || maxGain > 40) return res.status(400).json({ error: 'Max gain must be between 0 and 40' });
            await saveAudioNormalizationSettings({ target: String(target), peak: String(peak), maxGain: String(maxGain) });
        }

        res.status(204).end();
    } catch (err) {
        console.error('API save transcoding profiles error:', err);
        res.status(500).json({ error: 'Failed to save transcoding profiles' });
    }
});

// POST /api/admin/settings/hmac/generate — generate new HMAC secret key
router.post('/admin/settings/hmac/generate', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const secret = await generateSecretKey();
        res.json({ success: true, secret });
    } catch (err) {
        console.error('API generate HMAC key error:', err);
        res.status(500).json({ error: 'Failed to generate HMAC secret key' });
    }
});

// PUT /api/admin/settings/hmac/validity — update token validity hint
router.put('/admin/settings/hmac/validity', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const val = parseInt(req.body.hmac_token_validity, 10);
        if (!val || val < 600) {
            return res.status(400).json({ error: 'Token validity must be at least 600 seconds' });
        }
        await setSetting('hmac_token_validity', String(val));
        res.status(204).end();
    } catch (err) {
        console.error('API save HMAC validity error:', err);
        res.status(500).json({ error: 'Failed to save token validity' });
    }
});

// PUT /api/admin/settings/hmac/toggle — enable/disable HMAC validation
router.put('/admin/settings/hmac/toggle', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const enabled = req.body.hmac_enabled === 'true' || req.body.hmac_enabled === true;
        if (enabled && !(await isHmacConfigured())) {
            return res.status(400).json({ error: 'Cannot enable HMAC validation without a secret key. Generate a key first.' });
        }
        await setSetting('hmac_enabled', enabled ? 'true' : 'false');
        res.status(204).end();
    } catch (err) {
        console.error('API toggle HMAC error:', err);
        res.status(500).json({ error: 'Failed to toggle HMAC validation' });
    }
});

// POST /api/admin/settings/worker-keys — create worker key
router.post('/admin/settings/worker-keys', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const { label } = req.body;
        const { keyId, secret } = await generateWorkerKeyPair(label, res.locals.user.user_id);
        res.json({ keyId, secret });
    } catch (err) {
        console.error('API generate worker key error:', err);
        res.status(500).json({ error: 'Failed to generate worker key' });
    }
});

// PUT /api/admin/settings/worker-keys/:keyId/revoke — revoke key
router.put('/admin/settings/worker-keys/:keyId/revoke', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        await revokeWorkerKey(req.params.keyId);
        res.status(204).end();
    } catch (err) {
        console.error('API revoke worker key error:', err);
        res.status(500).json({ error: 'Failed to revoke worker key' });
    }
});

// DELETE /api/admin/settings/worker-keys/:keyId — delete key
router.delete('/admin/settings/worker-keys/:keyId', requireAuth, checkPermission('manageSite'), requireMfaForScenario('settings'), async (req, res) => {
    try {
        const deleted = await deleteWorkerKey(req.params.keyId);
        if (deleted) {
            res.status(204).end();
        } else {
            res.status(400).json({ error: 'Cannot delete an active key. Revoke it first.' });
        }
    } catch (err) {
        console.error('API delete worker key error:', err);
        res.status(500).json({ error: 'Failed to delete worker key' });
    }
});

// ==========================================================================
//  INVITATIONS
// ==========================================================================

// GET /api/admin/invitations — query params: page, limit
router.get('/admin/invitations', requireAuth, checkPermission('inviteUser'), requireMfaForScenario('invitation_codes'), async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = [10, 20, 50].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 10;
        const allCodes = await listInvitationCodes(res.locals.user.permission_level);
        const total = allCodes.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const safePage = Math.min(page, totalPages);
        const codes = allCodes.slice((safePage - 1) * limit, safePage * limit);
        res.json({ codes, pagination: { page: safePage, totalPages, total, limit } });
    } catch (err) {
        console.error('API invitation codes error:', err);
        res.status(500).json({ error: 'Failed to load invitation codes.' });
    }
});

// POST /api/admin/invitations — create new code
router.post('/admin/invitations', requireAuth, checkPermission('inviteUser'), requireMfaForScenario('invitation_codes'), async (req, res) => {
    try {
        const validityHours = parseInt(req.body.validity_hours) || 72;
        if (validityHours < 1) {
            return res.status(400).json({ error: 'Validity must be at least 1 hour.' });
        }

        const result = await generateInvitationCode(res.locals.user.user_id, validityHours);
        res.json({ code: result.code, expires_at: result.expiresAt });
    } catch (err) {
        console.error('API generate invitation code error:', err);
        res.status(500).json({ error: 'Failed to generate invitation code.' });
    }
});

// DELETE /api/admin/invitations/:code — remove invitation
router.delete('/admin/invitations/:code', requireAuth, checkPermission('inviteUser'), requireMfaForScenario('invitation_codes'), async (req, res) => {
    try {
        const result = await removeInvitationCode(
            req.params.code,
            res.locals.user.user_id,
            res.locals.user.permission_level
        );

        if (!result.success) {
            const status = result.error.includes('permission') ? 403 : 404;
            return res.status(status).json({ error: result.error });
        }

        res.status(204).end();
    } catch (err) {
        console.error('API remove invitation code error:', err);
        res.status(500).json({ error: 'Failed to remove invitation code.' });
    }
});

// ==========================================================================
//  PLAYBACK STATS
// ==========================================================================

// GET /api/admin/playback-stats — query params: userId, courseId
router.get('/admin/playback-stats', requireAuth, checkPermission('viewPlaybackStat'), requireMfaForScenario('playback_stats'), async (req, res) => {
    try {
        const pool = getPool();
        const userId = req.query.userId;
        const courseId = req.query.courseId;

        // User list with total watch time
        const [users] = await pool.execute(
            `SELECT u.user_id, u.username, u.display_name,
                    COALESCE(SUM(wp.watch_seconds), 0) as total_watch_seconds,
                    MAX(wp.last_watch_at) as last_watch_at
             FROM users u
             LEFT JOIN watch_progress wp ON u.user_id = wp.user_id
             GROUP BY u.user_id
             ORDER BY total_watch_seconds DESC`
        );

        let userCourses = null;
        let courseVideos = null;
        let selectedUser = null;
        let selectedCourse = null;

        if (userId) {
            // Get user info
            const [userRows] = await pool.execute(
                'SELECT user_id, username, display_name FROM users WHERE user_id = ?',
                [userId]
            );
            selectedUser = userRows[0] || null;

            if (selectedUser) {
                // Get courses with watch stats for this user
                const [courses] = await pool.execute(
                    `SELECT c.course_id, c.course_name,
                            COALESCE(SUM(wp.watch_seconds), 0) as total_watch_seconds,
                            MAX(wp.last_watch_at) as last_watch_at
                     FROM courses c
                     JOIN videos v ON c.course_id = v.course_id
                     LEFT JOIN watch_progress wp ON v.video_id = wp.video_id AND wp.user_id = ?
                     GROUP BY c.course_id
                     HAVING total_watch_seconds > 0
                     ORDER BY last_watch_at DESC`,
                    [userId]
                );
                userCourses = courses;
            }
        }

        if (userId && courseId) {
            // Get per-video stats for this user + course
            const [courseRows] = await pool.execute(
                'SELECT course_id, course_name FROM courses WHERE course_id = ?',
                [courseId]
            );
            selectedCourse = courseRows[0] || null;

            const [videos] = await pool.execute(
                `SELECT v.video_id, v.title, v.duration_seconds,
                        COALESCE(wp.watch_seconds, 0) as watch_seconds,
                        wp.last_position, wp.last_watch_at
                 FROM videos v
                 LEFT JOIN watch_progress wp ON v.video_id = wp.video_id AND wp.user_id = ?
                 WHERE v.course_id = ?
                 ORDER BY COALESCE(v.lecture_date, v.created_at) DESC`,
                [userId, courseId]
            );
            courseVideos = videos;
        }

        res.json({
            users,
            userCourses,
            courseVideos,
            selectedUser,
            selectedCourse,
            canClear: res.locals.user.permissions.clearPlaybackStat
        });
    } catch (err) {
        console.error('API playback stats error:', err);
        res.status(500).json({ error: 'Failed to load playback statistics.' });
    }
});

// DELETE /api/admin/playback-stats — clear all
router.delete('/admin/playback-stats', requireAuth, checkPermission('clearPlaybackStat'), requireMfaForScenario('playback_stats'), async (req, res) => {
    try {
        const pool = getPool();
        await pool.execute('DELETE FROM watch_progress');
        res.status(204).end();
    } catch (err) {
        console.error('API clear playback stats error:', err);
        res.status(500).json({ error: 'Failed to clear statistics' });
    }
});

// ==========================================================================
//  TRANSCODING
// ==========================================================================

// GET /api/admin/transcoding/jobs
router.get('/admin/transcoding/jobs', requireAuth, checkPermission('manageSite'), requireMfaForScenario('transcoding'), async (req, res) => {
    try {
        const pool = getPool();

        // Get all non-cleared tasks with video and course info
        const [rows] = await pool.execute(
            `SELECT pq.task_id, pq.job_id, pq.status, pq.progress, pq.error_message,
                    pq.created_at AS upload_time, pq.leased_at,
                    pq.last_heartbeat, pq.error_at, pq.updated_at,
                    v.title AS video_title, v.video_id, v.status AS video_status,
                    v.processing_progress AS video_progress,
                    c.course_name
             FROM processing_queue pq
             JOIN videos v ON pq.video_id = v.video_id
             JOIN courses c ON v.course_id = c.course_id
             WHERE pq.cleared = 0
             ORDER BY pq.created_at DESC`
        );

        // Categorize jobs
        const errorJobs = [];
        const activeJobs = [];
        const finishedJobs = [];

        for (const row of rows) {
            const job = {
                taskId: row.task_id,
                jobId: row.job_id,
                videoId: row.video_id,
                videoTitle: row.video_title,
                courseName: row.course_name,
                status: row.status,
                videoStatus: row.video_status,
                progress: row.video_progress || row.progress || 0,
                errorMessage: row.error_message,
                uploadTime: row.upload_time,
                leasedAt: row.leased_at,
                lastHeartbeat: row.last_heartbeat,
                errorAt: row.error_at,
                updatedAt: row.updated_at
            };

            if (row.status === 'error') {
                errorJobs.push(job);
            } else if (row.status === 'completed') {
                finishedJobs.push(job);
            } else {
                activeJobs.push(job);
            }
        }

        // Sort: error by error_at ASC, active by upload_time ASC, finished by updated_at DESC
        errorJobs.sort((a, b) => new Date(a.errorAt || a.uploadTime) - new Date(b.errorAt || b.uploadTime));
        activeJobs.sort((a, b) => new Date(a.uploadTime) - new Date(b.uploadTime));
        finishedJobs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        res.json({
            jobs: [...errorJobs, ...activeJobs, ...finishedJobs],
            hasActive: activeJobs.length > 0
        });
    } catch (err) {
        console.error('API transcoding jobs error:', err);
        res.status(500).json({ error: 'Failed to load transcoding jobs' });
    }
});

// POST /api/admin/transcoding/clear-finished — soft-clear completed tasks
router.post('/admin/transcoding/clear-finished', requireAuth, checkPermission('manageSite'), requireMfaForScenario('transcoding'), async (req, res) => {
    try {
        const pool = getPool();
        await pool.execute(
            "UPDATE processing_queue SET cleared = 1 WHERE status = 'completed'"
        );
        res.status(204).end();
    } catch (err) {
        console.error('API clear finished jobs error:', err);
        res.status(500).json({ error: 'Failed to clear finished jobs' });
    }
});

module.exports = router;
