const { getPool, idBuf } = require('../config/database');
const videoCache = require('./cache/videoCache');
const courseCache = require('./cache/courseCache');
const courseListCache = require('./cache/courseListCache');

async function createCourse(courseCode, courseName, moduleLabel, createdBy) {
    const pool = getPool();

    // use_enhanced_profiles defaults to 0 (default-quality global set). New
    // courses opt into enhanced via the toggle on the edit page. module_label
    // is the term ('week'/'chapter'/…) shown next to each item's number.
    const [result] = await pool.execute(
        `INSERT INTO courses (course_code, course_name, module_label, created_by) VALUES (?, ?, ?, ?)`,
        [courseCode, courseName || null, moduleLabel || null, idBuf(createdBy)]
    );

    await courseListCache.invalidate();
    return { courseId: result.insertId };
}

async function getCourseById(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM courses WHERE course_id = ?',
        [courseId]
    );
    return rows[0] || null;
}

async function updateCourse(courseId, updates) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (updates.course_code !== undefined) { fields.push('course_code = ?'); values.push(updates.course_code); }
    if (updates.course_name !== undefined) { fields.push('course_name = ?'); values.push(updates.course_name); }
    if (updates.module_label !== undefined) { fields.push('module_label = ?'); values.push(updates.module_label); }
    if (updates.is_active !== undefined) { fields.push('is_active = ?'); values.push(updates.is_active); }
    if (updates.use_custom_profiles !== undefined) { fields.push('use_custom_profiles = ?'); values.push(updates.use_custom_profiles); }
    if (updates.use_enhanced_profiles !== undefined) { fields.push('use_enhanced_profiles = ?'); values.push(updates.use_enhanced_profiles); }
    if (updates.audio_normalization !== undefined) { fields.push('audio_normalization = ?'); values.push(updates.audio_normalization); }

    if (fields.length === 0) return;
    values.push(courseId);

    await pool.execute(
        `UPDATE courses SET ${fields.join(', ')} WHERE course_id = ?`,
        values
    );

    await courseCache.invalidate(courseId);
    await courseListCache.invalidate();
}

/**
 * Delete the course and persist its complete R2 cleanup plan atomically.
 * The parent lock fences new FK children; locking reads capture existing
 * source/output/upload targets before the cascade can erase them. Remote
 * effects happen after commit; an uncertain commit invalidates read-through
 * metadata only, without aborting writers or discarding buffered progress.
 */
