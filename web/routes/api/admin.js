const express = require('express');
const router = express.Router();

// Middleware
const { requireAuth } = require('../../middleware/auth');
const { checkPermission, checkPermissionLevel, checkAnyPermission } = require('../../middleware/permissions');
const { requireStepup } = require('../../middleware/stepup');

// Services - Courses
const { createCourse, getCourseById, updateCourse, deleteCourse, listCourses, listCoursesForAdmin } = require('../../services/courseService');
const { listCourseVideos } = require('../../services/videoService');

// Course "module" label — the term shown next to each item's number
// (Week 3 / Chapter 3 / …). Curated allowlist; anything else (blank/unknown)
// stores NULL, which the client renders as the generic "Module N".
const MODULE_LABELS = ['week', 'chapter', 'module', 'unit', 'lesson', 'section', 'part', 'topic'];
const normModuleLabel = (v) => (typeof v === 'string' && MODULE_LABELS.includes(v.trim().toLowerCase())) ? v.trim().toLowerCase() : null;

// Services - Users
const { getUserById, listUsers } = require('../../services/userService');
const { ALL_PERMISSIONS, getUserOverrides, setUserOverride, getRolePermissions, setRolePermissions, resolveAuthBundle } = require('../../services/permissionService');
const { PERMISSION_PREREQS, validatePermissionSet } = require('../../services/permissionConstants');
const { stripToHost, isValidHost } = require('../../services/hostValidation');
const { deleteUserSessions, getUserSessions } = require('../../config/session');
const UAParser = require('ua-parser-js');

// Services - Enrollment
const { addEnrollment, removeEnrollment, isEnrolled, getUserEnrollments, getEnrollableStudents, setEnrollmentBatch } = require('../../services/enrollmentService');
const playbackStats = require('../../services/playbackStatsService');

// Services - Roles
const { listRoles, getRoleById, createRole, updateRole, deleteRole, getNextRoleId, roleIdExists, roleNameExists, permissionLevelExists } = require('../../services/roleService');

// Services - Settings
const { getPool, idBuf } = require('../../config/database');
const {
    generateWorkerKeyPair,
    reactivateWorkerKey,
    pauseWorkerKey,
    resumeWorkerKey,
    deactivateWorkerKey,
    renameWorkerKey,
    deleteWorkerKey,
    listWorkerKeys,
} = require('../../services/workerAuthService');
const { generateSecretKey, isHmacConfigured, setSetting, generateFileToken } = require('../../services/tokenService');

// Services - Transcoding Profiles
const { getDefaultGlobalProfiles, getEnhancedGlobalProfiles, getCourseProfiles, saveDefaultGlobalProfiles, saveEnhancedGlobalProfiles, saveCourseProfiles, deleteCourseProfiles, countSystemRows, getSystemFlagsByIds, getAudioNormalizationSettings, saveAudioNormalizationSettings, getAudioBitrateDefault, saveAudioBitrateDefault, validateAudioBitrate, validateProfile } = require('../../services/transcodingProfileService');

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
    if (req.params.id === res.locals.user.user_id) {
        res.status(403).json({ error: 'Cannot modify your own account through admin panel' });
        return true;
    }
    return false;
}

// Helper: require enrollment or allCourseAccess for course endpoints
function requireCourseAccess(req, res, next) {
    if (res.locals.user.permissions.allCourseAccess) return next();
    isEnrolled(res.locals.user.user_id, req.params.courseId).then(enrolled => {
        if (!enrolled) return res.status(403).json({ error: 'You do not have access to this course', code: 'COURSE_FORBIDDEN' });
        next();
    }).catch(err => {
        console.error('Course access check error:', err);
        res.status(500).json({ error: 'Failed to verify course access' });
    });
}

// ==========================================================================
//  COURSES
// ==========================================================================

// GET /api/admin/courses — the admin course list. Returns EVERY course the
// caller may administer in one array (not paginated; the client fit-height-
// paginates). Enrollment-scoped exactly like GET /api/courses: allCourseAccess
// sees all, otherwise only courses the caller is enrolled in — the deliberate
// bound on a course-scoped admin. Crucially NO is_active filter, so a course
// flipped Inactive stays visible here (that is the bug this fixes). The guard
// mirrors CoursesPage.jsx's client gate (any one course-admin permission), NOT
// manageCourse — an admin who passes the client gate but lacks manageCourse
// would otherwise get a 403 and a blank page.
router.get('/admin/courses', requireAuth, checkPermission('manageCourse'), async (req, res) => {
    try {
        const courses = await listCoursesForAdmin(res.locals.user.user_id, res.locals.user.permissions.allCourseAccess);
        res.json({ courses });
    } catch (err) {
        console.error('API admin courses error:', err);
        res.status(500).json({ error: 'Failed to load courses.' });
    }
});

