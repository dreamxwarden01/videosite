'use strict';
// Opt-in real SQL/Redis fixture coverage. Uses only explicit generated loopback
// endpoints, the production pool typeCast and actual session/cache modules.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(relative, dependencies) {
    const file = path.join(__dirname, '..', relative), module = { exports: {} };
    const requireFixture = name => {
        if (!Object.hasOwn(dependencies, name)) throw new Error('unexpected_import:' + name);
        return dependencies[name];
    };
    vm.runInNewContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})',
        { Buffer, Date, process: { env: {} }, console: { log() {}, warn() {}, error() {} } },
        { filename: file })(requireFixture, module, module.exports);
    return module.exports;
}
function barrier() {
    let arrived, resume;
    return { entered: new Promise(resolve => { arrived = resolve; }), released: new Promise(resolve => { resume = resolve; }),
        arrive: () => arrived(), release: () => resume() };
}
const enabled = process.env.VS_SSO_ISOLATED_TEST === '1';
test('VideoSite session SQL authority with real production typecast and Redis', { skip: !enabled }, async t => {
    const dbUrl = new URL(process.env.VS_TEST_DB_URI || 'invalid:');
    const redisUrl = new URL(process.env.VS_TEST_REDIS_URI || 'invalid:');
    if (dbUrl.protocol !== 'mysql:' || dbUrl.hostname !== '127.0.0.1' || redisUrl.hostname !== '127.0.0.1'
        || !/^\/vs_sso_test_[a-z0-9_]+$/.test(dbUrl.pathname)
        || !['redis:', 'rediss:'].includes(redisUrl.protocol)) throw new Error('disposable_fixture_required');
    const mysql = require('mysql2/promise'), Redis = require('ioredis');
    let productionOptions;
    const database = load('config/database.js', { 'mysql2/promise': {
        createPool(options) { productionOptions = options; return {}; },
    } });
    database.getPool();
    const pool = mysql.createPool({ ...productionOptions, host: dbUrl.hostname, port: Number(dbUrl.port || 3306),
        user: decodeURIComponent(dbUrl.username), password: decodeURIComponent(dbUrl.password), database: dbUrl.pathname.slice(1),
        connectionLimit: 4 });
    const namespace = 'vs-session-test:' + crypto.randomUUID() + ':';
    const redis = new Redis(redisUrl.toString(), { keyPrefix: namespace, maxRetriesPerRequest: 1 });
    const table = 'a04_sessions_' + crypto.randomBytes(8).toString('hex');
    // A private table prevents interaction with the role suite's simpler schema.
    const fixturePool = { execute: (sql, args) => pool.execute(sql.replace(/\bsessions\b/g, table), args) };
    let settingsGate, created = false;
    const settings = { async getSetting(key, fallback) {
        if (settingsGate) { const gate = settingsGate; settingsGate = null; gate.arrive(); await gate.released; }
        return ({ session_inactivity_days: '1', session_max_days: '3' })[key] ?? fallback;
    } };
    const cache = load('services/cache/sessionCache.js', { '../redis': { getClient: () => redis } });
    const sessions = load('config/session.js', { crypto, './database': { getPool: () => fixturePool, idBuf: database.idBuf },
        '../services/cache/sessionCache': cache, '../services/cache/settingsCache': settings });
    const user = crypto.randomBytes(16).toString('hex'), ssoSid = crypto.randomUUID(), generation = '9007199254740993';
    const make = () => sessions.createSession(user, 'fixture', '127.0.0.1', ssoSid, new Date(Date.now() + 3600000), generation);
    try {
        await redis.ping();
        await pool.query(`CREATE TABLE ${table} (
            session_id VARCHAR(128) PRIMARY KEY, user_id BINARY(16) NOT NULL,
            last_seen DATETIME NOT NULL, last_sign_in DATETIME NOT NULL,
            user_agent VARCHAR(255), ip_address VARCHAR(45), sso_sid VARCHAR(64), sso_expires_at DATETIME,
            sso_role_generation BIGINT NOT NULL DEFAULT 0, stepup_at DATETIME, stepup_method VARCHAR(16))`);
        created = true;
        await t.test('warm cache preserves SQL typecast identity, bigint generation and SQL expiry', async () => {
            const id = await make(), session = await sessions.getSession(id);
            assert.equal(typeof session.user_id, 'string'); assert.equal(session.user_id, user);
            assert.equal(session.sso_role_generation, generation); assert.equal(typeof session.sso_role_generation, 'string');
            const [[stored]] = await fixturePool.execute('SELECT user_id,last_sign_in,sso_expires_at FROM sessions WHERE session_id=?', [id]);
            assert.equal(stored.user_id, user); assert.equal(session.last_sign_in, stored.last_sign_in.getTime());
            assert.equal(session.sso_expires_at, stored.sso_expires_at.getTime());
            assert.equal(await sessions.isSessionValid(session), true);
        });
        await t.test('a SQL-revoked warm cache is denied and removed with its user index member', async () => {
            const id = await make();
            await fixturePool.execute('DELETE FROM sessions WHERE session_id=?', [id]);
            assert.ok(await cache.getSession(id));
            assert.equal(await sessions.getSessionById(id), null);
            assert.equal(await sessions.getSession(id), null); assert.equal(await cache.getSession(id), null);
            assert.equal((await cache.getUserSids(user)).includes(id), false);
        });
        await t.test('late refill after a completed SID revoke cannot authorize a later read', async () => {
            const id = await make(); await cache.deleteSession(id, user);
            const gate = barrier(); settingsGate = gate;
            const oldRead = sessions.getSession(id); await gate.entered;
            await sessions.deleteSessionsBySsoSid(ssoSid);
            gate.release(); await oldRead;
            assert.ok(await cache.getSession(id), 'the fixture must create a real late Redis refill');
            assert.equal(await sessions.getSession(id), null); assert.equal(await cache.getSession(id), null);
        });
        await t.test('normal same-SSO-SID login replacement remains valid with a fresh SQL ID', async () => {
            const old = await make(); await sessions.deleteSessionsBySsoSid(ssoSid);
            const replacement = await make(); assert.notEqual(replacement, old);
            assert.equal(await sessions.getSession(old), null);
            const current = await sessions.getSession(replacement);
            assert.equal(current.sso_sid, ssoSid); assert.equal(current.sso_role_generation, generation);
            assert.equal(await sessions.isSessionValid(current), true);
        });
    } finally {
        try {
            if (created) await pool.query(`DROP TABLE ${table}`);
            const keys = await redis.keys('*');
            const unprefixed = keys.filter(key => key.startsWith(namespace)).map(key => key.slice(namespace.length));
            if (unprefixed.length) await redis.del(...unprefixed);
        } finally { await Promise.all([pool.end(), redis.quit()]); }
    }
});