async function deleteCourse(courseId) {
    const pool = getPool();
    const deletionService = require('./deletionService');
    const connection = await pool.getConnection();
    let reusable = true, commitStarted = false, alreadyAbsent = false;
    let transactionError;
    let videos = [], activeJobs = [], inflightSessions = [];
    let deletedCourseId = Number.isSafeInteger(Number(courseId)) ? Number(courseId) : courseId;
    const reportEffectFailure = (effect, error) => {
        const code = String(error?.code || error?.name || 'unknown');
        console.error('Course deletion follow-up effect failed:', {
            course_id: deletedCourseId, effect,
            error_code: /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : 'unknown',
        });
    };
    const bestEffort = async (effect, run) => {
        try { await run(); }
        catch (error) { reportEffectFailure(effect, error); }
    };
    // These caches can be refilled from SQL if a COMMIT did not take effect.
    // Liveness markers and unflushed watch deltas are deliberately excluded.
    const invalidateReadCaches = async () => {
        const effects = [
            ['course_cache', () => courseCache.invalidate(deletedCourseId)],
            ['course_list_cache', () => courseListCache.invalidate()],
        ];
        if (videos.length) effects.push(['video_cache', () => videoCache.invalidateMany(videos.map(video => video.video_id))]);
        await Promise.all(effects.map(([name, run]) => bestEffort(name, run)));
    };
    try {
        await connection.beginTransaction();
        const [courses] = await connection.execute(
            'SELECT course_id FROM courses WHERE course_id = ? FOR UPDATE', [courseId]
        );
        if (courses.length === 0) {
            alreadyAbsent = true;
        } else {
            // Use the canonical database ID in object prefixes, not a route string.
            deletedCourseId = courses[0].course_id;
            [videos] = await connection.execute(
                `SELECT video_id, hashed_video_id, r2_source_key, status
                 FROM videos WHERE course_id = ? FOR UPDATE`, [deletedCourseId]
            );
            const [jobs] = await connection.execute(
                `SELECT pq.video_id, pq.job_id, pq.status FROM processing_queue pq
                 JOIN videos v ON pq.video_id = v.video_id
                 WHERE v.course_id = ? FOR UPDATE`, [deletedCourseId]
            );
            // Lock queued/pending rows too: a lease must not appear between the
            // cleanup snapshot and cascade while only active rows were protected.
            activeJobs = jobs.filter(job => ['leased', 'processing'].includes(job.status) && job.job_id != null);
            [inflightSessions] = await connection.execute(
                `SELECT upload_id, type, object_key, r2_upload_id FROM upload_sessions
                 WHERE course_id = ? AND status IN ('active', 'completing') FOR UPDATE`,
                [deletedCourseId]
            );

            const now = new Date();
            const delayedAt = new Date(now.getTime() + 2 * 60 * 1000);
            const attachmentAt = new Date(now.getTime() + 60 * 1000);
            const activeVideoIds = new Set(activeJobs.map(job => String(job.video_id)));
            const processingStatuses = new Set(['worker_downloading', 'processing', 'worker_uploading']);
            const plan = new Map();
            const add = (mode, target, executeAt, hash = null) => {
                const id = `${mode}:${target}`;
                const previous = plan.get(id);
                // Overlapping intent must keep the longer in-flight-write buffer.
                if (!previous || previous.executeAt < executeAt) {
                    plan.set(id, { mode, target, executeAt, hash });
                }
            };
            const invalidTarget = () => Object.assign(
                new Error('Cannot delete course: unsupported cleanup target'),
                { code: 'invalid_cleanup_target' }
            );
            for (const video of videos) {
                if (video.r2_source_key) {
                    // New and replacement uploads use one base62 upload directory.
                    // Never turn an unknown/legacy key into a broader parent sweep.
                    const match = /^source\/([A-Za-z0-9]{12})\/source\.[^/]+$/.exec(video.r2_source_key);
                    if (!match) throw invalidTarget();
                    add('prefix', `source/${match[1]}/`, now);
                }
                if (!/^[A-Za-z0-9]{64}$/.test(video.hashed_video_id)) throw invalidTarget();
                const inFlight = processingStatuses.has(video.status) || activeVideoIds.has(String(video.video_id));
                add('prefix', `${video.hashed_video_id}/`, inFlight ? delayedAt : now, video.hashed_video_id);
            }
            for (const session of inflightSessions) {
                if (session.type === 'attachment') {
                    const prefix = `attachments/${deletedCourseId}/`;
                    if (!session.object_key.startsWith(prefix) || session.object_key.length === prefix.length) {
                        throw invalidTarget();
                    }
                    add('key', session.object_key, attachmentAt);
                }
            }
            add('prefix', `attachments/${deletedCourseId}/`, now);
            // Posters can exist before completion and while an aborted writer
            // is cancelling, even when no video currently reports processing.
            add('prefix', `posters/${deletedCourseId}/`, delayedAt);

            // All INSERTs and the destructive cascade use the same transaction.
            // The reaper cannot observe these intents until the delete commits.
            for (const item of plan.values()) {
                const opts = { connection, source: 'course_delete', execute_at: item.executeAt };
                if (item.hash) opts.hashed_video_id = item.hash;
                if (item.mode === 'key') await deletionService.enqueueKey(item.target, opts);
                else await deletionService.enqueuePrefix(item.target, opts);
            }
            await connection.execute('DELETE FROM courses WHERE course_id = ?', [deletedCourseId]);
        }
        commitStarted = true;
        await connection.commit();
    } catch (error) {
        // A lost COMMIT response is ambiguous. The DB still commits course
        // and cleanup plan together; invalidate safe metadata after releasing
        // the connection, without claiming the rollback proved an outcome.
        try { await connection.rollback(); }
        catch { reusable = false; connection.destroy(); }
        transactionError = error;
    } finally {
        if (reusable) connection.release();
    }
    if (transactionError) {
        if (commitStarted) await invalidateReadCaches();
        throw transactionError;
    }
    if (alreadyAbsent) {
        // A retry after a lost response can still remove stale course/list
        // metadata even though the original child IDs are no longer in SQL.
        await invalidateReadCaches();
        return;
    }

    const videoIds = videos.map(video => video.video_id);
    const effects = [
        ['video_cache', () => videoCache.invalidateMany(videoIds)],
        ['course_cache', () => courseCache.invalidate(deletedCourseId)],
        ['course_list_cache', () => courseListCache.invalidate()],
        ['watch_progress_cache', () => require('./cache/watchProgressCache').clearForVideos(videoIds)],
        ['transcode_cache', () => require('./cache/transcodeProgressCache').clearJobs(activeJobs.map(job => job.job_id))],
    ];
    for (const job of activeJobs) effects.push(['stale_timer', () => require('./processingService').clearStaleTimer(job.job_id)]);
    for (const session of inflightSessions) {
        effects.push(['upload_heartbeat', () => require('./cache/uploadHeartbeatCache').clearHeartbeat(session.upload_id)]);
        if (session.type === 'video') {
            // Preserve nonblocking multipart cancellation, after the SQL
            // decision is durable. Failures are visible without undoing it.
            void bestEffort('multipart_abort', () => require('./uploadService').abortMultipartUpload(session.object_key, session.r2_upload_id));
        }
    }
    await Promise.all(effects.map(([name, run]) => bestEffort(name, run)));
}

