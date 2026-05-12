const crypto = require('crypto');
const { PutObjectCommand, GetObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getR2Client, getR2BucketName } = require('../config/r2');
const { getPool } = require('../config/database');

// --- Base62 ID generation (same pattern as uploadSessionService.js) ---
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(buffer, length) {
    let result = '';
    for (let i = 0; i < buffer.length && result.length < length; i++) {
        result += BASE62[buffer[i] % 62];
    }
    return result;
}

function generateMaterialId() {
    return toBase62(crypto.randomBytes(16), 16);
}

// --- R2 presigned URLs ---

async function getPresignedUploadUrl(objectKey, contentType) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: contentType || 'application/octet-stream',
    });
    return getSignedUrl(r2, command, { expiresIn: 3600 });
}

async function getPresignedDownloadUrl(objectKey, filename, { inline = false } = {}) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    // RFC 5987 encoding for UTF-8 filenames
    const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    const type = inline ? 'inline' : 'attachment';
    const disposition = `${type}; filename="${filename}"; filename*=UTF-8''${encoded}`;

    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ResponseContentDisposition: disposition,
    });
    return getSignedUrl(r2, command, { expiresIn: 3600 });
}

/**
 * Re-stamp the uploaded object's Content-Type + Cache-Control headers
 * via CopyObject-to-self. Called at /complete time so the headers
 * reflect the client-declared type rather than whatever R2 inferred
 * during the presigned PUT.
 */
async function applyHeaders(objectKey, contentType) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();
    await r2.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        CopySource: `${bucket}/${objectKey}`,
        ContentType: contentType || 'application/octet-stream',
        CacheControl: 'public, max-age=31536000, immutable',
        MetadataDirective: 'REPLACE',
    }));
}

// --- DB operations ---

/**
 * Insert a row for a confirmed attachment. Called from the /complete
 * handler after the PUT has landed and headers have been re-stamped.
 */
async function createMaterialRecord(courseId, objectKey, filename, fileSize, contentType, week, uploadedBy) {
    const pool = getPool();
    const [result] = await pool.execute(
        `INSERT INTO course_materials (course_id, object_key, filename, file_size, content_type, week, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [courseId, objectKey, filename, fileSize, contentType || 'application/octet-stream', week || null, uploadedBy]
    );
    return result.insertId;
}

async function getMaterialsByCourse(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT material_id, course_id, filename, file_size, content_type, week, uploaded_by, created_at, updated_at
         FROM course_materials WHERE course_id = ?
         ORDER BY CAST(week AS UNSIGNED) DESC, created_at DESC, filename ASC`,
        [courseId]
    );
    return rows;
}

async function getMaterialById(materialId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT * FROM course_materials WHERE material_id = ?',
        [materialId]
    );
    return rows[0] || null;
}

async function updateMaterial(materialId, { filename, week }) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (filename !== undefined) { fields.push('filename = ?'); values.push(filename); }
    if (week !== undefined) { fields.push('week = ?'); values.push(week || null); }

    if (fields.length === 0) return;
    values.push(materialId);

    await pool.execute(
        `UPDATE course_materials SET ${fields.join(', ')} WHERE material_id = ?`,
        values
    );
}

async function deleteMaterial(materialId) {
    const pool = getPool();
    // Fetch object_key before deleting
    const [rows] = await pool.execute(
        'SELECT object_key FROM course_materials WHERE material_id = ?',
        [materialId]
    );
    if (rows.length === 0) return null;

    await pool.execute('DELETE FROM course_materials WHERE material_id = ?', [materialId]);
    return rows[0].object_key;
}

async function getCoursesWithMaterialCount(userId, hasAllCourseAccess) {
    const pool = getPool();

    if (hasAllCourseAccess) {
        const [rows] = await pool.execute(
            `SELECT c.course_id, c.course_name,
                (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id) as material_count,
                (SELECT MAX(m.created_at) FROM course_materials m WHERE m.course_id = c.course_id) as last_material_at
             FROM courses c WHERE c.is_active = 1
             ORDER BY c.course_name ASC`
        );
        return rows;
    }

    const [rows] = await pool.execute(
        `SELECT c.course_id, c.course_name,
            (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id) as material_count,
            (SELECT MAX(m.created_at) FROM course_materials m WHERE m.course_id = c.course_id) as last_material_at
         FROM courses c
         JOIN enrollments e ON c.course_id = e.course_id
         WHERE e.user_id = ? AND c.is_active = 1
         ORDER BY c.course_name ASC`,
        [userId]
    );
    return rows;
}

module.exports = {
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
};
