'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const { createBackgroundTasks } = require('../lib/backgroundTasks');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function clock() {
    const scheduled = new Map();
    const add = (callback, delay, repeat) => {
        const handle = { unref() {} };
        scheduled.set(handle, { callback, delay, repeat });
        return handle;
    };
    return {
        scheduled,
        setTimeout: (fn, delay) => add(fn, delay, false),
        setInterval: (fn, delay) => add(fn, delay, true),
        clearTimeout: handle => scheduled.delete(handle),
        clearInterval: handle => scheduled.delete(handle),
        fire(handle) {
            const item = scheduled.get(handle);
            if (!item.repeat) scheduled.delete(handle);
            item.callback();
        },
    };
}
function load(relative, dependencies, globals = {}) {
    const filename = path.join(__dirname, '..', relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, console: { log() {}, error() {}, warn() {} },
        require(name) {
            if (Object.hasOwn(dependencies, name)) return dependencies[name];
            throw new Error(`Unstubbed dependency: ${name}`);
        },
        ...globals,
    }, { filename });
    return module.exports;
}

test('background stop cancels future timers and waits accepted work without overlapping ticks', async () => {
    const timers = clock(), tasks = createBackgroundTasks(timers), gate = deferred();
    let calls = 0, stopped = false;
    const interval = tasks.interval(async () => { calls++; await gate.promise; }, 10);
    const stale = tasks.timeout(() => { calls += 100; }, 20);
    const alreadyQueued = timers.scheduled.get(stale).callback;
    timers.fire(interval);
    timers.fire(interval);
    await turn();
    assert.equal(calls, 1);
    const done = tasks.stop().then(() => { stopped = true; });
    alreadyQueued();
    await turn();
    assert.equal(timers.scheduled.size, 0);
    assert.equal(stopped, false);
    assert.equal(tasks.interval(() => {}, 1), null);
    assert.equal(tasks.timeout(() => {}, 1), null);
    gate.resolve(); await done;
    assert.equal(calls, 1);
    assert.deepEqual(await tasks.stop(), []);
});

test('database close is awaited and idempotent, forbids late reopening and never creates a pool', async () => {
    let creates = 0, ends = 0;
    const gate = deferred();
    const deps = { 'mysql2/promise': { createPool() { creates++; return { end() { ends++; return gate.promise; } }; } } };
    const db = load('config/database.js', deps, { process: { env: {} }, Buffer });
    db.getPool();
    const first = db.closePool();
    assert.equal(db.closePool(), first);
    assert.throws(() => db.getPool(), /shutting down/);
    let closed = false; first.then(() => { closed = true; });
    await turn(); assert.equal(closed, false);
    gate.resolve(); await first;
    assert.equal(creates, 1); assert.equal(ends, 1);
    const unused = load('config/database.js', deps, { process: { env: {} }, Buffer });
    await unused.closePool(); assert.equal(creates, 1);
});

test('accepted background failures remain observable to shutdown', async () => {
    const tasks = createBackgroundTasks(clock());
    tasks.run(() => { throw new Error('synthetic failure'); });
    const results = await tasks.stop();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'rejected');
});