async function listCourses(page = 1, limit = 10) {
    const pool = getPool();
    const offset = (page - 1) * limit;

    const lim = parseInt(limit);
    const off = parseInt(offset);
    const [countRows] = await pool.execute('SELECT COUNT(*) as total FROM courses');
    const [rows] = await pool.query(
        `SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) as video_count
         FROM courses c ORDER BY c.created_at DESC LIMIT ${lim} OFFSET ${off}`
    );

    return {
        courses: rows,
        total: countRows[0].total,
        page,
        totalPages: Math.ceil(countRows[0].total / limit)
    };
}

// Admin course list — every course the caller may administer, in one array
// (the admin CoursesPage fit-height-paginates client-side, so no LIMIT/OFFSET).
// Enrollment-scoped EXACTLY like GET /api/courses (routes/api/pages.js): with
// allCourseAccess → all courses; otherwise JOIN enrollments on the caller's
// user_id (same binary-UUID binding). Unlike the student surface there is NO
// is_active filter — an admin must still see (and reopen) courses they've
// flipped Inactive. Video + material counts ride along as correlated
// subqueries. Ordered by course code then course_id for a stable list.
async function listCoursesForAdmin(userId, hasAllCourseAccess) {
    const pool = getPool();

    if (hasAllCourseAccess) {
        const [rows] = await pool.execute(
            `SELECT c.*,
                (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) AS video_count,
                (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id) AS material_count
             FROM courses c
             ORDER BY c.course_code ASC, c.course_id ASC`
        );
        return rows;
    }

    const [rows] = await pool.execute(
        `SELECT c.*,
            (SELECT COUNT(*) FROM videos v WHERE v.course_id = c.course_id) AS video_count,
            (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id) AS material_count
         FROM courses c
         JOIN enrollments e ON c.course_id = e.course_id
         WHERE e.user_id = ?
         ORDER BY c.course_code ASC, c.course_id ASC`,
        [idBuf(userId)]
    );
    return rows;
}

// List courses the user has access to (for admin views that require course enrollment)
async function listUserCourses(userId, hasAllCourseAccess) {
    const pool = getPool();
    if (hasAllCourseAccess) {
        const [rows] = await pool.execute(
            'SELECT * FROM courses ORDER BY created_at DESC'
        );
        return rows;
    }

    const [rows] = await pool.execute(
        `SELECT c.* FROM courses c
         JOIN enrollments e ON c.course_id = e.course_id
         WHERE e.user_id = ?
         ORDER BY c.created_at DESC`,
        [idBuf(userId)]
    );
    return rows;
}

module.exports = {
    createCourse,
    getCourseById,
    updateCourse,
    deleteCourse,
    listCourses,
    listCoursesForAdmin,
    listUserCourses
};