// POST /api/admin/courses — create
router.post('/admin/courses', requireAuth, checkPermission('addCourse'), async (req, res) => {
    try {
        const { courseCode, courseName, moduleLabel } = req.body;
        const code = typeof courseCode === 'string' ? courseCode.trim() : '';
        if (!code) return res.status(400).json({ error: 'Course code is required' });
        if (code.length > 15 || !/^[A-Za-z0-9 ]+$/.test(code)) {
            return res.status(422).json({ error: 'Course code: letters, digits, and spaces, up to 15 characters' });
        }
        const name = typeof courseName === 'string' ? courseName.trim() : '';
        if (name.length > 300) return res.status(422).json({ error: 'Course name must be 300 characters or fewer' });

        const { courseId } = await createCourse(code, name || null, normModuleLabel(moduleLabel), res.locals.user.user_id);
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
        module_number: v.module_number,
        lecture_date: v.lecture_date,
        duration_seconds: v.duration_seconds,
        original_filename: v.original_filename,
        file_size_bytes: v.file_size_bytes,
        status: v.status,
        processing_job_id: v.processing_job_id,
        processing_progress: v.processing_progress,
        processing_error: v.processing_error,
        has_source: !!v.r2_source_key,
        has_poster: !!v.has_poster,
        created_at: v.created_at,
        updated_at: v.updated_at,
    };
}

// GET /api/admin/courses/:courseId — single course + videos
router.get('/admin/courses/:courseId', requireAuth, checkPermission('changeCourse'), requireCourseAccess, async (req, res) => {
    try {
        const course = await getCourseById(req.params.courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found.' });
        }

        const videoResult = await listCourseVideos(req.params.courseId, 1, 100);
        await require('../../services/cache/transcodeProgressCache').applyLiveOverlayToVideos(videoResult.videos);

        res.json({ course, videos: videoResult.videos.map(sanitizeAdminVideo) });
    } catch (err) {
        console.error('API get course error:', err);
        res.status(500).json({ error: 'Failed to load course.' });
    }
});

// GET /api/admin/courses/:courseId/edit — course + profiles + audio normalization
router.get('/admin/courses/:courseId/edit', requireAuth, checkPermission('changeCourse'), requireCourseAccess, async (req, res) => {
    try {
        const course = await getCourseById(req.params.courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found.' });
        }
        const videoResult = await listCourseVideos(req.params.courseId, 1, 100);
        await require('../../services/cache/transcodeProgressCache').applyLiveOverlayToVideos(videoResult.videos);
        // Send both global sets so the course edit page can preview whichever
        // one the toggle currently lands on without a second round-trip.
        const defaultGlobalProfiles = await getDefaultGlobalProfiles();
        const enhancedGlobalProfiles = await getEnhancedGlobalProfiles();
        const courseProfiles = course.use_custom_profiles ? await getCourseProfiles(req.params.courseId) : [];
        const audioNormalization = await getAudioNormalizationSettings();
        const audioBitrateKbps = await getAudioBitrateDefault();
        res.json({ course, videos: videoResult.videos.map(sanitizeAdminVideo), defaultGlobalProfiles, enhancedGlobalProfiles, courseProfiles, audioNormalization, audioBitrateKbps });
    } catch (err) {
        console.error('API get course edit error:', err);
        res.status(500).json({ error: 'Failed to load course.' });
    }
});

// GET /api/admin/courses/:courseId/videos — paginated video list for a course
router.get('/admin/courses/:courseId/videos', requireAuth, checkAnyPermission('uploadVideo', 'changeVideo'), requireCourseAccess, async (req, res) => {
    try {
        const pool = getPool();
        const courseId = parseInt(req.params.courseId);

        // Verify the course exists. NO is_active check — an inactive course's
        // videos pane must still open, otherwise the admin can never get back
        // in to flip it active again. 404 only when the course is truly gone.
        const courseCache = require('../../services/cache/courseCache');
        const course = await courseCache.getCourseMeta(courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found.', code: 'COURSE_NOT_FOUND' });
        }

        const page = parseInt(req.query.page) || 1;
        // Fit-to-height paging (mirrors the student CourseView): the client
        // measures how many rows fit and asks for exactly that many. Clamp to a
        // sane range instead of the old fixed [10,20,50] whitelist.
        const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 10));

        const [countRows] = await pool.execute(
            'SELECT COUNT(*) as total FROM videos WHERE course_id = ?',
            [courseId]
        );
        const total = countRows[0].total;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        // Clamp an out-of-range page to the LAST page: a stale/oversized page
        // number (e.g. the client's remembered page after its measured page
        // size grew) returns the last page's rows instead of an empty set.
        const effPage = Math.min(Math.max(page, 1), totalPages);
        const offset = (effPage - 1) * limit;

        // Admin exposes only the "Default" ordering (no Date/Name), so there is
        // no `sort` param — only direction. `dir` is whitelisted to the literals
        // 'ASC'/'DESC', so the interpolation is injection-safe. Mirrors the
        // student default key order; NULL module_number / lecture_date sinks to
        // the bottom regardless of direction (the IS NULL fragments are pinned
        // ASC). Admin videos default to DESCENDING.
        const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
        const [videos] = await pool.execute(
            `SELECT * FROM videos WHERE course_id = ?
             ORDER BY (module_number IS NULL) ASC, CAST(module_number AS UNSIGNED) ${dir},
                      (lecture_date IS NULL) ASC, lecture_date ${dir}, video_id ${dir}
             LIMIT ${limit} OFFSET ${offset}`,
            [courseId]
        );
        await require('../../services/cache/transcodeProgressCache').applyLiveOverlayToVideos(videos);

        // Per-video poster signing — mirrors pages.js. The poster path
        // `/posters/{course_id}/{video_id}.jpg` needs a per-file HMAC token to
        // clear the WAF file-scope branch; mint one per row up front so the
        // client reconstructs the URL without a per-image refresh. Mint only
        // when has_poster=1; otherwise the client falls back to the play glyph.
        const r2PublicDomain = process.env.R2_PUBLIC_DOMAIN || '';
        const out = await Promise.all(videos.map(async (v) => {
            const s = sanitizeAdminVideo(v);
            if (v.has_poster) {
                s.posterToken = await generateFileToken(`/posters/${v.course_id}/${v.video_id}.jpg`) || '';
            }
            return s;
        }));

        res.json({
            course: { course_id: course.course_id, course_code: course.course_code, course_name: course.course_name, module_label: course.module_label },
            videos: out,
            r2PublicDomain,
            total,
            page: effPage,
            totalPages
        });
    } catch (err) {
        console.error('API admin videos error:', err);
        res.status(500).json({ error: 'Failed to load videos.' });
    }
});

// GET /api/admin/courses/:courseId/materials — materials list for a course,
// admin surface. Response shape is IDENTICAL to the student
// GET /api/materials/courses/:courseId so the client swap is a one-line URL
// change. requireCourseAccess (the LOCAL admin.js one) already bypasses the
// enrollment check for allCourseAccess. NO is_active check — an inactive
// course's materials pane must still open; 404 only when the course is missing.
router.get('/admin/courses/:courseId/materials', requireAuth, checkPermission('manageCourse'), requireCourseAccess, async (req, res) => {
    try {
        const courseId = parseInt(req.params.courseId);
        const courseCache = require('../../services/cache/courseCache');
        const course = await courseCache.getCourseMeta(courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found.', code: 'COURSE_NOT_FOUND' });
        }

        const { getMaterialsByCourse } = require('../../services/materialService');
        const materials = await getMaterialsByCourse(courseId);
        res.json({
            courseCode: course.course_code,
            courseName: course.course_name,
            moduleLabel: course.module_label,
            materials: materials.map(m => ({
                material_id: m.material_id,
                filename: m.filename,
                file_size: m.file_size,
                content_type: m.content_type,
                module_number: m.module_number,
                uploaded_by: m.uploaded_by,
                created_at: m.created_at,
            })),
        });
    } catch (err) {
        console.error('API admin materials error:', err);
        res.status(500).json({ error: 'Failed to load materials.' });
    }
});

// PUT /api/admin/courses/:courseId — update
router.put('/admin/courses/:courseId', requireAuth, checkPermission('changeCourse'), requireCourseAccess, async (req, res) => {
    try {
        const { courseCode, courseName, moduleLabel, is_active, use_custom_profiles, use_enhanced_profiles, audio_normalization } = req.body;
        const updates = {};
        if (moduleLabel !== undefined) updates.module_label = normModuleLabel(moduleLabel);
        if (courseCode !== undefined) {
            const code = String(courseCode).trim();
            if (!code || code.length > 15 || !/^[A-Za-z0-9 ]+$/.test(code)) {
                return res.status(422).json({ error: 'Course code: letters, digits, and spaces, up to 15 characters' });
            }
            updates.course_code = code;
        }
        if (courseName !== undefined) {
            const name = String(courseName).trim();
            if (name.length > 300) return res.status(422).json({ error: 'Course name must be 300 characters or fewer' });
            updates.course_name = name || null;
        }
        if (is_active !== undefined) {
            updates.is_active = is_active === '1' || is_active === true || is_active === 1 ? 1 : 0;
        }
        if (use_custom_profiles !== undefined) updates.use_custom_profiles = use_custom_profiles ? 1 : 0;
        if (use_enhanced_profiles !== undefined) updates.use_enhanced_profiles = use_enhanced_profiles ? 1 : 0;
        if (audio_normalization !== undefined) updates.audio_normalization = audio_normalization ? 1 : 0;
        await updateCourse(req.params.courseId, updates);
        res.status(204).end();
    } catch (err) {
        console.error('API update course error:', err);
        res.status(500).json({ error: 'Failed to update course' });
    }
});

