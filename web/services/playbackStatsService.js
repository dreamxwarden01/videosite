// Playback-stats reads + scoped resets. Replaces the old global
// /admin/playback-stats drill-down page: stats now live where the entity lives
// — a per-course modal (course page) and a per-user section (edit-user page).
//
// Every read overlays the DB's flushed watch_progress rows with the live
// Redis write-coalescing cache (progress:watch:*), exactly like the old page,
// so numbers reflect up-to-the-second activity, not 15-min-stale flushed data.
// watch_progress.user_id is BINARY(16) (the SSO sub) — bind via idBuf(); the
// pool's typeCast returns it as canonical 32-char lower-hex, which is also the
// form the Redis keys use (recordProgress(user.user_id, …)).

const { getPool, idBuf } = require('../config/database');
const watchProgressCache = require('./cache/watchProgressCache');

// Merge a DB datetime and a pending epoch-ms into the later of the two, as a
// UTC ISO string (or null). The client converts to local + formats.
function laterIso(dbVal, pendingMs) {
    const dbMs = dbVal ? new Date(dbVal).getTime() : 0;
    const pMs = pendingMs || 0;
    const best = Math.max(dbMs, pMs);
    return best > 0 ? new Date(best).toISOString() : null;
}

// ---- Course-scoped: the modal off the course page -----------------------

