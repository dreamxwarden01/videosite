const express = require('express');
const router = express.Router();
const path = require('path');
const { requireAuth } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/permissions');
const { getPool } = require('../../config/database');
const { createVideo, cleanR2Prefix } = require('../../services/videoService');
const { getCourseById } = require('../../services/courseService');
const { createTask } = require('../../services/processingService');
const {
    initiateMultipartUpload,
    getPresignedPartUrls,
    completeMultipartUpload,
    abortMultipartUpload,
    calculateTotalParts,
    PART_SIZE
} = require('../../services/uploadService');
const {
    generateUploadId,
    createSession,
    getSession,
    heartbeat,
    checkMetadataConflict,
    checkReplaceConflict,
    markCompleting,
    markCompleted,
    markAborted
} = require('../../services/uploadSessionService');

/** Extract file extension from filename (e.g. "video.mp4" → "mp4") */
function getExtension(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return ext || 'bin';
}

// Source files end up at the worker, which feeds them to FFmpeg. The list
// below is what the transcoder is known to handle; anything else gets
// rejected here rather than failing later in the pipeline. Note: no leading
// dot — getExtension above strips it.
const ALLOWED_EXTENSIONS = ['mp4', 'mkv', 'mov', 'webm', 'm4v', 'avi', 'flv', 'wmv', 'ts', 'mpg', 'mpeg', '3gp'];

// 50 GB — generous enough to cover full-resolution lecture captures while
// still bounded so a hostile client can't claim an absurd size and tie up
// the upload session table or R2 multipart slots.
const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024;

function validateUploadInputs(filename, fileSize) {
    const sizeNum = Number(fileSize);
    if (!Number.isInteger(sizeNum) || sizeNum <= 0) {
        return 'invalid fileSize';
    }
    if (sizeNum > MAX_FILE_SIZE) {
        return 'File size exceeds 50 GB limit.';
    }
    const ext = getExtension(filename);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return `File type not allowed. Supported: ${ALLOWED_EXTENSIONS.join(', ')}.`;
    }
    return null;
}

// POST /api/upload/create — create new upload session (new video)
router.post('/upload/create', requireAuth, checkPermission('uploadVideo'), async (req, res) => {
    try {
        const { courseId, filename, fileSize, contentType, title, week, lectureDate, description } = req.body;

        if (!courseId || !filename || !fileSize || !title?.trim()) {
            return res.status(400).json({ error: 'courseId, filename, fileSize, and title are required' });
        }

        const inputError = validateUploadInputs(filename, fileSize);
        if (inputError) {
            return res.status(400).json({ error: inputError });
        }

        // Validate course exists
        const course = await getCourseById(courseId);
        if (!course) {
            return res.status(404).json({ error: 'Course not found' });
        }

        // Check course access
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

        // Check metadata conflict
        const conflict = await checkMetadataConflict(courseId, title.trim(), week || null, lectureDate || null);
        if (conflict) {
            return res.status(409).json({ conflict: true, ...conflict });
        }

        // Generate upload ID and build R2 object key
        const uploadId = generateUploadId();
        const ext = getExtension(filename);
        const objectKey = `source/${uploadId}/source.${ext}`;

        // Initiate R2 multipart upload
        const r2UploadId = await initiateMultipartUpload(objectKey, contentType || 'application/octet-stream');
        const totalParts = calculateTotalParts(parseInt(fileSize));

        // Create session record
        await createSession({
            uploadId,
            videoId: null,
            courseId,
            title: title.trim(),
            week: week || null,
            lectureDate: lectureDate || null,
            description: description?.trim() || null,
            r2UploadId,
            objectKey,
            originalFilename: filename,
            fileSizeBytes: parseInt(fileSize),
            totalParts,
            createdBy: user.user_id
        });

        res.json({ uploadId, totalParts, partSize: PART_SIZE });
    } catch (err) {
        console.error('Upload create error:', err);
        res.status(500).json({ error: 'Failed to create upload session' });
    }
});