function serverFixture(options = {}) {
    const timers = clock(), backgroundTasks = createBackgroundTasks(timers);
    const events = [], signals = {}, exits = [];
    const request = options.request || { promise: Promise.resolve() };
    let listening;
    let firstMiddleware, realServer;
    const noOp = () => {};
    const app = { disable: noOp, use(handler) { firstMiddleware ||= handler; }, get: noOp,
        listen(_port, callback) {
            listening = callback;
            if (options.handleRequest) {
                realServer = http.createServer((req, res) => {
                    res.set = headers => { for (const [key, value] of Object.entries(headers)) res.setHeader(key, value); };
                    res.status = code => { res.statusCode = code; return res; };
                    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
                    firstMiddleware(req, res, () => options.handleRequest(req, res));
                });
                realServer.listen(0, '127.0.0.1', callback);
                return realServer;
            }
            return { on: noOp, closeIdleConnections: noOp, close(done) {
                events.push('http-close'); request.promise.then(() => done());
            } };
        } };
    const express = Object.assign(() => app, { static: noOp, json: noOp, urlencoded: noOp });
    const morgan = Object.assign(noOp, { token: noOp });
    const deps = {
        dotenv: { config: noOp }, express, path, fs: { existsSync: () => false },
        morgan, compression: noOp, 'cookie-parser': noOp,
        './config/session': { cleanExpiredSessions: async () => {} },
        './lib/backgroundTasks': backgroundTasks,
        './routes/publicJwks': { publicJwksRouter: noOp },
        './routes/fonts': { fontsRouter: noOp },
        './middleware/ssoEventBody': { eventFormParser: noOp },
        './middleware/installer': { checkInstalled: noOp, InstallStateUnknownError: class extends Error {},
            resolveInstallState: () => options.install?.promise || Promise.resolve(true) },
        './lib/installToken': { clearInstallToken: noOp, ensureInstallToken: () => 'synthetic', TOKEN_FILE: 'synthetic' },
        './middleware/auth': { loadUser: noOp },
        './db/migrations': { runMigrations: async () => {} },
        './services/redis': { async connect() { events.push('connect'); await options.connect?.promise; },
            async quit() { events.push('quit'); await options.quit?.promise; } },
        './services/cache/permissionCache': { invalidateAllRoles: async () => {} },
        './services/cache/settingsCache': { invalidate: async () => {} },
        './lib/oidc': { loadConfig: async () => {} },
        './services/flusher': { start() { events.push('flusher-start'); }, stop: noOp,
            async flushAll() { events.push('flush'); await options.flush?.promise; return 0; } },
        './services/ssoEvents': { start() { events.push('sso-start'); } },
        './services/mfaService': { cleanupExpiredChallenges: options.mfa?.[0] || noOp,
            cleanupExpiredBmfa: options.mfa?.[1] || noOp, cleanupExpiredTotpRateLimits: options.mfa?.[2] || noOp },
        './services/deletionService': { startReaper: noOp },
        './services/workerAuthService': { cleanupExpiredWorkerSessions: async () => 0 },
        './services/processingService': { resetStaleTasks: noOp, resetExpiredPendingTasks: noOp },
        './services/uploadSessionService': { resetStaleUploads: async () => {} },
        './config/database': { async closePool() { events.push('db-close'); await options.db?.promise; } },
    };
    const routeNames = ['install', 'auth', 'backchannel', 'api/app', 'api/pages', 'api/admin', 'api/upload',
        'api/videos', 'api/worker', 'api/mfa-admin', 'api/materials', 'api/sso'];
    for (const name of routeNames) deps[`./routes/${name}`] = noOp;
    load('server.js', deps, { __dirname: path.join(__dirname, '..'), ...timers,
        console: { log: noOp, warn: noOp, error: (...args) => events.push(['error', ...args]) },
        process: { env: { DB_HOST: 'synthetic', DB_NAME: 'synthetic', REDIS_HOST: 'synthetic' },
            on(name, callback) { signals[name] = callback; }, exit(code) { exits.push(code); } } });
    return { timers, backgroundTasks, events, exits, signals, listen: () => listening(), server: realServer, admit: firstMiddleware };
}

test('real server waits HTTP, active jobs and final flush before Redis/database close; repeated signal is inert', async () => {
    const request = deferred(), work = deferred(), flush = deferred(), db = deferred();
    const f = serverFixture({ request, flush, db });
    f.listen(); await turn();
    const job = f.backgroundTasks.run(async () => { await work.promise; f.events.push('work-done'); });
    const done = f.signals.SIGTERM();
    await f.signals.SIGINT();
    await turn(); assert.equal(f.events.includes('flush'), false);
    request.resolve(); await turn(); assert.equal(f.events.includes('flush'), false);
    work.resolve(); await job; await turn();
    assert.equal(f.events.at(-1), 'flush'); assert.equal(f.events.includes('quit'), false);
    flush.resolve(); await turn();
    assert.deepEqual(f.events.slice(-2), ['quit', 'db-close']); assert.deepEqual(f.exits, []);
    db.resolve(); await done;
    assert.deepEqual(f.exits, [0]); assert.equal(f.timers.scheduled.size, 0);
});

test('shutdown during install-state resolution never starts Redis or pumps, and skips unconnected flush', async () => {
    const install = deferred(), f = serverFixture({ install });
    f.listen(); const done = f.signals.SIGTERM(); await turn();
    assert.equal(f.events.includes('db-close'), false);
    install.resolve(true); await done;
    assert.deepEqual(f.events, ['http-close', 'quit', 'db-close']);
    assert.deepEqual(f.exits, [0]);
});