// DELETE /api/admin/courses/:courseId — delete
router.delete('/admin/courses/:courseId', requireAuth, checkPermission('deleteCourse'), requireCourseAccess, async (req, res) => {
    try {
        await deleteCourse(req.params.courseId);
        res.status(204).end();
    } catch (err) {
        console.error('API delete course error:', err);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

// PUT /api/admin/courses/:courseId/transcoding-profiles — save course profiles
router.put('/admin/courses/:courseId/transcoding-profiles', requireAuth, checkPermission('changeCourse'), requireCourseAccess, async (req, res) => {
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
                fps_limit: p.fps_limit !== undefined ? parseInt(p.fps_limit, 10) : 60,
                segment_duration: p.segment_duration !== undefined ? parseInt(p.segment_duration, 10) : 6,
                gop_seconds: p.gop_seconds !== undefined ? parseFloat(p.gop_seconds) : 2.00
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
router.delete('/admin/courses/:courseId/transcoding-profiles', requireAuth, checkPermission('changeCourse'), requireCourseAccess, async (req, res) => {
    try {
        await deleteCourseProfiles(req.params.courseId);
        res.status(204).end();
    } catch (err) {
        console.error('API delete course profiles error:', err);
        res.status(500).json({ error: 'Failed to reset course profiles' });
    }
});

// ==========================================================================
//  USERS
// ==========================================================================

// GET /api/admin/users — paginated list. Fit-to-height paging + sort mirrors
// the admin CoursePage: the client measures how many rows fit and asks for
// exactly that many. `dir` is whitelisted to the literals 'ASC'/'DESC' BEFORE
// it reaches the service, so the ORDER BY interpolation is injection-safe.
// Gated by the 'user' step-up like the other admin lists: in RW scope the GET
// challenges and the client's useStepupGuard renders the verify card in the list
// area; a write-only scope still leaves the list open (see middleware/stepup.js).
router.get('/admin/users', requireAuth, checkPermission('manageUser'), requireStepup('user'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(60, Math.max(1, parseInt(req.query.limit) || 10));
        const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
        const q = (req.query.q || '').toString().trim().slice(0, 100);
        const La = res.locals.user.permission_level;
        const result = await listUsers(La, page, limit, dir, q);
        res.json(result);
    } catch (err) {
        console.error('API admin users error:', err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

// GET /api/admin/users/:id/edit — the user page. Identity (display name,
// email, password, MFA, enable/disable) is SSO-owned now: details render
// view-only with a "manage at the account portal" link; only app-local
// permission overrides and sessions remain editable here.
router.get('/admin/users/:id/edit', requireAuth, checkPermission('changeUser'), requireStepup('user'), checkPermissionLevel, async (req, res) => {
    try {
        const targetUser = await getUserById(req.params.id);
        if (!targetUser) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const overrides = await getUserOverrides(targetUser.user_id);

        res.json({
            targetUser,
            overrides,
            allPermissions: ALL_PERMISSIONS,
            permissionPrereqs: PERMISSION_PREREQS,
            canChangePermissions: res.locals.user.permissions.changeUserPermission,
            adminPermissions: res.locals.user.permissions,
        });
    } catch (err) {
        console.error('API get user edit error:', err);
        res.status(500).json({ error: 'Failed to load user.' });
    }
});

// PUT /api/admin/users/:id/permissions — update permission overrides
router.put('/admin/users/:id/permissions', requireAuth, checkPermission('changeUserPermission'), requireStepup('user'), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        const userId = req.params.id;
        const { permissions } = req.body;

        if (permissions && typeof permissions === 'object') {
            const adminPerms = res.locals.user.permissions;
            // Authorization: an admin can only touch keys they themselves hold.
            for (const key of Object.keys(permissions)) {
                if (!ALL_PERMISSIONS.includes(key)) continue;
                if (!adminPerms[key]) {
                    return res.status(403).json({ error: `Cannot modify '${key}' permission that you don't have`, code: 'PERMISSION_DENIED' });
                }
            }
            // Validate the OVERRIDE set ALONE — inherit is "unconfigured" and
            // satisfies nothing. Because the role can change independently, an
            // override GRANT must secure its prerequisites at the override level
            // (an override-granted dependent needs its prereqs override-granted;
            // an override-granted prereq can't be un-granted while depended on).
            // Delta-aware: block only violations this change introduces.
            const existing = await getUserOverrides(userId);
            const grantsOnly = (ov) => {
                const e = {};
                for (const [k, v] of Object.entries(ov)) if (v === 1) e[k] = true;
                return e;
            };
            const merged = { ...existing };
            for (const [key, value] of Object.entries(permissions)) {
                if (!ALL_PERMISSIONS.includes(key)) continue;
                const v = parseInt(value);
                if (v === 0) delete merged[key]; else merged[key] = v;
            }
            const before = new Set(validatePermissionSet(grantsOnly(existing)).map((v) => v.key));
            const newViolations = validatePermissionSet(grantsOnly(merged)).filter((v) => !before.has(v.key));
            if (newViolations.length) {
                return res.status(422).json({ error: 'Some permissions are missing their prerequisites.', violations: newViolations });
            }
            // Apply.
            for (const [key, value] of Object.entries(permissions)) {
                if (!ALL_PERMISSIONS.includes(key)) continue;
                await setUserOverride(userId, key, parseInt(value));
            }
        }

        res.status(204).end();
    } catch (err) {
        console.error('API update permissions error:', err);
        res.status(500).json({ error: 'Failed to update permissions' });
    }
});

// GET /api/admin/users/:id/sessions
router.get('/admin/users/:id/sessions', requireAuth, checkPermission('changeUser'), requireStepup('user'), checkPermissionLevel, async (req, res) => {
    try {
        const sessions = await getUserSessions(req.params.id);
        const sanitized = sessions.map(s => ({
            deviceName: formatUserAgent(s.user_agent),
            ip_address: s.ip_address,
            last_seen: s.last_seen,
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
router.post('/admin/users/:id/sessions/terminate-all', requireAuth, checkPermission('changeUser'), requireStepup('user'), checkPermissionLevel, async (req, res) => {
    try {
        if (blockSelfTarget(req, res)) return;
        await deleteUserSessions(req.params.id);
        res.status(204).end();
    } catch (err) {
        console.error('API terminate sessions error:', err);
        res.status(500).json({ error: 'Failed to terminate sessions' });
    }
});

// ==========================================================================
//  ENROLLMENT
// ==========================================================================

// GET /api/admin/enrollment — student-first, two shapes:
//   • no query          → { students, courses } — the selector list + every
//                          course (mapped thin, sorted course_code then id).
//   • ?userId=<hex>      → { enrolledCourseIds } — the target's enrolled course
//                          ids as an int array, after the authority guard.
router.get('/admin/enrollment', requireAuth, checkPermission('manageEnrolment'), requireStepup('enrollment'), async (req, res) => {
    try {
        const actingLevel = res.locals.user.permission_level;
        const userId = req.query.userId;

        if (userId) {
            // Same target-authority guard as the mutation endpoints:
            // 404 if the user has no role (i.e. doesn't exist); 403 if the
            // acting admin isn't strictly higher authority (smaller level).
            const targetBundle = await resolveAuthBundle(userId);
            if (!targetBundle.role_id) {
                return res.status(404).json({ error: 'User not found' });
            }
            if (actingLevel >= targetBundle.permission_level) {
                return res.status(403).json({ error: 'Cannot manage enrollment for users with equal or higher authority' });
            }
            const enrolledCourseIds = (await getUserEnrollments(userId)).map(c => c.course_id);
            return res.json({ enrolledCourseIds });
        }

        // Selector payload: enrollable students + all courses (thin projection,
        // sorted course_code ASC then course_id ASC).
        const students = await getEnrollableStudents(actingLevel);
        const { courses } = await listCourses(1, 999);
        const thinCourses = courses
            .map(c => ({
                course_id: c.course_id,
                course_code: c.course_code,
                course_name: c.course_name,
                is_active: c.is_active,
            }))
            .sort((a, b) => {
                const byCode = String(a.course_code).localeCompare(String(b.course_code));
                return byCode !== 0 ? byCode : a.course_id - b.course_id;
            });

        res.json({ students, courses: thinCourses });
    } catch (err) {
        console.error('API enrollment error:', err);
        res.status(500).json({ error: 'Failed to load enrollment data.' });
    }
});

// POST /api/admin/enrollment — add or remove
router.post('/admin/enrollment', requireAuth, checkPermission('manageEnrolment'), requireStepup('enrollment'), async (req, res) => {
    try {
        const { action, userId, courseId } = req.body;

        if (!userId || !courseId) {
            return res.status(400).json({ error: 'User and course are required' });
        }

        // Check target user's permission level via the cached two-tier resolver
        // (user:perms → role:perms) — no DB JOIN per enrollment change.
        const targetBundle = await require('../../services/permissionService').resolveAuthBundle(userId);
        if (!targetBundle.role_id) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (res.locals.user.permission_level >= targetBundle.permission_level) {
            return res.status(403).json({ error: 'Cannot manage enrollment for users with equal or higher authority' });
        }

        if (action === 'add') {
            await addEnrollment(userId, courseId);
        } else if (action === 'remove') {
            await removeEnrollment(userId, courseId);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API enrollment update error:', err);
        res.status(500).json({ error: 'Failed to update enrollment' });
    }
});

// POST /api/admin/enrollment/batch — commit staged adds/removes for one student
// in a single atomic transaction. Body: { userId, adds: [courseId], removes:
// [courseId] }. Guards the target the same way as the single endpoint (404 no
// role, 403 acting level >= target level). Responds 200 with the fresh enrolled
// course_id set so the client reconciles without a second GET.
const MAX_BATCH_IDS = 1000; // sane upper bound (course counts are small); guards against pathological payloads
router.post('/admin/enrollment/batch', requireAuth, checkPermission('manageEnrolment'), requireStepup('enrollment'), async (req, res) => {
    try {
        const { userId, adds, removes } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User is required' });
        }
        if ((adds !== undefined && !Array.isArray(adds)) || (removes !== undefined && !Array.isArray(removes))) {
            return res.status(400).json({ error: 'adds and removes must be arrays' });
        }
        const addsArr = Array.isArray(adds) ? adds : [];
        const removesArr = Array.isArray(removes) ? removes : [];
        if (addsArr.length > MAX_BATCH_IDS || removesArr.length > MAX_BATCH_IDS) {
            return res.status(400).json({ error: 'Too many changes in one batch' });
        }

        // Target-authority guard (cached two-tier resolver): 404 no role, 403 if
        // the acting admin isn't strictly higher authority (smaller level).
        const targetBundle = await resolveAuthBundle(userId);
        if (!targetBundle.role_id) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (res.locals.user.permission_level >= targetBundle.permission_level) {
            return res.status(403).json({ error: 'Cannot manage enrollment for users with equal or higher authority' });
        }

        const enrolledCourseIds = await setEnrollmentBatch(userId, addsArr, removesArr);
        res.status(200).json({ enrolledCourseIds });
    } catch (err) {
        console.error('API enrollment batch error:', err);
        res.status(500).json({ error: 'Failed to update enrollment' });
    }
});

// ==========================================================================
//  ROLES
// ==========================================================================

// GET /api/admin/roles — with permissions
router.get('/admin/roles', requireAuth, checkPermission('manageRoles'), requireStepup('roles'), async (req, res) => {
    try {
        const roles = await listRoles();

        // Load permissions for each role
        const rolePermissions = {};
        for (const r of roles) {
            rolePermissions[r.role_id] = await getRolePermissions(r.role_id);
        }

        // Per-role member counts + which role is the registration default (for
        // the "N members" line + the "default" pill).
        const [countRows] = await getPool().execute('SELECT role_id, COUNT(*) AS n FROM users GROUP BY role_id');
        const memberCounts = {};
        for (const row of countRows) memberCounts[row.role_id] = row.n;
        const { getSetting } = require('../../services/cache/settingsCache');
        const defRaw = parseInt(await getSetting('registration_default_role', ''), 10);

        res.json({
            roles, rolePermissions, memberCounts,
            defaultRoleId: Number.isInteger(defRaw) ? defRaw : null,
            allPermissions: ALL_PERMISSIONS, permissionPrereqs: PERMISSION_PREREQS,
            adminPermissions: res.locals.user.permissions,
        });
    } catch (err) {
        console.error('API roles error:', err);
        res.status(500).json({ error: 'Failed to load roles.' });
    }
});

// POST /api/admin/roles — create
router.post('/admin/roles', requireAuth, checkPermission('manageRoles'), requireStepup('roles'), async (req, res) => {
    try {
        const { roleName, permissionLevel, description } = req.body;
        const level = parseInt(permissionLevel);

        if (!roleName || !String(roleName).trim()) {
            return res.status(400).json({ error: 'Role name is required' });
        }
        if (isNaN(level) || level < 0 || level > 9999) {
            return res.status(400).json({ error: 'Permission level must be between 0 and 9999' });
        }
        // A new role must be strictly LOWER privilege than the creator (higher
        // number). Superadmin (level 0) can never be recreated this way.
        if (level <= res.locals.user.permission_level) {
            return res.status(403).json({ error: 'Cannot create a role with equal or higher authority' });
        }
        const name = String(roleName).trim();
        if (await roleNameExists(name)) {
            return res.status(409).json({ error: 'Role name already exists' });
        }
        if (await permissionLevelExists(level)) {
            return res.status(409).json({ error: 'Permission level already exists' });
        }

        // The backend assigns the id. getNextRoleId (MAX+1) isn't atomic with the
        // INSERT, so two concurrent creates can pick the same id — the loser hits
        // the PK and retries with a fresh id.
        let id;
        for (let attempt = 0; ; attempt++) {
            id = await getNextRoleId();
            try { await createRole(id, name, level, description ? String(description) : null); break; }
            catch (e) {
                if (attempt < 4 && (e.code === 'ER_DUP_ENTRY' || /duplicate/i.test(e.message || ''))) continue;
                throw e;
            }
        }

        // Seed from the DEFAULT role's grants, filtered to keys the creator holds
        // (drop any that then violate prereqs). If seeding fails, roll the role
        // back so a same-name/level retry isn't blocked by an orphan.
        try {
            const adminPerms = res.locals.user.permissions;
            const { getSetting } = require('../../services/cache/settingsCache');
            const defaultId = parseInt(await getSetting('registration_default_role', ''), 10);
            const preset = {};
            for (const key of ALL_PERMISSIONS) preset[key] = false;
            if (Number.isInteger(defaultId)) {
                const defaultPerms = await getRolePermissions(defaultId);
                for (const key of ALL_PERMISSIONS) preset[key] = !!(defaultPerms[key] && adminPerms[key]);
            }
            for (const v of validatePermissionSet(preset)) preset[v.key] = false;
            await setRolePermissions(id, preset);
        } catch (seedErr) {
            try {
                await getPool().execute('DELETE FROM roles WHERE role_id = ?', [id]);
                require('../../services/ssoEvents').reportRoles().catch(() => {});
            } catch { /* best-effort rollback */ }
            throw seedErr;
        }

        res.status(201).json({ role_id: id });
    } catch (err) {
        console.error('API create role error:', err);
        res.status(500).json({ error: 'Failed to create role' });
    }
});

// PUT /api/admin/roles/:id — update
router.put('/admin/roles/:id', requireAuth, checkPermission('manageRoles'), requireStepup('roles'), async (req, res) => {
    try {
        const roleId = parseInt(req.params.id);
        const { roleName, permissionLevel, description, permissions } = req.body;

        const role = await getRoleById(roleId);
        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }

        // Cannot edit roles with equal or higher authority
        if (role.permission_level <= res.locals.user.permission_level) {
            return res.status(403).json({ error: 'Cannot edit a role with equal or higher authority' });
        }

        const updates = {};

        if (roleName && roleName !== role.role_name) {
            if (await roleNameExists(roleName, roleId)) {
                return res.status(409).json({ error: 'Role name already exists' });
            }
            updates.role_name = roleName;
        }
        if (permissionLevel !== undefined && permissionLevel !== '') {
            const level = parseInt(permissionLevel);
            if (isNaN(level) || level < 0 || level > 9999) {
                return res.status(400).json({ error: 'Permission level must be between 0 and 9999' });
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

        const effectiveRoleId = roleId;

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
            // Block only NEW prerequisite violations. A pre-existing violation
            // (e.g. on a key the admin can't edit) must not wedge every future
            // edit — those are surfaced red in the UI and fixed deliberately.
            const before = new Set(validatePermissionSet(currentPerms).map((v) => v.key));
            const newViolations = validatePermissionSet(permMap).filter((v) => !before.has(v.key));
            if (newViolations.length) {
                return res.status(422).json({ error: 'Some permissions are missing their prerequisites.', violations: newViolations });
            }
            await setRolePermissions(effectiveRoleId, permMap);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API update role error:', err);
        res.status(500).json({ error: err.message || 'Failed to update role' });
    }
});

// DELETE /api/admin/roles/:id — delete. Removing the role that is currently
// the DEFAULT requires the caller to name its replacement: 409 default_role
// prompts the client, which re-sends with { new_default: <role_id | null> }.
// null/'' = blank default (No access — the SSO stores default_role_id NULL,
// a first-class deny-safe state). The setting change rides the same
// full-state roles.sync the deletion itself queues.
router.delete('/admin/roles/:id', requireAuth, checkPermission('manageRoles'), requireStepup('roles'), async (req, res) => {
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

        const { getSetting } = require('../../services/cache/settingsCache');
        const currentDefault = parseInt(await getSetting('registration_default_role', ''), 10);
        if (currentDefault === roleId) {
            const provided = req.body ? req.body.new_default : undefined;
            if (provided === undefined) {
                return res.status(409).json({ error: 'default_role', message: 'This role is the default role — pick a replacement (or blank for no access) first.' });
            }
            if (provided === null || provided === '') {
                await setSetting('registration_default_role', '');
            } else {
                const newId = parseInt(provided, 10);
                const newRole = Number.isInteger(newId) && newId !== roleId ? await getRoleById(newId) : null;
                if (!newRole) {
                    return res.status(422).json({ error: 'Invalid replacement default role' });
                }
                if (newRole.permission_level <= res.locals.user.permission_level) {
                    return res.status(403).json({ error: 'Cannot set the default to a role with equal or higher privilege' });
                }
                await setSetting('registration_default_role', String(newId));
            }
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

// GET /api/admin/settings — site settings, sliced per pane. The SettingsPage
// loads each pane lazily (?pane=general|transcoding|cloudflare|workers) so a
// pane switch re-runs the step-up gate independently (blocking only the pane
// you land on, without clobbering another pane's unsaved edits). No ?pane (or
// an unknown one) returns the full blob for back-compat. The gate wraps the
// whole route, so every slice honours the 'settings' scenario the same way.
router.get('/admin/settings', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const pool = getPool();
        const pane = typeof req.query.pane === 'string' ? req.query.pane : null;

        // Site identity / session / registration fields + the role list the
        // General pane needs for its default-role picker.
        const buildGeneral = async () => {
            const [settings] = await pool.execute('SELECT * FROM site_settings ORDER BY setting_key');
            const [roles] = await pool.execute('SELECT role_id, role_name, permission_level FROM roles ORDER BY permission_level ASC');
            const settingsMap = {};
            for (const s of settings) settingsMap[s.setting_key] = s.setting_value;
            // Strip secrets + anything owned by another pane / returned separately.
            delete settingsMap.hmac_secret_key;
            delete settingsMap.video_hmac_enabled;
            delete settingsMap.video_hmac_token_validity;
            for (const key of Object.keys(settingsMap)) {
                if (key.startsWith('mfa_') || key.startsWith('audio_normalization_') || key === 'audio_bitrate_default') {
                    delete settingsMap[key];
                }
            }
            return { settings: settingsMap, roles };
        };

        // The Cloudflare sub-object — existence flags, toggle state, and the
        // token-validity/R2-domain values the WAF rule builder needs. r2_public_domain
        // is an env-sourced infra detail, not a tenant toggle.
        const buildCloudflare = async () => {
            const [rows] = await pool.execute(
                "SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('video_hmac_enabled', 'hmac_secret_key', 'video_hmac_token_validity')");
            const m = {};
            for (const s of rows) m[s.setting_key] = s.setting_value;
            return {
                cloudflare: {
                    video_hmac_enabled: m.video_hmac_enabled === 'true',
                    video_hmac_secret_configured: !!m.hmac_secret_key,
                    video_hmac_token_validity: m.video_hmac_token_validity || '600',
                    r2_public_domain: process.env.R2_PUBLIC_DOMAIN || '',
                },
            };
        };

        const buildWorkers = async () => {
            const workerKeys = await listWorkerKeys();
            // Strip key_secret (only shown once at creation).
            return { workerKeys: workerKeys.map(k => { const { key_secret, ...rest } = k; return rest; }) };
        };

        const buildTranscoding = async () => ({
            defaultProfiles: await getDefaultGlobalProfiles(),
            enhancedProfiles: await getEnhancedGlobalProfiles(),
            audioNormalization: await getAudioNormalizationSettings(),
            audioBitrateKbps: await getAudioBitrateDefault(),
        });

        let payload;
        if (pane === 'general') payload = await buildGeneral();
        else if (pane === 'cloudflare') payload = await buildCloudflare();
        else if (pane === 'workers') payload = await buildWorkers();
        else if (pane === 'transcoding') payload = await buildTranscoding();
        else {
            const [g, cf, wk, tc] = await Promise.all([buildGeneral(), buildCloudflare(), buildWorkers(), buildTranscoding()]);
            payload = { ...g, ...cf, ...wk, ...tc };
        }
        res.json(payload);
    } catch (err) {
        console.error('API settings error:', err);
        res.status(500).json({ error: 'Failed to load settings.' });
    }
});

// PUT /api/admin/settings — save general settings (partial updates)
router.put('/admin/settings', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const pool = getPool();
        const allowedKeys = [
            'site_name', 'site_protocol', 'site_hostname',
            'session_inactivity_days', 'session_max_days',
            'registration_default_role',
        ];

        // Build updates from only the fields present in the request
        const updates = {};
        for (const key of allowedKeys) {
            if (req.body[key] === undefined) continue;
            if (key === 'site_hostname') {
                updates.site_hostname = stripToHost(req.body.site_hostname);
            } else if (key === 'site_protocol') {
                updates.site_protocol = req.body.site_protocol || 'https';
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
            } else if (!isValidHost(updates.site_hostname)) {
                errors.site_hostname = 'Enter a valid hostname or IP address (no spaces, slashes, or path)';
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

        // Default role: blank = No access (a first-class state — the SSO stores
        // default_role_id NULL and refuses sign-in for users who resolve to it).
        if (updates.registration_default_role !== undefined && updates.registration_default_role.trim() !== '') {
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
        await require('../../services/cache/settingsCache').invalidate();

        // The default role AND our display name ride the same full-state
        // report the SSO mirrors — report on either change.
        if (updates.registration_default_role !== undefined || updates.site_name !== undefined) {
            require('../../services/ssoEvents').reportRoles().catch(() => {});
        }

        res.status(204).end();
    } catch (err) {
        console.error('API save settings error:', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Shared validator for a global-profile PUT payload. Returns either { error }
// or a normalized profiles array. The system-row guard prevents the client
// from sneaking a system row out by dropping it from the payload or flipping
// is_system_profile to 0 on the wire.
async function parseAndGuardGlobalProfiles(profiles, enhanced) {
    if (!Array.isArray(profiles) || profiles.length === 0) {
        return { error: 'At least one profile is required' };
    }
    const out = [];
    const dbFlagsByIdPromise = getSystemFlagsByIds(
        profiles.map(p => p.profile_id).filter(id => Number.isInteger(id))
    );
    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        const parsed = {
            name: (p.name || '').trim(),
            width: parseInt(p.width, 10),
            height: parseInt(p.height, 10),
            video_bitrate_kbps: parseInt(p.video_bitrate_kbps, 10),
            fps_limit: p.fps_limit !== undefined ? parseInt(p.fps_limit, 10) : 60,
            segment_duration: p.segment_duration !== undefined ? parseInt(p.segment_duration, 10) : 6,
            gop_seconds: p.gop_seconds !== undefined ? parseFloat(p.gop_seconds) : 2.00,
        };
        const errors = validateProfile(parsed);
        if (errors.length > 0) {
            return { error: `Profile ${i + 1}: ${errors.join(', ')}` };
        }
        out.push({ ...p, ...parsed });
    }
    const dbFlagsById = await dbFlagsByIdPromise;
    // Re-stamp is_system_profile from the DB for any row that carried a
    // profile_id (i.e., it's an existing row). New rows default to 0.
    for (const row of out) {
        if (Number.isInteger(row.profile_id) && dbFlagsById.has(row.profile_id)) {
            row.is_system_profile = dbFlagsById.get(row.profile_id);
        } else {
            row.is_system_profile = 0;
        }
    }
    // Reject payloads that dropped a system row.
    const incomingSystemCount = out.filter(r => r.is_system_profile === 1).length;
    const dbSystemCount = await countSystemRows(enhanced);
    if (incomingSystemCount < dbSystemCount) {
        return { error: 'system_profile_missing: cannot drop a system profile from this set' };
    }
    return { profiles: out };
}

// PUT /api/admin/settings/transcoding-profiles/default — save default-quality
// global set + (optionally) audio normalization + site-wide audio bitrate.
// Audio settings ride on the default endpoint for back-compat; the enhanced
// endpoint handles only its profile array.
router.put('/admin/settings/transcoding-profiles/default', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const { profiles, audioNormalization, audioBitrateKbps } = req.body;
        const result = await parseAndGuardGlobalProfiles(profiles, false);
        if (result.error) return res.status(400).json({ error: result.error });

        // Validate the site-wide audio bitrate before we touch the DB.
        let audioBitrateParsed = null;
        if (audioBitrateKbps !== undefined) {
            audioBitrateParsed = parseInt(audioBitrateKbps, 10);
            const errors = validateAudioBitrate(audioBitrateParsed);
            if (errors.length > 0) {
                return res.status(400).json({ error: errors.join(', ') });
            }
        }

        await saveDefaultGlobalProfiles(result.profiles);

        if (audioNormalization) {
            const target = parseFloat(audioNormalization.target);
            const peak = parseFloat(audioNormalization.peak);
            const maxGain = parseFloat(audioNormalization.maxGain);
            if (isNaN(target) || target < -50 || target > 0) return res.status(400).json({ error: 'Target loudness must be between -50 and 0' });
            if (isNaN(peak) || peak < -20 || peak > 0) return res.status(400).json({ error: 'True peak must be between -20 and 0' });
            if (isNaN(maxGain) || maxGain < 0 || maxGain > 40) return res.status(400).json({ error: 'Max gain must be between 0 and 40' });
            await saveAudioNormalizationSettings({ target: String(target), peak: String(peak), maxGain: String(maxGain) });
        }

        if (audioBitrateParsed !== null) {
            await saveAudioBitrateDefault(audioBitrateParsed);
        }

        res.status(204).end();
    } catch (err) {
        console.error('API save default transcoding profiles error:', err);
        res.status(500).json({ error: 'Failed to save default transcoding profiles' });
    }
});

// PUT /api/admin/settings/transcoding-profiles/enhanced — save enhanced-quality
// global set. Profile array only; audio settings live on the /default endpoint.
router.put('/admin/settings/transcoding-profiles/enhanced', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const { profiles } = req.body;
        const result = await parseAndGuardGlobalProfiles(profiles, true);
        if (result.error) return res.status(400).json({ error: result.error });
        await saveEnhancedGlobalProfiles(result.profiles);
        res.status(204).end();
    } catch (err) {
        console.error('API save enhanced transcoding profiles error:', err);
        res.status(500).json({ error: 'Failed to save enhanced transcoding profiles' });
    }
});

// POST /api/admin/settings/video-hmac/generate — generate new HMAC secret key
router.post('/admin/settings/video-hmac/generate', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const secret = await generateSecretKey();
        res.json({ success: true, secret });
    } catch (err) {
        console.error('API generate HMAC key error:', err);
        res.status(500).json({ error: 'Failed to generate HMAC secret key' });
    }
});

// PUT /api/admin/settings/video-hmac/validity — update video-HMAC token validity hint
router.put('/admin/settings/video-hmac/validity', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const val = parseInt(req.body.video_hmac_token_validity, 10);
        if (!val || val < 600) {
            return res.status(400).json({ error: 'Token validity must be at least 600 seconds' });
        }
        await setSetting('video_hmac_token_validity', String(val));
        res.status(204).end();
    } catch (err) {
        console.error('API save HMAC validity error:', err);
        res.status(500).json({ error: 'Failed to save token validity' });
    }
});

// PUT /api/admin/settings/video-hmac/toggle — enable/disable video-playback HMAC.
router.put('/admin/settings/video-hmac/toggle', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const enabled = req.body.video_hmac_enabled === 'true' || req.body.video_hmac_enabled === true;
        if (enabled && !(await isHmacConfigured())) {
            return res.status(400).json({ error: 'Cannot enable HMAC validation without a secret key. Generate a key first.' });
        }
        await setSetting('video_hmac_enabled', enabled ? 'true' : 'false');
        res.status(204).end();
    } catch (err) {
        console.error('API toggle HMAC error:', err);
        res.status(500).json({ error: 'Failed to toggle HMAC validation' });
    }
});

// POST /api/admin/settings/worker-keys — create worker key.
// Label is optional; the admin UI now collects it inside the post-click modal
// (with a blank-allowed input) rather than inline, so an empty body is normal.
router.post('/admin/settings/worker-keys', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const { label } = req.body || {};
        const { keyId, secret } = await generateWorkerKeyPair(label, res.locals.user.user_id);
        res.json({ keyId, secret });
    } catch (err) {
        console.error('API generate worker key error:', err);
        res.status(500).json({ error: 'Failed to generate worker key' });
    }
});

// POST /api/admin/settings/worker-keys/:keyId/pause — pause an active key.
// Worker keeps its current bearer token, polling returns empty, lease rejects.
//
// Rejects when the key is deactivated (409). UX hides the button in that
// case but a direct API call would otherwise quietly flip status='paused'
// on a security-disabled key — the worker is still locked out by the auth-
// time deactivated check, but the operator's mental model would diverge
// from what the row actually says.
router.post('/admin/settings/worker-keys/:keyId/pause', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const result = await pauseWorkerKey(req.params.keyId);
        if (!result.ok) {
            if (result.reason === 'not_found') return res.status(404).json({ error: 'Key not found' });
            if (result.reason === 'invalid_state') return res.status(409).json({ error: 'Key is deactivated; use Reactivate first.' });
            return res.status(500).json({ error: 'Failed to pause worker key' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('API pause worker key error:', err);
        res.status(500).json({ error: 'Failed to pause worker key' });
    }
});

// POST /api/admin/settings/worker-keys/:keyId/resume — unpause back to active.
//
// Strict precondition: status must be 'active' (idempotent no-op) or
// 'paused'. A 'deactivated' key would otherwise quietly skip the secret-
// rotation that reactivate forces — that's a direct bypass of leak
// detection, hence the 409 rather than a tolerant fallthrough.
router.post('/admin/settings/worker-keys/:keyId/resume', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const result = await resumeWorkerKey(req.params.keyId);
        if (!result.ok) {
            if (result.reason === 'not_found') return res.status(404).json({ error: 'Key not found' });
            if (result.reason === 'invalid_state') return res.status(409).json({ error: 'Key is deactivated; use Reactivate first.' });
            return res.status(500).json({ error: 'Failed to resume worker key' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('API resume worker key error:', err);
        res.status(500).json({ error: 'Failed to resume worker key' });
    }
});

// POST /api/admin/settings/worker-keys/:keyId/reactivate — bring a deactivated
// key back, but only via a forced secret rotation. The old secret (potentially
// compromised, since deactivation usually came from the leak detector) is
// invalidated; the new plaintext secret is returned once for the operator to
// copy into the worker's config.
//
// Server-side requires the key to actually be in 'deactivated' state — the
// client only renders the button for that status, but a direct API call from
// a hijacked admin session could otherwise hit this on an 'active' key and
// disrupt a healthy worker via the forced rotation. Returns 409 on a
// preconditioned-failed status.
router.post('/admin/settings/worker-keys/:keyId/reactivate', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const result = await reactivateWorkerKey(req.params.keyId);
        if (!result.ok) {
            if (result.reason === 'not_found') return res.status(404).json({ error: 'Key not found' });
            if (result.reason === 'not_deactivated') return res.status(409).json({ error: 'Key is not deactivated; cannot reactivate.' });
            return res.status(500).json({ error: 'Failed to reactivate worker key' });
        }
        res.json({ keyId: req.params.keyId, secret: result.secret });
    } catch (err) {
        console.error('API reactivate worker key error:', err);
        res.status(500).json({ error: 'Failed to reactivate worker key' });
    }
});

// POST /api/admin/settings/worker-keys/:keyId/rename — change the human label.
// Empty label is accepted (means "clear the label"). Client greys the
// Continue button when the value hasn't changed; the server doesn't enforce.
//
// Rejects when the key is deactivated — spec is "Reactivate + Delete only"
// in that column, and the UI hides Rename to match.
router.post('/admin/settings/worker-keys/:keyId/rename', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const { label } = req.body || {};
        const result = await renameWorkerKey(req.params.keyId, typeof label === 'string' ? label.trim() : '');
        if (!result.ok) {
            if (result.reason === 'not_found') return res.status(404).json({ error: 'Key not found' });
            if (result.reason === 'deactivated') return res.status(409).json({ error: 'Deactivated keys cannot be renamed.' });
            return res.status(500).json({ error: 'Failed to rename worker key' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('API rename worker key error:', err);
        res.status(500).json({ error: 'Failed to rename worker key' });
    }
});

// DELETE /api/admin/settings/worker-keys/:keyId — permanent delete. Replaces
// the old Revoke→Delete two-step. Works in any status; the client shows a
// confirmation warning before the call.
router.delete('/admin/settings/worker-keys/:keyId', requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const ok = await deleteWorkerKey(req.params.keyId);
        if (!ok) return res.status(404).json({ error: 'Key not found' });
        res.status(204).end();
    } catch (err) {
        console.error('API delete worker key error:', err);
        res.status(500).json({ error: 'Failed to delete worker key' });
    }
});

// ==========================================================================
//  PLAYBACK STATS  (distributed: per-course modal + per-user section)
// ==========================================================================
// The old global /admin/playback-stats drill-down page is gone. Stats now live
// where the entity lives. Every read overlays live Redis pending data on the
// flushed DB rows (see playbackStatsService).

// GET /api/admin/courses/:courseId/playback-stats
//   base        → { overall:{videos,videoCount,totalDuration,viewerCount}, students }
//   ?userId=HEX → { videos } for that student in this course
// View gate: manageCourse + viewPlaybackStat + the admin's OWN course access
// (allCourseAccess passes; otherwise must be enrolled) via requireCourseAccess.
router.get('/admin/courses/:courseId/playback-stats',
    requireAuth, checkPermission('manageCourse'), checkPermission('viewPlaybackStat'),
    requireCourseAccess, async (req, res) => {
    try {
        const courseId = parseInt(req.params.courseId, 10);
        if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course id' });
        if (req.query.userId) {
            const videos = await playbackStats.getUserVideoStats(courseId, req.query.userId);
            return res.json({ videos });
        }
        res.json(await playbackStats.getCourseStats(courseId));
    } catch (err) {
        console.error('API course playback stats error:', err);
        res.status(500).json({ error: 'Failed to load playback statistics.' });
    }
});

// DELETE /api/admin/courses/:courseId/playback-stats — reset the WHOLE course
// (all students). Gate: changeCourse + course access.
router.delete('/admin/courses/:courseId/playback-stats',
    requireAuth, checkPermission('changeCourse'),
    requireCourseAccess, async (req, res) => {
    try {
        const courseId = parseInt(req.params.courseId, 10);
        if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course id' });
        await playbackStats.resetCourse(courseId);
        res.status(204).end();
    } catch (err) {
        console.error('API reset course playback stats error:', err);
        res.status(500).json({ error: 'Failed to reset statistics' });
    }
});

// GET /api/admin/users/:id/playback-stats
//   base         → { courses } this user has watched (feeds the course selector)
//   ?courseId=N  → { videos } for this user in that course
// Gate mirrors the other edit-user sub-routes: changeUser + strictly-below.
router.get('/admin/users/:id/playback-stats',
    requireAuth, checkPermission('changeUser'), requireStepup('user'),
    checkPermissionLevel, async (req, res) => {
    try {
        if (req.query.courseId) {
            const courseId = parseInt(req.query.courseId, 10);
            if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course id' });
            const videos = await playbackStats.getUserVideoStats(courseId, req.params.id);
            return res.json({ videos });
        }
        res.json({ courses: await playbackStats.getUserWatchedCourses(req.params.id) });
    } catch (err) {
        console.error('API user playback stats error:', err);
        res.status(500).json({ error: 'Failed to load playback statistics.' });
    }
});

// DELETE /api/admin/users/:id/playback-stats — reset this student's stats.
//   ?courseId=N → only that course; otherwise ALL courses.
router.delete('/admin/users/:id/playback-stats',
    requireAuth, checkPermission('changeUser'), requireStepup('user'),
    checkPermissionLevel, async (req, res) => {
    try {
        if (req.query.courseId) {
            const courseId = parseInt(req.query.courseId, 10);
            if (!Number.isInteger(courseId)) return res.status(400).json({ error: 'Invalid course id' });
            await playbackStats.resetUserCourse(req.params.id, courseId);
        } else {
            await playbackStats.resetUser(req.params.id);
        }
        res.status(204).end();
    } catch (err) {
        console.error('API reset user playback stats error:', err);
        res.status(500).json({ error: 'Failed to reset statistics' });
    }
});

// DELETE /api/admin/playback-stats — global kill switch (lives in Site Settings).
// Was gated by the now-removed clearPlaybackStat; the site-wide reset is under
// manageSite. Wipes EVERY student's watch history AND resume positions.
router.delete('/admin/playback-stats',
    requireAuth, checkPermission('manageSite'), requireStepup('settings'), async (req, res) => {
    try {
        const pool = getPool();
        await pool.execute('DELETE FROM watch_progress');
        await require('../../services/cache/watchProgressCache').clearAll();
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
router.get('/admin/transcoding/jobs', requireAuth, checkPermission('manageSite'), requireStepup('transcoding'), async (req, res) => {
    try {
        const pool = getPool();

        // Get all non-cleared tasks with video, course, and (when leased)
        // worker-key info. LEFT JOIN on worker_access_keys so queued/unleased
        // rows (worker_key_id IS NULL) and hard-deleted-key rows still render.
        const [rows] = await pool.execute(
            `SELECT pq.task_id, pq.job_id, pq.status, pq.progress, pq.error_message,
                    pq.created_at AS upload_time, pq.leased_at,
                    pq.last_heartbeat, pq.error_at, pq.updated_at,
                    pq.worker_key_id,
                    wak.label AS worker_label,
                    v.title AS video_title, v.video_id, v.status AS video_status,
                    v.processing_progress AS video_progress,
                    c.course_code AS course_name
             FROM processing_queue pq
             JOIN videos v ON pq.video_id = v.video_id
             JOIN courses c ON v.course_id = c.course_id
             LEFT JOIN worker_access_keys wak ON pq.worker_key_id = wak.key_id
             WHERE pq.cleared = 0
             ORDER BY pq.created_at DESC`
        );

        // Overlay live progress from Redis for any in-flight job (heartbeats
        // land in Redis only between flushes — DB last_heartbeat / progress
        // can lag by up to one flush cycle).
        const transcodeCache = require('../../services/cache/transcodeProgressCache');
        const liveJobIds = rows.filter(r => r.job_id && r.status !== 'completed' && r.status !== 'error')
            .map(r => r.job_id);
        const live = await transcodeCache.getMany(liveJobIds);

        // Categorize jobs
        const errorJobs = [];
        const activeJobs = [];
        const finishedJobs = [];

        for (const row of rows) {
            const overlay = row.job_id ? live[row.job_id] : null;
            const job = {
                taskId: row.task_id,
                jobId: row.job_id,
                videoId: row.video_id,
                videoTitle: row.video_title,
                courseName: row.course_name,
                status: overlay?.queue_status || row.status,
                videoStatus: overlay?.video_status || row.video_status,
                progress: overlay?.progress ?? row.video_progress ?? row.progress ?? 0,
                errorMessage: row.error_message,
                uploadTime: row.upload_time,
                leasedAt: row.leased_at,
                lastHeartbeat: overlay?.last_heartbeat ? new Date(overlay.last_heartbeat) : row.last_heartbeat,
                errorAt: row.error_at,
                updatedAt: row.updated_at,
                workerKeyId: row.worker_key_id,
                workerLabel: row.worker_label,
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
router.post('/admin/transcoding/clear-finished', requireAuth, checkPermission('manageSite'), requireStepup('transcoding'), async (req, res) => {
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
