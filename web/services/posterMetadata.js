const { confirmedPosterKey } = require('./posterPaths');

// Readiness is server-authoritative. Progress and a planned upload key are
// never sufficient to expose an image capability to the client.
async function posterMetadata(video, sign) {
    const key = confirmedPosterKey(video);
    if (!key) return { has_poster: false, posterPath: null, posterToken: '' };
    const posterPath = '/' + key;
    return { has_poster: true, posterPath, posterToken: await sign(posterPath) || '' };
}

module.exports = { posterMetadata };