test('shutdown waits an in-flight Redis connect but never starts pumps afterward', async () => {
    const connect = deferred(), f = serverFixture({ connect });
    f.listen(); await turn(); assert.deepEqual(f.events, ['connect']);
    const done = f.signals.SIGTERM(); await turn();
    assert.equal(f.events.includes('quit'), false);
    connect.resolve(); await done;
    assert.deepEqual(f.events, ['connect', 'http-close', 'flush', 'quit', 'db-close']);
    assert.deepEqual(f.exits, [0]);
});

test('startup failure overlapping SIGTERM is nonzero and logs only a safe error code', async () => {
    const connect = deferred(), f = serverFixture({ connect });
    f.listen(); await turn(); const done = f.signals.SIGTERM();
    const error = new Error('PRIVATE_TOKEN'); error.code = 'ECONNREFUSED';
    connect.reject(error); await done;
    assert.deepEqual(f.exits, [1]);
    assert.equal(JSON.stringify(f.events).includes('PRIVATE_TOKEN'), false);
    assert.equal(JSON.stringify(f.events).includes('ECONNREFUSED'), true);
    assert.equal(f.events.at(-1), 'db-close');
});

test('already-started detached request work is admitted during HTTP drain and awaited before close', async () => {
    const request = deferred(), work = deferred(), f = serverFixture({ request });
    f.listen(); await turn(); const done = f.signals.SIGTERM();
    f.backgroundTasks.track(work.promise); // Accepted request started this after stop.
    request.resolve(); await turn(); assert.equal(f.events.includes('flush'), false);
    work.resolve(); await done; assert.deepEqual(f.exits, [0]);
});

test('ordinary background rejection is reported without turning successful cleanup into failure', async () => {
    const work = deferred(), f = serverFixture();
    f.listen(); await turn(); f.backgroundTasks.track(work.promise);
    const done = f.signals.SIGTERM(); work.reject(new Error('synthetic failure')); await done;
    assert.deepEqual(f.exits, [0]);
    assert.equal(f.events.some(event => Array.isArray(event) && event[1] === 'Background task failed during stop:'), true);
});

test('one failed MFA cleanup never lets shutdown close dependencies beneath its unfinished siblings', async () => {
    const sibling = deferred();
    const f = serverFixture({ mfa: [async () => { throw new Error('synthetic failure'); },
        () => sibling.promise, async () => {}] });
    f.listen(); await turn();
    const hourly = [...f.timers.scheduled.entries()].filter(([, timer]) => timer.delay === 3600000);
    f.timers.fire(hourly[1][0]); await turn();
    const done = f.signals.SIGTERM(); await turn();
    assert.equal(f.events.includes('flush'), false);
    sibling.resolve(); await done;
    assert.deepEqual(f.exits, [0]);
});