// POST /api/upload/replace — create replace upload session (existing video)
router.post('/upload/replace', requireAuth, checkPermission('uploadVideo'), async (req, res) => {
    try {
        const { videoId, filename, fileSize, contentType } = req.body;

        if (!videoId || !filename || !fileSize) {
            return res.status(400).json({ error: 'videoId, filename, and fileSize are required' });
        }

        const inputError = validateUploadInputs(filename, fileSize);
        if (inputError) {
            return res.status(400).json({ error: inputError });
        }

        const pool = getPool();
        const [rows] = await pool.execute(
            `SELECT hashed_video_id, r2_source_key, course_id FROM videos
             WHERE video_id = ? AND status = 'finished'`,
            [videoId]
        );
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Video not found or not in finished state' });
        }

        const video = rows[0];

        // Check replace conflict
        const conflict = await checkReplaceConflict(videoId);
        if (conflict) {
            return res.status(409).json({ conflict: true, type: 'replace', uploadId: conflict.upload_id });
        }

        // Generate upload ID and build R2 object key
        const uploadId = generateUploadId();
        const ext = getExtension(filename);
        const objectKey = `source/${uploadId}/source.${ext}`;

        // Initiate R2 multipart upload
        const r2UploadId = await initiateMultipartUpload(objectKey, contentType || 'application/octet-stream');
        const totalParts = calculateTotalParts(parseInt(fileSize));

        // Create session record (store old source key so abort can skip cleanup)
        await createSession({
            uploadId,
            videoId,
            courseId: video.course_id,
            r2UploadId,
            objectKey,
            originalFilename: filename,
            fileSizeBytes: parseInt(fileSize),
            totalParts,
            createdBy: res.locals.user.user_id
        });

        res.json({ uploadId, totalParts, partSize: PART_SIZE });
    } catch (err) {
        console.error('Upload replace error:', err);
        res.status(500).json({ error: 'Failed to create replace session' });
    }
});

// POST /api/upload/:uploadId/presign — get presigned URLs for parts
router.post('/upload/:uploadId/presign', requireAuth, checkPermission('uploadVideo'), async (req, res) => {
    try {
        const session = await getSession(req.params.uploadId);
        if (!session || session.status !== 'active') {
            return res.status(404).json({ error: 'Upload session not found or not active' });
        }
        if (session.created_by !== res.locals.user.user_id) {
            return res.status(403).json({ error: 'Not your upload session' });
        }

        const { partNumbers } = req.body;
        if (!partNumbers || !Array.isArray(partNumbers)) {
            return res.status(400).json({ error: 'partNumbers array is required' });
        }

        const urls = await getPresignedPartUrls(session.object_key, session.r2_upload_id, partNumbers);
        res.json({ urls });
    } catch (err) {
        console.error('Upload presign error:', err);
        res.status(500).json({ error: 'Failed to generate presigned URLs' });
    }
});

// POST /api/upload/:uploadId/heartbeat — keep session alive
router.post('/upload/:uploadId/heartbeat', requireAuth, async (req, res) => {
    try {
        const ok = await heartbeat(req.params.uploadId, res.locals.user.user_id);
        if (!ok) {
            return res.status(404).json({ error: 'Upload session not found or not active' });
        }
        res.status(204).end();
    } catch (err) {
        console.error('Upload heartbeat error:', err);
        res.status(500).json({ error: 'Failed to update heartbeat' });
    }
});

