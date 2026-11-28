'use strict';

async function migratePosterState(pool) {
    const [columns] = await pool.execute(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='videos' AND COLUMN_NAME='poster_path'`);
    if (!columns.length) await pool.execute('ALTER TABLE videos ADD COLUMN poster_path VARCHAR(255) NULL DEFAULT NULL');
    const [indexes] = await pool.execute(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='processing_queue' AND COLUMN_NAME='job_id' AND SEQ_IN_INDEX=1`);
    if (!indexes.length) await pool.execute('ALTER TABLE processing_queue ADD INDEX idx_processing_job_id (job_id)');
    // Existing objects stay at their original keys. New attempts use an immutable
    // generation key; no object copies or CDN invalidation are needed at upgrade.
    await pool.execute(`UPDATE videos SET poster_path=CONCAT('posters/',course_id,'/',video_id,'.jpg')
        WHERE has_poster=1 AND poster_path IS NULL`);
}

module.exports = { migratePosterState };
