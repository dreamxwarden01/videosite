const { getPool } = require('../config/database');

const PROFILE_COLUMNS = 'profile_id, course_id, name, width, height, video_bitrate_kbps, fps_limit, codec, profile, preset, segment_duration, gop_size, sort_order';

async function getGlobalProfiles() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT ${PROFILE_COLUMNS} FROM transcoding_profiles WHERE course_id IS NULL ORDER BY sort_order ASC`
    );
    return rows;
}

async function getCourseProfiles(courseId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT ${PROFILE_COLUMNS} FROM transcoding_profiles WHERE course_id = ? ORDER BY sort_order ASC`,
        [courseId]
    );
    return rows;
}

async function getEffectiveProfiles(courseId) {
    const pool = getPool();
    const [course] = await pool.execute(
        'SELECT use_custom_profiles FROM courses WHERE course_id = ?',
        [courseId]
    );
    if (course.length === 0) return [];
    if (course[0].use_custom_profiles) {
        const profiles = await getCourseProfiles(courseId);
        return profiles.length > 0 ? profiles : await getGlobalProfiles();
    }
    return getGlobalProfiles();
}

async function saveGlobalProfiles(profiles) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM transcoding_profiles WHERE course_id IS NULL');
        for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            await conn.execute(
                `INSERT INTO transcoding_profiles (course_id, name, width, height, video_bitrate_kbps, fps_limit, codec, profile, preset, segment_duration, gop_size, sort_order)
                 VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [p.name, p.width, p.height, p.video_bitrate_kbps, p.fps_limit || 60, p.codec || 'h264', p.profile || 'high', p.preset || 'medium', p.segment_duration || 6, p.gop_size || 48, i]
            );
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function saveCourseProfiles(courseId, profiles) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute('DELETE FROM transcoding_profiles WHERE course_id = ?', [courseId]);
        for (let i = 0; i < profiles.length; i++) {
            const p = profiles[i];
            await conn.execute(
                `INSERT INTO transcoding_profiles (course_id, name, width, height, video_bitrate_kbps, fps_limit, codec, profile, preset, segment_duration, gop_size, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [courseId, p.name, p.width, p.height, p.video_bitrate_kbps, p.fps_limit || 60, p.codec || 'h264', p.profile || 'high', p.preset || 'medium', p.segment_duration || 6, p.gop_size || 48, i]
            );
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function deleteCourseProfiles(courseId) {
    const pool = getPool();
    await pool.execute('DELETE FROM transcoding_profiles WHERE course_id = ?', [courseId]);
    await pool.execute('UPDATE courses SET use_custom_profiles = 0 WHERE course_id = ?', [courseId]);
}

async function getAudioNormalizationSettings() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT setting_key, setting_value FROM site_settings WHERE setting_key IN ('audio_normalization_target', 'audio_normalization_peak', 'audio_normalization_max_gain')`
    );
    const settings = {};
    for (const r of rows) {
        if (r.setting_key === 'audio_normalization_target') settings.target = r.setting_value;
        else if (r.setting_key === 'audio_normalization_peak') settings.peak = r.setting_value;
        else if (r.setting_key === 'audio_normalization_max_gain') settings.maxGain = r.setting_value;
    }
    return {
        target: settings.target || '-20',
        peak: settings.peak || '-2',
        maxGain: settings.maxGain || '20'
    };
}

async function saveAudioNormalizationSettings({ target, peak, maxGain }) {
    const pool = getPool();
    await pool.execute(`INSERT INTO site_settings (setting_key, setting_value) VALUES ('audio_normalization_target', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [target, target]);
    await pool.execute(`INSERT INTO site_settings (setting_key, setting_value) VALUES ('audio_normalization_peak', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [peak, peak]);
    await pool.execute(`INSERT INTO site_settings (setting_key, setting_value) VALUES ('audio_normalization_max_gain', ?) ON DUPLICATE KEY UPDATE setting_value = ?`, [maxGain, maxGain]);
    await require('./cache/settingsCache').invalidate();
}

/**
 * Site-wide default audio bitrate (kbps) used for every CMAF video's single
 * audio rendition. Returns a number in [128, 320]; falls back to 192 when
 * the setting is missing or malformed.
 */
async function getAudioBitrateDefault() {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT setting_value FROM site_settings WHERE setting_key = 'audio_bitrate_default'`
    );
    if (rows.length === 0) return 192;
    const n = parseInt(rows[0].setting_value, 10);
    if (!Number.isFinite(n) || n < 128 || n > 320) return 192;
    return n;
}

async function saveAudioBitrateDefault(kbps) {
    const pool = getPool();
    const v = String(kbps);
    await pool.execute(
        `INSERT INTO site_settings (setting_key, setting_value) VALUES ('audio_bitrate_default', ?)
         ON DUPLICATE KEY UPDATE setting_value = ?`,
        [v, v]
    );
    await require('./cache/settingsCache').invalidate();
}

/** Validate a site-wide audio bitrate. Returns array of errors (empty = ok). */
function validateAudioBitrate(n) {
    const errors = [];
    if (!Number.isInteger(n) || n < 128 || n > 320) {
        errors.push('Audio bitrate must be an integer between 128 and 320 kbps');
    }
    return errors;
}

function validateProfile(p) {
    const errors = [];
    if (!p.name || !p.name.trim()) errors.push('Name is required');
    if (!Number.isInteger(p.width) || p.width <= 0) errors.push('Width must be a positive integer');
    if (!Number.isInteger(p.height) || p.height <= 0) errors.push('Height must be a positive integer');
    if (!Number.isInteger(p.video_bitrate_kbps) || p.video_bitrate_kbps <= 0) errors.push('Video bitrate must be a positive integer');
    if (p.fps_limit !== undefined && (!Number.isInteger(p.fps_limit) || p.fps_limit < 1 || p.fps_limit > 120)) errors.push('FPS limit must be an integer between 1 and 120');
    if (p.segment_duration !== undefined && (!Number.isInteger(p.segment_duration) || p.segment_duration < 1 || p.segment_duration > 30)) errors.push('Segment duration must be 1-30');
    if (p.gop_size !== undefined && (!Number.isInteger(p.gop_size) || p.gop_size < 1 || p.gop_size > 250)) errors.push('GOP size must be 1-250');
    // audio_bitrate_kbps is no longer a per-profile field — reject if the client still sends it.
    if (p.audio_bitrate_kbps !== undefined) errors.push('audio_bitrate_kbps is no longer a per-profile field; use the site-wide audio bitrate setting');
    return errors;
}

module.exports = {
    getGlobalProfiles,
    getCourseProfiles,
    getEffectiveProfiles,
    saveGlobalProfiles,
    saveCourseProfiles,
    deleteCourseProfiles,
    getAudioNormalizationSettings,
    saveAudioNormalizationSettings,
    getAudioBitrateDefault,
    saveAudioBitrateDefault,
    validateAudioBitrate,
    validateProfile
};