// POST /api/upload/:uploadId/complete — finalize upload
router.post('/upload/:uploadId/complete', requireAuth, checkPermission('uploadVideo'), async (req, res) => {
    try {
        const { parts } = req.body;
        if (!parts || !Array.isArray(parts)) {
            return res.status(400).json({ error: 'parts array is required' });
        }

        const session = await getSession(req.params.uploadId);
        if (!session || (session.status !== 'active' && session.status !== 'completing')) {
            return res.status(404).json({ error: 'Upload session not found or not active' });
        }
        if (session.created_by !== res.locals.user.user_id) {
            return res.status(403).json({ error: 'Not your upload session' });
        }

        // Mark completing (prevents stale timeout during finalization)
        await markCompleting(session.upload_id);

        // Finalize R2 multipart upload
        await completeMultipartUpload(session.object_key, session.r2_upload_id, parts);

        const pool = getPool();
        let videoId;

        if (!session.video_id) {
            // New upload — create video record.
            //
            // All newly created videos go through the CMAF pipeline (fMP4
            // HLS + DASH, unencrypted). Legacy TS videos created before
            // this flip remain at video_type='ts' and continue to work
            // through their existing pipeline — coexistence, not migration.
            const user = res.locals.user;
            const result = await createVideo(session.course_id, session.title, {
                description: session.description,
                week: session.week,
                lecture_date: session.lecture_date,
                original_filename: session.original_filename,
                file_size_bytes: session.file_size_bytes,
                uploaded_by: user.user_id,
                r2_source_key: session.object_key,
                video_type: 'cmaf'
            });
            videoId = result.videoId;

            // Queue for processing
            await createTask(videoId);
        } else {
            // Replacement — reset video for reprocessing
            videoId = session.video_id;

            // Get current video info for cleanup
            const [videoRows] = await pool.execute(
                'SELECT hashed_video_id, r2_source_key FROM videos WHERE video_id = ?',
                [videoId]
            );

            if (videoRows.length > 0) {
                // Clean old R2 source
                const oldSourceKey = videoRows[0].r2_source_key;
                if (oldSourceKey) {
                    const oldSourceDir = oldSourceKey.substring(0, oldSourceKey.lastIndexOf('/') + 1);
                    cleanR2Prefix(oldSourceDir).catch(err => {
                        console.error(`R2 source cleanup failed for replaced video ${videoId}:`, err.message);
                    });
                }

                // Clean old HLS segments (fire-and-forget)
                cleanR2Prefix(`${videoRows[0].hashed_video_id}/`).catch(err => {
                    console.error(`R2 HLS cleanup failed for replaced video ${videoId}:`, err.message);
                });
            }

            // Delete old processing_queue row
            await pool.execute('DELETE FROM processing_queue WHERE video_id = ?', [videoId]);

            // Update video with new source info and reset state. Replacement
            // uploads also flip video_type to 'cmaf' — a re-uploaded source
            // moves onto the new pipeline and drops its old encryption_key
            // (CMAF rows are unencrypted; /api/keys/:id already 404s on NULL).
            await pool.execute(
                `UPDATE videos SET r2_source_key = ?, original_filename = ?, file_size_bytes = ?,
                 status = 'queued', processing_job_id = NULL, encryption_key = NULL,
                 processing_progress = 0, processing_error = NULL, duration_seconds = NULL,
                 video_type = 'cmaf'
                 WHERE video_id = ?`,
                [session.object_key, session.original_filename, session.file_size_bytes, videoId]
            );

            // Create new processing task
            await createTask(videoId);

            // Clear stale watch progress
            await pool.execute('DELETE FROM watch_progress WHERE video_id = ?', [videoId]);
        }

        await markCompleted(session.upload_id, videoId);

        res.status(204).end();
    } catch (err) {
        console.error('Upload complete error:', err);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
});

// POST /api/upload/:uploadId/abort — abort upload session
router.post('/upload/:uploadId/abort', requireAuth, async (req, res) => {
    try {
        const session = await getSession(req.params.uploadId);
        if (!session || (session.status !== 'active' && session.status !== 'completing')) {
            return res.status(204).end(); // Already aborted/completed — idempotent
        }
        if (session.created_by !== res.locals.user.user_id) {
            return res.status(403).json({ error: 'Not your upload session' });
        }

        await markAborted(session.upload_id);

        // Fire-and-forget R2 abort with retry backoff
        (async () => {
            const delays = [0, 1000, 2000, 3000, 4000];
            for (let i = 0; i < delays.length; i++) {
                try {
                    if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
                    await abortMultipartUpload(session.object_key, session.r2_upload_id);
                    return;
                } catch (err) {
                    if (i === delays.length - 1) {
                        console.warn(`R2 multipart abort gave up after ${delays.length} attempts:`, err.message);
                    }
                }
            }
        })();

        res.status(204).end();
    } catch (err) {
        console.error('Upload abort error:', err);
        res.status(500).json({ error: 'Failed to abort upload' });
    }
});

module.exports = router;
