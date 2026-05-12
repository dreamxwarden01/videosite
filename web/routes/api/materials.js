const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/permissions');
const { getPool } = require('../../config/database');
const {
    generateMaterialId,
    getPresignedUploadUrl,
    getPresignedDownloadUrl,
    applyHeaders,
    createMaterialRecord,
    getMaterialsByCourse,
    getMaterialById,
    updateMaterial,
    deleteMaterial,
    getCoursesWithMaterialCount,
} = require('../../services/materialService');
const {
    generateUploadId,
    createSession,
    getSession,
    heartbeat,
    markCompleting,
    markCompleted,
    abortAttachmentSession,
} = require('../../services/uploadSessionService');
const deletionService = require('../../services/deletionService');
const courseCache = require('../../services/cache/courseCache');

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const BLOCKED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m3u8'];

function getExtension(filename) {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.substring(dot).toLowerCase() : '';
}

// Inline enrollment check helper
async function checkEnrollment(user, courseId) {
    if (user.permissions.allCourseAccess) return true;
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?',
        [user.user_id, courseId]
    );
    return rows.length > 0;
}

// ── 1. GET /materials/courses — course list with material counts ──
router.get('/materials/courses', requireAuth, checkPermission('accessAttachments'), async (req, res) => {
    try {
        const user = res.locals.user;
        const courses = await getCoursesWithMaterialCount(user.user_id, user.permissions.allCourseAccess);
        res.json({ courses });
    } catch (err) {
        console.error('Materials course list error:', err);
        res.status(500).json({ error: 'Failed to load courses.' });
    }
});

// ── 2. GET /materials/courses/:courseId — list materials for a course ──
router.get('/materials/courses/:courseId', requireAuth, checkPermission('accessAttachments'), async (req, res) => {
    try {
        const user = res.locals.user;
        const courseId = parseInt(req.params.courseId);

        if (!await checkEnrollment(user, courseId)) {
            return res.status(403).json({ error: 'You are not enrolled in this course.' });
        }

        const course = await courseCache.getCourseMeta(courseId);
        if (!course || course.is_active !== 1) return res.status(404).json({ error: 'Course not found.' });

        const materials = await getMaterialsByCourse(courseId);
        res.json({
            courseName: course.course_name,
            materials: materials.map(m => ({
                material_id: m.material_id,
                filename: m.filename,
                file_size: m.file_size,
                content_type: m.content_type,
                week: m.week,
                uploaded_by: m.uploaded_by,
                created_at: m.created_at,
            })),
        });
    } catch (err) {
        console.error('Materials list error:', err);
        res.status(500).json({ error: 'Failed to load materials.' });
    }
});

// ── 3. POST /materials/courses/:courseId/upload — initiate upload ──
//
// Creates an `upload_sessions` row of type='attachment' and returns the
// uploadId + presigned PUT URL. The `course_materials` row is NOT
// created until `/complete` — keeps the materials table free of
// uploading placeholders.
router.post('/materials/courses/:courseId/upload', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const user = res.locals.user;
        const courseId = parseInt(req.params.courseId);

        if (!await checkEnrollment(user, courseId)) {
            return res.status(403).json({ error: 'You are not enrolled in this course.' });
        }

        const { filename, fileSize, contentType, week } = req.body;
        if (!filename || !fileSize || !week) {
            return res.status(400).json({ error: 'filename, fileSize, and week are required.' });
        }
        if (fileSize > MAX_FILE_SIZE) {
            return res.status(400).json({ error: 'File size exceeds 100 MB limit.' });
        }

        const ext = getExtension(filename);
        if (BLOCKED_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ error: 'Video files are not allowed. Use the video upload feature instead.' });
        }
        if (!ext) {
            return res.status(400).json({ error: 'File must have an extension.' });
        }

        // Generate IDs + R2 key
        const uploadId = generateUploadId();
        const materialFileId = generateMaterialId();
        const objectKey = `attachments/${courseId}/${materialFileId}${ext}`;
        const finalContentType = contentType || 'application/octet-stream';

        // Open the session (heartbeat tracking starts now)
        await createSession({
            type: 'attachment',
            uploadId,
            courseId,
            objectKey,
            contentType: finalContentType,
            originalFilename: filename,
            fileSizeBytes: fileSize,
            createdBy: user.user_id,
        });

        // Presigned PUT URL — the client uploads directly to R2.
        const uploadUrl = await getPresignedUploadUrl(objectKey, finalContentType);

        res.status(201).json({ uploadId, uploadUrl });
    } catch (err) {
        console.error('Material upload initiate error:', err);
        res.status(500).json({ error: 'Failed to initiate upload.' });
    }
});

// ── 4. POST /materials/:uploadId/heartbeat — keep session alive ──
//
// Goes through Redis (no DB write per tick). Returns 204 on accepted,
// 404 if session is missing/terminal/owned-by-different-user. Client
// stops heartbeating on a 404.
router.post('/materials/:uploadId/heartbeat', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const accepted = await heartbeat(req.params.uploadId, res.locals.user.user_id);
        if (!accepted) return res.status(404).json({ error: 'Session not found.' });
        res.status(204).end();
    } catch (err) {
        console.error('Material heartbeat error:', err);
        res.status(500).json({ error: 'Failed to heartbeat.' });
    }
});

