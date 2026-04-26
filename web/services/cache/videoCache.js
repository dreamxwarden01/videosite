// Video metadata cache.
//
// Caches a video's row only when status='finished' — the playback-relevant
// stable state. Non-finished rows change too frequently (progress heartbeats
// every 2s during transcoding) to be worth caching, and skipping them avoids
// having to invalidate on every progress update.
//
// The cached fields cover everything the playback / refresh-token paths need:
// hashed_video_id and processing_job_id to construct the URL prefix, plus
// course_id for the enrollment check, plus the descriptive fields for UI.

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');

const TTL = 30 * 60; // 30 min
const key = (id) => `video:meta:${id}`;

async function loadFromDb(videoId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT video_id, course_id, title, description, week, lecture_date,
                hashed_video_id, duration_seconds, status, processing_job_id,
                video_type, original_filename
         FROM videos WHERE video_id = ?`,
        [videoId]
    );
    return rows[0] || null;
}

async function getVideoMeta(videoId) {
    const redis = getClient();
    const cached = await redis.get(key(videoId));
    if (cached) return JSON.parse(cached);

    const row = await loadFromDb(videoId);
    if (!row) return null;

    // Only cache stable (finished) rows. Transient states cycle too fast
    // and don't need cache help — playback is gated on 'finished' anyway.
    if (row.status === 'finished') {
        await redis.set(key(videoId), JSON.stringify(row), 'EX', TTL);
    }
    return row;
}

async function invalidate(videoId) {
    await getClient().del(key(videoId));
}

async function invalidateMany(videoIds) {
    if (!videoIds || videoIds.length === 0) return;
    await getClient().del(...videoIds.map(key));
}

module.exports = { getVideoMeta, invalidate, invalidateMany };