test('reused keep-alive after SIGTERM closes or gets 503, never reaching business handlers', async t => {
    const entered = deferred(), release = deferred(); let lateRequests = 0;
    const f = serverFixture({ handleRequest(req, res) {
        if (req.url === '/first') { entered.resolve(); release.promise.then(() => res.end('accepted')); }
        else { lateRequests++; res.end('unexpected'); }
    } });
    await new Promise((resolve, reject) => { f.server.once('listening', resolve); f.server.once('error', reject); });
    await turn();
    const socket = net.connect(f.server.address().port, '127.0.0.1');
    t.after(() => { release.resolve(); socket.destroy(); f.server.closeAllConnections(); f.server.close(); });
    const chunks = []; socket.on('data', chunk => chunks.push(chunk));
    let transportClosed = false;
    const ended = new Promise((resolve, reject) => {
        socket.on('end', () => { transportClosed = true; resolve(); });
        socket.on('error', error => {
            if (!['ECONNRESET', 'EPIPE'].includes(error.code)) return reject(error);
            transportClosed = true; resolve();
        });
    });
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('GET /first HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await entered.promise;
    const done = f.signals.SIGTERM();
    // A request that reaches Express while its previous request drains has
    // these exact semantics. Node may instead close/reset the socket first.
    const responseState = {};
    f.admit({}, { set(headers) { responseState.headers = headers; },
        status(code) { responseState.code = code; return this; },
        json(body) { responseState.body = body; } }, () => { lateRequests++; });
    assert.equal(responseState.code, 503);
    assert.equal(responseState.headers.Connection, 'close');
    assert.equal(responseState.headers['Cache-Control'], 'no-store');
    assert.equal(responseState.body.error, 'service_stopping');
    socket.write('GET /later HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    await turn(); release.resolve(); await ended; await done;
    const response = Buffer.concat(chunks).toString();
    assert.equal(lateRequests, 0);
    assert.equal(transportClosed, true);
    if (response.includes('503')) {
        assert.match(response, /Cache-Control: no-store/i);
        assert.match(response, /Connection: close/i);
        assert.match(response, /service_stopping/);
    }
    assert.deepEqual(f.exits, [0]);
});

test('one 25-second total deadline forces nonzero exit for stuck work', async () => {
    const request = deferred(), f = serverFixture({ request });
    f.listen(); await turn(); f.signals.SIGTERM();
    const deadlines = [...f.timers.scheduled.entries()];
    assert.equal(deadlines.length, 1); assert.equal(deadlines[0][1].delay, 25000);
    f.timers.fire(deadlines[0][0]); assert.deepEqual(f.exits, [1]);
    assert.equal(f.events.includes('db-close'), false);
    request.resolve(); await turn();
});

test('flush failure still closes Redis/database and exits nonzero', async () => {
    const flush = deferred(), f = serverFixture({ flush });
    f.listen(); await turn(); const done = f.signals.SIGTERM();
    await turn(); flush.reject(new Error('synthetic failure')); await done;
    assert.deepEqual(f.events.filter(event => typeof event === 'string').slice(-3), ['flush', 'quit', 'db-close']);
    assert.deepEqual(f.exits, [1]);
});

test('Redis quit rejection reaches shutdown, which still closes the database and exits nonzero', async () => {
    const quit = deferred(), f = serverFixture({ quit });
    f.listen(); await turn(); const done = f.signals.SIGTERM(); await turn();
    quit.reject(new Error('synthetic failure')); await done;
    assert.equal(f.events.includes('db-close'), true); assert.deepEqual(f.exits, [1]);
});

test('actual Redis wrapper propagates quit failure and releases its client reference', async () => {
    const failure = new Error('synthetic failure');
    class Redis {
        on() {} async connect() {} async ping() {}
        async config(_verb, key) { return [key, key === 'appendonly' ? 'yes' : 'volatile-lru']; }
        async quit() { throw failure; }
    }
    const redis = load('services/redis.js', { ioredis: Redis }, { process: { env: {} } });
    await redis.connect();
    await assert.rejects(redis.quit(), error => error === failure);
    assert.throws(() => redis.getClient(), /not connected/);
    await redis.quit();
});

test('database close is inside the same 25-second deadline and failures are nonzero', async () => {
    const db = deferred(), f = serverFixture({ db });
    f.listen(); await turn(); const done = f.signals.SIGTERM(); await turn();
    assert.equal(f.events.at(-1), 'db-close'); assert.deepEqual(f.exits, []);
    const deadlines = [...f.timers.scheduled.entries()];
    assert.equal(deadlines.length, 1); assert.equal(deadlines[0][1].delay, 25000);
    f.timers.fire(deadlines[0][0]); assert.deepEqual(f.exits, [1]);
    db.reject(new Error('synthetic failure')); await done;
    assert.deepEqual(f.exits, [1, 1]); // The real first process.exit terminates immediately.
});

test('SSO shutdown finishes its claimed durable job and takes no next claim', async () => {
    const tasks = createBackgroundTasks(clock()), transport = deferred();
    let claims = 0, finishes = 0;
    const store = { snapshot: async () => {}, importLegacy: async () => {},
        claim: async () => { claims++; return { event: { id: 'synthetic' } }; },
        finish: async () => { finishes++; return true; } };
    const events = load('services/ssoEvents.js', {
        '../lib/backgroundTasks': tasks, '../lib/oidc': { signEventToken: async () => 'synthetic', ssoEventsUrl: () => 'https://example.invalid' },
        './s2sFetch': { s2sFetch: () => transport.promise }, './redis': { getClient: () => ({}) },
        '../config/database': { getPool: () => ({}) }, './ssoCatalogStore': { createCatalogStore: () => store },
        '../lib/ssoRoleProtocol': { EVENT_TOKEN_LIMIT: 100 },
    }, { AbortSignal, URLSearchParams });
    const draining = events.drain(); await turn();
    let stopped = false; const done = tasks.stop().then(() => { stopped = true; });
    await turn(); assert.equal(stopped, false);
    transport.resolve({ status: 204 }); await draining; await done;
    assert.equal(claims, 1); assert.equal(finishes, 1);
    await events.drain(); assert.equal(claims, 1);
});

test('deletion shutdown awaits its current row and leaves subsequent durable rows for next boot', async () => {
    const tasks = createBackgroundTasks(clock()), deletion = deferred();
    let selects = 0, deletes = 0;
    const pool = { async execute(sql) {
        if (sql.includes('SELECT')) { selects++; return [[{ id: 1, mode: 'key', target: 'synthetic' }]]; }
        if (sql.includes('DELETE')) deletes++;
        return [];
    } };
    const Command = class {};
    const service = load('services/deletionService.js', {
        '../lib/backgroundTasks': tasks,
        '@aws-sdk/client-s3': { ListObjectsV2Command: Command, DeleteObjectCommand: Command, DeleteObjectsCommand: Command },
        '../config/database': { getPool: () => pool },
        '../config/r2': { getR2BucketName: () => 'synthetic', getR2Client: () => ({ send: () => deletion.promise }) },
    }, { process: { env: {} }, setTimeout });
    const reaping = service.runReaper(); await turn();
    let stopped = false; const done = tasks.stop().then(() => { stopped = true; });
    await turn(); assert.equal(stopped, false); assert.equal(deletes, 0);
    deletion.resolve({}); await reaping; await done;
    assert.equal(selects, 1); assert.equal(deletes, 1);
    await service.runReaper(); assert.equal(selects, 1);
});

test('stopping a failed delete attempt skips retries/backoff and leaves the durable row unchanged', async () => {
    const tasks = createBackgroundTasks(clock()), deletion = deferred();
    let sends = 0, sleeps = 0; const writes = [];
    const pool = { async execute(sql) {
        if (sql.includes('SELECT')) return [[{ id: 1, mode: 'key', target: 'synthetic' }]];
        writes.push(sql); return [];
    } };
    const Command = class {};
    const service = load('services/deletionService.js', {
        '../lib/backgroundTasks': tasks,
        '@aws-sdk/client-s3': { ListObjectsV2Command: Command, DeleteObjectCommand: Command, DeleteObjectsCommand: Command },
        '../config/database': { getPool: () => pool },
        '../config/r2': { getR2BucketName: () => 'synthetic', getR2Client: () => ({ send() { sends++; return deletion.promise; } }) },
    }, { process: { env: {} }, setTimeout() { sleeps++; } });
    const reaping = service.runReaper(); await turn(); const done = tasks.stop();
    deletion.reject(new Error('synthetic failure')); await reaping; await done;
    assert.equal(sends, 1); assert.equal(sleeps, 0); assert.deepEqual(writes, []);
});

test('stopping a prefix sweep between list and delete never falsely completes the durable row', async () => {
    const tasks = createBackgroundTasks(clock()), listing = deferred();
    let sends = 0; const writes = [];
    const pool = { async execute(sql) {
        if (sql.includes('SELECT')) return [[{ id: 1, mode: 'prefix', target: 'synthetic/' }]];
        writes.push(sql); return [];
    } };
    const Command = class {};
    const service = load('services/deletionService.js', {
        '../lib/backgroundTasks': tasks,
        '@aws-sdk/client-s3': { ListObjectsV2Command: Command, DeleteObjectCommand: Command, DeleteObjectsCommand: Command },
        '../config/database': { getPool: () => pool },
        '../config/r2': { getR2BucketName: () => 'synthetic', getR2Client: () => ({ send() { sends++; return listing.promise; } }) },
    }, { process: { env: {} }, setTimeout });
    const reaping = service.runReaper(); await turn(); const done = tasks.stop();
    listing.resolve({ Contents: [{ Key: 'synthetic/one' }], IsTruncated: true, NextContinuationToken: 'synthetic' });
    await reaping; await done;
    assert.equal(sends, 1); assert.deepEqual(writes, []);
});