// ── 5. POST /materials/:uploadId/complete — finalize upload ──
//
// Re-stamps the R2 object's Content-Type / Cache-Control via
// CopyObject, verifies the course still exists (410 if not, with R2
// cleanup enqueued), and inserts the `course_materials` row. Returns
// `{ materialId }` on success.
router.post('/materials/:uploadId/complete', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const userId = res.locals.user.user_id;
        const uploadId = req.params.uploadId;

        const session = await getSession(uploadId);
        if (!session || session.type !== 'attachment'
            || session.created_by !== userId
            || !['active', 'completing'].includes(session.status)) {
            return res.status(404).json({ error: 'Session not found.' });
        }

        // Hold the session across the work below so a concurrent stale
        // timer doesn't fire on us.
        await markCompleting(uploadId);

        // Course-existence safety net: if the course was deleted while
        // the upload was in flight, drop the R2 object and tell the
        // client.
        const course = await courseCache.getCourseMeta(session.course_id);
        if (!course || course.is_active !== 1) {
            await deletionService.enqueueKey(session.object_key, {
                source: 'orphaned_attachment',
            });
            // Mark completed (terminal) just so the row doesn't linger
            // as 'completing' for the resetStaleUploads sweep.
            await markCompleted(uploadId, null);
            return res.status(410).json({ error: 'Course deleted.' });
        }

        // Re-stamp the object's headers from the cached content_type.
        await applyHeaders(session.object_key, session.content_type);

        // Insert the real `course_materials` row.
        const week = req.body && typeof req.body.week === 'string' ? req.body.week : null;
        const materialId = await createMaterialRecord(
            session.course_id,
            session.object_key,
            session.original_filename,
            session.file_size_bytes,
            session.content_type,
            week,
            userId
        );

        await markCompleted(uploadId, null);

        res.status(200).json({ materialId });
    } catch (err) {
        console.error('Material complete error:', err);
        res.status(500).json({ error: 'Failed to complete upload.' });
    }
});

// ── 6. POST /materials/:uploadId/abort — cancel an in-flight upload ──
//
// Marks the session aborted and enqueues the R2 object for deletion
// with a 60 s buffer (in case the client's PUT lands after the abort).
router.post('/materials/:uploadId/abort', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const userId = res.locals.user.user_id;
        const uploadId = req.params.uploadId;

        const session = await getSession(uploadId);
        if (!session || session.type !== 'attachment' || session.created_by !== userId) {
            return res.status(404).json({ error: 'Session not found.' });
        }

        await abortAttachmentSession(uploadId);
        res.status(204).end();
    } catch (err) {
        console.error('Material abort error:', err);
        res.status(500).json({ error: 'Failed to abort upload.' });
    }
});

// ── 7. GET /materials/:materialId/download — presigned download URL ──
router.get('/materials/:materialId/download', requireAuth, checkPermission('accessAttachments'), async (req, res) => {
    try {
        const user = res.locals.user;
        const materialId = parseInt(req.params.materialId);

        const material = await getMaterialById(materialId);
        if (!material) {
            return res.status(404).json({ error: 'Material not found.' });
        }

        if (!await checkEnrollment(user, material.course_id)) {
            return res.status(403).json({ error: 'You are not enrolled in this course.' });
        }

        const inline = req.query.mode === 'view';
        const downloadUrl = await getPresignedDownloadUrl(material.object_key, material.filename, { inline });
        res.json({ downloadUrl });
    } catch (err) {
        console.error('Material download error:', err);
        res.status(500).json({ error: 'Failed to generate download URL.' });
    }
});

// ── 8. PUT /materials/:materialId — edit filename/week ──
router.put('/materials/:materialId', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const materialId = parseInt(req.params.materialId);
        const { filename, week } = req.body;

        const material = await getMaterialById(materialId);
        if (!material) {
            return res.status(404).json({ error: 'Material not found.' });
        }

        if (filename !== undefined) {
            if (!filename || filename.length > 255) {
                return res.status(400).json({ error: 'Filename must be 1-255 characters.' });
            }
            if (/[/\\]/.test(filename)) {
                return res.status(400).json({ error: 'Filename cannot contain path separators.' });
            }
        }
        if (week !== undefined && !week) {
            return res.status(400).json({ error: 'Week is required.' });
        }

        await updateMaterial(materialId, { filename, week });
        res.status(204).end();
    } catch (err) {
        console.error('Material update error:', err);
        res.status(500).json({ error: 'Failed to update material.' });
    }
});

// ── 9. DELETE /materials/:materialId — delete material + R2 object ──
router.delete('/materials/:materialId', requireAuth, checkPermission('deleteAttachments'), async (req, res) => {
    try {
        const materialId = parseInt(req.params.materialId);

        const objectKey = await deleteMaterial(materialId);
        if (!objectKey) {
            return res.status(404).json({ error: 'Material not found.' });
        }

        await deletionService.enqueueKey(objectKey, { source: 'material_delete' });
        res.status(204).end();
    } catch (err) {
        console.error('Material delete error:', err);
        res.status(500).json({ error: 'Failed to delete material.' });
    }
});

module.exports = router;