// Overall (per-video aggregates) + the student roster for a course. Students
// shown: everyone ENROLLED, plus non-enrolled users who have allCourseAccess
// AND have watched a video in this course (they bypass enrollment, so they'd
// otherwise be invisible). Each carries their total watch time FOR THIS COURSE.
async function getCourseStats(courseId) {
    const pool = getPool();

    // Same "Default" DESCENDING order the admin video list uses (routes/api/
    // admin.js GET .../videos): module_number DESC, then lecture_date DESC, then
    // video_id DESC, with NULL module/date sunk to the bottom.
    const [videos] = await pool.execute(
        `SELECT video_id, title, duration_seconds
         FROM videos WHERE course_id = ?
         ORDER BY (module_number IS NULL) ASC, CAST(module_number AS UNSIGNED) DESC,
                  (lecture_date IS NULL) ASC, lecture_date DESC, video_id DESC`,
        [courseId]
    );
    const videoIds = new Set(videos.map((v) => v.video_id));

    // Raw watch rows for this course (user_id comes back as lower-hex).
    const [rows] = await pool.execute(
        `SELECT wp.user_id, wp.video_id, wp.watch_seconds, wp.last_watch_at
         FROM watch_progress wp
         JOIN videos v ON wp.video_id = v.video_id
         WHERE v.course_id = ?`,
        [courseId]
    );

    const pending = await watchProgressCache.getAllPending();

    // Per-video aggregate: distinct viewers + total watched.
    const perVideo = new Map();
    for (const id of videoIds) perVideo.set(id, { viewers: new Set(), total: 0 });
    // Per-user (this course) totals + last activity.
    const perUser = new Map();
    const bumpUser = (uid, secs, whenMs) => {
        let e = perUser.get(uid);
        if (!e) { e = { total: 0, lastMs: 0 }; perUser.set(uid, e); }
        e.total += secs;
        if (whenMs > e.lastMs) e.lastMs = whenMs;
    };

    for (const r of rows) {
        const secs = parseFloat(r.watch_seconds) || 0;
        const whenMs = r.last_watch_at ? new Date(r.last_watch_at).getTime() : 0;
        const pv = perVideo.get(r.video_id);
        if (pv) { pv.viewers.add(r.user_id); pv.total += secs; }
        bumpUser(r.user_id, secs, whenMs);
    }
    // Overlay pending for videos in this course.
    for (const [member, data] of Object.entries(pending)) {
        const idx = member.lastIndexOf(':');
        const uid = member.slice(0, idx);
        const vid = parseInt(member.slice(idx + 1), 10);
        if (!videoIds.has(vid)) continue;
        const pv = perVideo.get(vid);
        if (pv) { pv.viewers.add(uid); pv.total += data.delta; }
        bumpUser(uid, data.delta, data.updated_at || 0);
    }

    const overallVideos = videos.map((v) => {
        const pv = perVideo.get(v.video_id);
        return {
            video_id: v.video_id,
            title: v.title,
            duration_seconds: v.duration_seconds,
            viewers: pv ? pv.viewers.size : 0,
            total_watch_seconds: pv ? pv.total : 0,
        };
    });

    // Roster. Enrolled first (always), then non-enrolled all-access watchers.
    const [enrolled] = await pool.execute(
        `SELECT u.user_id, u.username, u.display_name, u.sso_avatar AS avatar
         FROM enrollments e JOIN users u ON e.user_id = u.user_id
         WHERE e.course_id = ?`,
        [courseId]
    );
    const enrolledIds = new Set(enrolled.map((u) => u.user_id));

    // Watchers not enrolled — keep only those with effective allCourseAccess.
    const outsideWatcherIds = [...perUser.keys()].filter((uid) => !enrolledIds.has(uid));
    let allAccess = [];
    if (outsideWatcherIds.length > 0) {
        const placeholders = outsideWatcherIds.map(() => '?').join(',');
        // Positive predicate (has allCourseAccess): force-on override, or no
        // override and the role grants it. Written as an explicit INCLUDE — a
        // NULL override_value would make NOT(...) itself NULL and drop rows.
        const [aa] = await pool.execute(
            `SELECT u.user_id, u.username, u.display_name, u.sso_avatar AS avatar
             FROM users u
             LEFT JOIN role_permissions rp
                    ON rp.role_id = u.role_id
                   AND rp.permission_key = 'allCourseAccess'
                   AND rp.granted = 1
             LEFT JOIN user_permission_overrides o
                    ON o.user_id = u.user_id
                   AND o.permission_key = 'allCourseAccess'
             WHERE u.user_id IN (${placeholders})
               AND ( o.override_value = 1 OR (o.override_value IS NULL AND rp.role_id IS NOT NULL) )`,
            outsideWatcherIds.map((id) => idBuf(id))
        );
        allAccess = aa;
    }

    const mkStudent = (u, source) => {
        const e = perUser.get(u.user_id) || { total: 0, lastMs: 0 };
        return {
            user_id: u.user_id,
            username: u.username,
            display_name: u.display_name,
            avatar: u.avatar,
            total_watch_seconds: e.total,
            last_watch_at: e.lastMs > 0 ? new Date(e.lastMs).toISOString() : null,
            source,
        };
    };
    const students = [
        ...enrolled.map((u) => mkStudent(u, 'enrolled')),
        ...allAccess.map((u) => mkStudent(u, 'all-access')),
    ];
    // Display name ascending, then user_id (uuid hex) ascending — matches the
    // admin Users/Enrollment roster convention.
    students.sort((a, b) =>
        (a.display_name || '').localeCompare(b.display_name || '') ||
        a.user_id.localeCompare(b.user_id));

    const totalDuration = videos.reduce((s, v) => s + (v.duration_seconds || 0), 0);
    return {
        overall: {
            videos: overallVideos,
            videoCount: videos.length,
            totalDuration,
            viewerCount: students.filter((s) => s.total_watch_seconds > 0).length,
        },
        students,
    };
}

// Per-video stats for ONE user in ONE course (the modal's per-student view and
// the edit-user section share this). Every course video appears; unwatched
// ones carry null watch data.
async function getUserVideoStats(courseId, userId) {
    const pool = getPool();
    const [videos] = await pool.execute(
        `SELECT v.video_id, v.title, v.duration_seconds,
                wp.watch_seconds, wp.last_position, wp.last_watch_at
         FROM videos v
         LEFT JOIN watch_progress wp ON wp.video_id = v.video_id AND wp.user_id = ?
         WHERE v.course_id = ?
         ORDER BY (v.module_number IS NULL) ASC, CAST(v.module_number AS UNSIGNED) DESC,
                  (v.lecture_date IS NULL) ASC, v.lecture_date DESC, v.video_id DESC`,
        [idBuf(userId), courseId]
    );
    const pending = await watchProgressCache.getAllPending();
    return videos.map((v) => {
        const p = pending[`${userId}:${v.video_id}`];
        const watched = v.watch_seconds != null || p;
        let secs = v.watch_seconds != null ? parseFloat(v.watch_seconds) : 0;
        let pos = v.last_position != null ? parseFloat(v.last_position) : 0;
        let lastMs = 0;
        if (p) { secs += p.delta; pos = p.last_position; lastMs = p.updated_at || 0; }
        return {
            video_id: v.video_id,
            title: v.title,
            duration_seconds: v.duration_seconds,
            watched: !!watched,
            watch_seconds: watched ? secs : null,
            last_position: watched ? pos : null,
            last_watch_at: watched ? laterIso(v.last_watch_at, lastMs) : null,
        };
    });
}

