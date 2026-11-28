'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { posterMetadata } = require('../services/posterMetadata');

const JOB = 'Job000000007';
const POSTER = `posters/12/7/${JOB}.jpg`;
const ROW = {
    video_id: 7, course_id: 12, title: 'Synthetic video', description: '',
    module_number: 1, lecture_date: null, duration_seconds: 60,
    status: 'processing', processing_progress: 100, processing_job_id: JOB,
    hashed_video_id: 'P'.repeat(64), video_type: 'cmaf', original_filename: 'example.mp4',
    has_poster: 1, poster_path: POSTER, encryption_key: 'never-return-this-key',
};
const COURSE = { course_id: 12, course_code: 'EXAMPLE', course_name: 'Synthetic course', is_active: 1 };

function load(relative, dependencies, globals = {}) {
    const file = path.join(__dirname, '..', relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, exports: module.exports, Buffer,
        process: { env: { R2_PUBLIC_DOMAIN: 'video.example.test' } },
        console: { error() {} },
        require(name) {
            assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
            return dependencies[name];
        },
        ...globals,
    }, { filename: file });
    return module.exports;
}

// Honour the real SELECT projection rather than handing every query a full row.
// Removing poster_path or processing_job_id from videoCache's query must make
// the actual watch response fail this test, even though the stored row has both.
function projectVideo(sql, row) {
    const match = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+videos\b/i.exec(sql);
    assert.ok(match, 'expected video projection');
    if (match[1].trim() === '*') return { ...row };
    return Object.fromEntries(match[1].split(',').map(part => {
        const column = part.trim();
        assert.match(column, /^[a-z_]+$/i, `unsupported fixture projection: ${column}`);
        return [column, row[column]];
    }));
}

function fixture({ row: changes = {}, enrolled = true, authenticated = true } = {}) {
    const row = { ...ROW, ...changes };
    const queries = [], signedFiles = [], signedPrefixes = [], cacheWrites = [], cache = new Map();
    const pool = {
        async execute(sql, parameters) {
            queries.push({ sql, parameters });
            if (/SELECT COUNT\(\*\) as total FROM videos WHERE course_id/i.test(sql)) return [[{ total: 1 }]];
            if (/FROM videos WHERE (course_id|video_id)\s*=\s*\?/i.test(sql)) return [[projectVideo(sql, row)]];
            assert.fail(`unexpected SQL: ${sql}`);
        },
    };
    const database = { getPool: () => pool, idBuf: value => value };
    const redis = {
        async get(key) { return cache.get(key) ?? null; },
        async set(key, value, mode, ttl) { cacheWrites.push({ key, mode, ttl }); cache.set(key, value); },
    };
    const videoCache = load('services/cache/videoCache.js', {
        '../redis': { getClient: () => redis }, '../../config/database': database,
    });
    const user = {
        user_id: 'f'.repeat(32),
        permissions: { allowPlayback: true, uploadVideo: true, changeVideo: true, allCourseAccess: false },
    };
    const requireAuth = (_req, res, next) => authenticated
        ? (res.locals.user = user, next()) : res.status(401).json({ error: 'unauthenticated' });
    const permission = (...names) => (_req, res, next) => names.some(name => user.permissions[name])
        ? next() : res.status(403).json({ error: 'forbidden' });
    const routes = new Map();
    const router = { param() {} };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        router[method] = (route, ...handlers) => { routes.set(`${method.toUpperCase()} ${route}`, handlers); return router; };
    }
    const dependencies = {
        express: { Router: () => router },
        '../../services/posterMetadata': { posterMetadata },
        '../../middleware/auth': { requireAuth },
        '../../middleware/permissions': {
            checkPermission: permission, checkAnyPermission: permission,
            checkPermissionLevel: () => (_req, _res, next) => next(),
        },
        '../../middleware/stepup': { requireStepup: () => (_req, _res, next) => next() },
        '../../config/database': database,
        '../../config/session': {},
        '../../services/userService': {},
        '../../services/mfaService': {},
        '../../services/courseService': {},
        '../../services/videoService': {},
        '../../services/permissionService': {},
        '../../services/permissionConstants': {},
        '../../services/hostValidation': {},
        '../../services/playbackStatsService': {},
        '../../services/roleService': {},
        '../../services/workerAuthService': {},
        '../../services/transcodingProfileService': {},
        '../../services/enrollmentService': { isEnrolled: async () => enrolled },
        '../../services/tokenService': {
            async generateFileToken(file) { signedFiles.push(file); return 'synthetic-poster-token'; },
            async generateToken(prefix) { signedPrefixes.push(prefix); return 'synthetic-playback-token'; },
            async getTokenValiditySeconds() { return 600; },
        },
        '../../services/cache/courseCache': { getCourseMeta: async () => ({ ...COURSE }) },
        '../../services/cache/enrollmentCache': { isEnrolledInCourse: async () => enrolled },
        '../../services/cache/transcodeProgressCache': { applyLiveOverlayToVideos: async rows => rows },
        '../../services/cache/videoCache': videoCache,
        'ua-parser-js': () => ({}),
    };
    load('routes/api/pages.js', dependencies);
    load('routes/api/admin.js', dependencies);

    async function request(route) {
        const handlers = routes.get(`GET ${route}`);
        assert.ok(handlers, `missing actual route: ${route}`);
        assert.equal(handlers[0], requireAuth, 'route must retain authentication boundary');
        return new Promise((resolve, reject) => {
            let index = 0, finished = false;
            const timer = setTimeout(() => reject(new Error('route did not finish')), 2000);
            const res = {
                locals: {}, statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(body) {
                    if (finished) return this;
                    finished = true; clearTimeout(timer);
                    // JSON is the public boundary and also removes VM prototypes.
                    this.body = JSON.parse(JSON.stringify(body)); resolve(this); return this;
                },
            };
            const req = { method: 'GET', params: { courseId: '12', videoId: '7' }, query: {}, headers: {} };
            const fail = error => { clearTimeout(timer); reject(error); };
            const next = error => {
                if (finished) return;
                if (error) return fail(error);
                const handler = handlers[index++];
                if (!handler) return fail(new Error('route completed without response'));
                try { Promise.resolve(handler(req, res, next)).catch(fail); } catch (caught) { fail(caught); }
            };
            next();
        });
    }
    return { request, queries, signedFiles, signedPrefixes, cacheWrites, videoCache };
}

