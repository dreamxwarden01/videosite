const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/permissions');
const { getPool } = require('../../config/database');
const {
    generateMaterialId,
    getPresignedUploadUrl,
    getPresignedDownloadUrl,
    deleteR2Object,
    createMaterialRecord,
    confirmUpload,
    getMaterialsByCourse,
    getMaterialById,
    updateMaterial,
    deleteMaterial,
    abortMaterial,
    getCoursesWithMaterialCount,
} = require('../../services/materialService');

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

        const pool = getPool();
        const [courseRows] = await pool.execute('SELECT course_name FROM courses WHERE course_id = ? AND is_active = 1', [courseId]);
        if (courseRows.length === 0) return res.status(404).json({ error: 'Course not found.' });

        const materials = await getMaterialsByCourse(courseId);
        res.json({
            courseName: courseRows[0].course_name,
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

        // Generate object key
        const materialFileId = generateMaterialId();
        const objectKey = `attachments/${courseId}/${materialFileId}${ext}`;

        // Create DB record (status = 'uploading')
        const materialId = await createMaterialRecord(
            courseId, objectKey, filename, fileSize,
            contentType || 'application/octet-stream', week, user.user_id
        );

        // Generate presigned PUT URL
        const uploadUrl = await getPresignedUploadUrl(objectKey, contentType);

        res.status(201).json({ materialId, uploadUrl });
    } catch (err) {
        console.error('Material upload initiate error:', err);
        res.status(500).json({ error: 'Failed to initiate upload.' });
    }
});

// ── 4. POST /materials/:materialId/confirm — confirm upload complete ──
router.post('/materials/:materialId/confirm', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const materialId = parseInt(req.params.materialId);
        const userId = res.locals.user.user_id;

        const success = await confirmUpload(materialId, userId);
        if (!success) {
            return res.status(404).json({ error: 'Material not found or already confirmed.' });
        }

        res.status(204).end();
    } catch (err) {
        console.error('Material confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm upload.' });
    }
});

// ── 5. GET /materials/:materialId/download — presigned download URL ──
router.get('/materials/:materialId/download', requireAuth, checkPermission('accessAttachments'), async (req, res) => {
    try {
        const user = res.locals.user;
        const materialId = parseInt(req.params.materialId);

        const material = await getMaterialById(materialId);
        if (!material || material.status !== 'active') {
            return res.status(404).json({ error: 'Material not found.' });
        }

        if (!await checkEnrollment(user, material.course_id)) {
            return res.status(403).json({ error: 'You are not enrolled in this course.' });
        }

        const downloadUrl = await getPresignedDownloadUrl(material.object_key, material.filename);
        res.json({ downloadUrl });
    } catch (err) {
        console.error('Material download error:', err);
        res.status(500).json({ error: 'Failed to generate download URL.' });
    }
});

// ── 6. PUT /materials/:materialId — edit filename/week ──
router.put('/materials/:materialId', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const materialId = parseInt(req.params.materialId);
        const { filename, week } = req.body;

        const material = await getMaterialById(materialId);
        if (!material || material.status !== 'active') {
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

// ── 7. DELETE /materials/:materialId — delete material + R2 object ──
router.delete('/materials/:materialId', requireAuth, checkPermission('deleteAttachments'), async (req, res) => {
    try {
        const materialId = parseInt(req.params.materialId);

        const objectKey = await deleteMaterial(materialId);
        if (!objectKey) {
            return res.status(404).json({ error: 'Material not found.' });
        }

        // Fire-and-forget R2 cleanup
        deleteR2Object(objectKey).catch(err => {
            console.error(`R2 delete failed for material ${materialId}:`, err.message);
        });

        res.status(204).end();
    } catch (err) {
        console.error('Material delete error:', err);
        res.status(500).json({ error: 'Failed to delete material.' });
    }
});

// ── 8. POST /materials/:materialId/abort — abort stuck upload ──
router.post('/materials/:materialId/abort', requireAuth, checkPermission('uploadAttachments'), async (req, res) => {
    try {
        const materialId = parseInt(req.params.materialId);
        const userId = res.locals.user.user_id;

        const objectKey = await abortMaterial(materialId, userId);
        if (!objectKey) {
            return res.status(404).json({ error: 'Material not found or not in uploading state.' });
        }

        // Fire-and-forget R2 cleanup
        deleteR2Object(objectKey).catch(err => {
            console.error(`R2 delete failed for aborted material ${materialId}:`, err.message);
        });

        res.status(204).end();
    } catch (err) {
        console.error('Material abort error:', err);
        res.status(500).json({ error: 'Failed to abort upload.' });
    }
});

module.exports = router;
