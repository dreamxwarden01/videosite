const crypto = require('crypto');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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

async function getPresignedDownloadUrl(objectKey, filename) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    // RFC 5987 encoding for UTF-8 filenames
    const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    const disposition = `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`;

    const command = new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ResponseContentDisposition: disposition,
    });
    return getSignedUrl(r2, command, { expiresIn: 3600 });
}

async function deleteR2Object(objectKey) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();
    const command = new DeleteObjectCommand({
        Bucket: bucket,
        Key: objectKey,
    });
    await r2.send(command);
}

// --- DB operations ---

async function createMaterialRecord(courseId, objectKey, filename, fileSize, contentType, week, uploadedBy) {
    const pool = getPool();
    const [result] = await pool.execute(
        `INSERT INTO course_materials (course_id, object_key, filename, file_size, content_type, week, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [courseId, objectKey, filename, fileSize, contentType || 'application/octet-stream', week || null, uploadedBy]
    );
    return result.insertId;
}

async function confirmUpload(materialId, userId) {
    const pool = getPool();
    const [result] = await pool.execute(
        `UPDATE course_materials SET status = 'active' WHERE material_id = ? AND status = 'uploading' AND uploaded_by = ?`,
        [materialId, userId]
    );
    return result.affectedRows > 0;
}

async function getMaterialsByCourse(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT material_id, course_id, filename, file_size, content_type, week, uploaded_by, created_at, updated_at
         FROM course_materials WHERE course_id = ? AND status = 'active'
         ORDER BY week DESC, created_at DESC, filename ASC`,
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

async function abortMaterial(materialId, userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT object_key FROM course_materials WHERE material_id = ? AND status = 'uploading' AND uploaded_by = ?`,
        [materialId, userId]
    );
    if (rows.length === 0) return null;

    await pool.execute(
        `UPDATE course_materials SET status = 'aborted' WHERE material_id = ?`,
        [materialId]
    );
    return rows[0].object_key;
}

async function cleanupStaleMaterials() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT material_id, object_key FROM course_materials
         WHERE status = 'uploading' AND created_at < DATE_SUB(NOW(), INTERVAL 65 MINUTE)`
    );

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.material_id);
    await pool.execute(
        `DELETE FROM course_materials WHERE material_id IN (${ids.map(() => '?').join(',')})`,
        ids
    );

    return rows.map(r => r.object_key);
}

async function getCoursesWithMaterialCount(userId, hasAllCourseAccess) {
    const pool = getPool();

    if (hasAllCourseAccess) {
        const [rows] = await pool.execute(
            `SELECT c.course_id, c.course_name,
                (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id AND m.status = 'active') as material_count,
                (SELECT MAX(m.created_at) FROM course_materials m WHERE m.course_id = c.course_id AND m.status = 'active') as last_material_at
             FROM courses c WHERE c.is_active = 1
             ORDER BY c.course_name ASC`
        );
        return rows;
    }

    const [rows] = await pool.execute(
        `SELECT c.course_id, c.course_name,
            (SELECT COUNT(*) FROM course_materials m WHERE m.course_id = c.course_id AND m.status = 'active') as material_count,
            (SELECT MAX(m.created_at) FROM course_materials m WHERE m.course_id = c.course_id AND m.status = 'active') as last_material_at
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
    deleteR2Object,
    createMaterialRecord,
    confirmUpload,
    getMaterialsByCourse,
    getMaterialById,
    updateMaterial,
    deleteMaterial,
    abortMaterial,
    cleanupStaleMaterials,
    getCoursesWithMaterialCount,
};