// Courses a user has watched — feeds the edit-user page's course selector.
// Overlays pending so a just-started course appears without a flush wait.
async function getUserWatchedCourses(userId) {
    const pool = getPool();
    const [courses] = await pool.execute(
        `SELECT c.course_id, c.course_code, c.course_name,
                MAX(wp.last_watch_at) AS last_watch_at
         FROM courses c
         JOIN videos v ON v.course_id = c.course_id
         JOIN watch_progress wp ON wp.video_id = v.video_id AND wp.user_id = ?
         GROUP BY c.course_id
         ORDER BY last_watch_at DESC`,
        [idBuf(userId)]
    );
    const present = new Map(courses.map((c) => [c.course_id, c]));

    // Pending-only courses (watched since the last flush, no DB row yet).
    const pending = await watchProgressCache.getAllPending();
    const pendingVids = [];
    for (const member of Object.keys(pending)) {
        const idx = member.lastIndexOf(':');
        if (member.slice(0, idx) !== userId) continue;
        pendingVids.push(parseInt(member.slice(idx + 1), 10));
    }
    if (pendingVids.length > 0) {
        const ph = pendingVids.map(() => '?').join(',');
        const [vrows] = await pool.execute(
            `SELECT DISTINCT c.course_id, c.course_code, c.course_name
             FROM videos v JOIN courses c ON c.course_id = v.course_id
             WHERE v.video_id IN (${ph})`,
            pendingVids
        );
        for (const c of vrows) if (!present.has(c.course_id)) present.set(c.course_id, c);
    }
    return [...present.values()].map((c) => ({
        course_id: c.course_id,
        course_code: c.course_code,
        course_name: c.course_name,
    }));
}

// ---- Scoped resets ------------------------------------------------------
// A "reset" is destructive by intent: it deletes watch_progress rows, which
// ALSO clears the student's resume position (last_position) — that's expected.
// Each reset drops both the DB rows and the matching Redis cache entries so a
// pending flush can't resurrect them.

async function resetCourse(courseId) {
    const pool = getPool();
    const [vids] = await pool.execute('SELECT video_id FROM videos WHERE course_id = ?', [courseId]);
    await pool.execute(
        `DELETE wp FROM watch_progress wp
         JOIN videos v ON wp.video_id = v.video_id
         WHERE v.course_id = ?`,
        [courseId]
    );
    await watchProgressCache.clearForVideos(vids.map((v) => v.video_id));
}

async function resetUser(userId) {
    const pool = getPool();
    await pool.execute('DELETE FROM watch_progress WHERE user_id = ?', [idBuf(userId)]);
    await watchProgressCache.clearForUser(userId);
}

async function resetUserCourse(userId, courseId) {
    const pool = getPool();
    const [vids] = await pool.execute('SELECT video_id FROM videos WHERE course_id = ?', [courseId]);
    await pool.execute(
        `DELETE wp FROM watch_progress wp
         JOIN videos v ON wp.video_id = v.video_id
         WHERE wp.user_id = ? AND v.course_id = ?`,
        [idBuf(userId), courseId]
    );
    await watchProgressCache.clearForUserVideos(userId, vids.map((v) => v.video_id));
}

module.exports = {
    getCourseStats,
    getUserVideoStats,
    getUserWatchedCourses,
    resetCourse,
    resetUser,
    resetUserCourse,
};