const READERS = [
    { label: 'normal course list', route: '/courses/:courseId', poster: body => body.videos[0] },
    { label: 'admin course list', route: '/admin/courses/:courseId/videos', poster: body => body.videos[0] },
    { label: 'watch metadata', route: '/watch/:videoId', poster: body => body, status: 'finished' },
];

for (const reader of READERS) {
    test(`${reader.label} returns the confirmed generation through its actual query and poster metadata`, async () => {
        const f = fixture({ row: { status: reader.status || 'processing' } });
        const response = await f.request(reader.route);
        assert.equal(response.statusCode, 200);
        const poster = reader.poster(response.body);
        assert.equal(poster.has_poster, true);
        assert.equal(poster.posterPath, '/' + POSTER);
        assert.equal(poster.posterToken, 'synthetic-poster-token');
        assert.deepEqual(f.signedFiles, ['/' + POSTER]);
        assert.ok(!JSON.stringify(response.body).includes('never-return-this-key'));
        assert.ok(f.queries.some(query => /FROM videos/i.test(query.sql)));
    });

    test(`${reader.label} never signs an unconfirmed planned path even at 100%`, async () => {
        const f = fixture({ row: { status: reader.status || 'processing', has_poster: 0 } });
        const response = await f.request(reader.route);
        assert.equal(response.statusCode, 200);
        const poster = reader.poster(response.body);
        assert.equal(poster.has_poster, false);
        assert.equal(poster.posterPath, null);
        assert.equal(poster.posterToken, '');
        assert.deepEqual(f.signedFiles, []);
    });

    test(`${reader.label} denies course access before issuing any image capability`, async () => {
        const f = fixture({ row: { status: reader.status || 'processing' }, enrolled: false });
        const response = await f.request(reader.route);
        assert.equal(response.statusCode, 403);
        assert.deepEqual(f.signedFiles, []);
        assert.deepEqual(f.signedPrefixes, []);
        assert.ok(!JSON.stringify(response.body).includes(POSTER));
    });
}

test('actual video cache selects and preserves poster_path plus processing_job_id across miss and hit', async () => {
    const f = fixture({ row: { status: 'finished' } });
    const first = await f.videoCache.getVideoMeta(7);
    assert.equal(first.poster_path, POSTER);
    assert.equal(first.processing_job_id, JOB);
    assert.equal(f.queries.length, 1);
    assert.match(f.queries[0].sql, /\bposter_path\b/);
    assert.match(f.queries[0].sql, /\bprocessing_job_id\b/);
    assert.deepEqual(f.cacheWrites, [{ key: 'video:meta:7', mode: 'EX', ttl: 1800 }]);
    const second = await f.videoCache.getVideoMeta(7);
    assert.equal(second.poster_path, POSTER);
    assert.equal(second.processing_job_id, JOB);
    assert.equal(f.queries.length, 1, 'cache hit must not re-query the database');
});
