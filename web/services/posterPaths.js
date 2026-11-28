'use strict';

const JOB_ID = /^[A-Za-z0-9]{12}$/;
function id(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError('invalid_poster_identity');
    return String(number);
}
function legacyPosterKey(courseId, videoId) {
    return `posters/${id(courseId)}/${id(videoId)}.jpg`;
}
function jobPosterKey(courseId, videoId, jobId) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new TypeError('invalid_poster_job');
    return `posters/${id(courseId)}/${id(videoId)}/${jobId}.jpg`;
}
function ownedPosterKey(video, key) {
    if (typeof key !== 'string') return null;
    const legacy = legacyPosterKey(video.course_id, video.video_id);
    if (key === legacy) return key;
    const prefix = `posters/${id(video.course_id)}/${id(video.video_id)}/`;
    const job = key.startsWith(prefix) && key.endsWith('.jpg') ? key.slice(prefix.length, -4) : '';
    return JOB_ID.test(job) ? key : null;
}
function confirmedPosterKey(video) {
    if (!(video.has_poster === true || Number(video.has_poster) === 1)) return null;
    if (video.poster_path == null) return legacyPosterKey(video.course_id, video.video_id);
    const key = ownedPosterKey(video, video.poster_path);
    if (!key) return null;
    if (key === legacyPosterKey(video.course_id, video.video_id)) return key;
    return JOB_ID.test(video.processing_job_id || '')
        && key === jobPosterKey(video.course_id, video.video_id, video.processing_job_id) ? key : null;
}

module.exports = { JOB_ID, legacyPosterKey, jobPosterKey, ownedPosterKey, confirmedPosterKey };
