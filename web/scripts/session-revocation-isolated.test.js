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
    const stateTable = table + '_state';
    const mapSql = sql => sql.replace(/\bsso_session_state\b/g, stateTable).replace(/\bsessions\b/g, table);
    let creationGate;
    const wrap = db => ({
        execute: async (sql, args) => {
            if (creationGate && /^INSERT INTO sessions /.test(sql.trim())) { const gate = creationGate; creationGate = null; gate.arrive(); await gate.released; }
            return db.execute(mapSql(sql), args);
        },
        query: (sql, args) => db.query(mapSql(sql), args),
        beginTransaction: () => db.beginTransaction(), commit: () => db.commit(), rollback: () => db.rollback(), release: () => db.release(),
    });
    const membershipQueries = [];
    const fixturePool = { execute: (sql, args) => {
        if (/^\s*SELECT session_id/.test(sql)) membershipQueries.push({ sql, args });
        return pool.execute(mapSql(sql), args);
    }, getConnection: async () => wrap(await pool.getConnection()) };
    let settingsGate, created = false;
    const settings = { async getSetting(key, fallback) {
        if (settingsGate) { const gate = settingsGate; settingsGate = null; gate.arrive(); await gate.released; }
        return ({ session_inactivity_days: '1', session_max_days: '3' })[key] ?? fallback;
    } };
    const cache = load('services/cache/sessionCache.js', { '../redis': { getClient: () => redis } });
    const protocol = load('lib/ssoRoleProtocol.js', { 'node:crypto': crypto });
    const catalog = load('services/ssoCatalogStore.js', { 'node:crypto': crypto, '../lib/ssoRoleProtocol': protocol });
    const reload = () => load('config/session.js', { crypto, './database': { getPool: () => fixturePool, idBuf: database.idBuf },
        '../services/cache/sessionCache': cache, '../services/cache/settingsCache': settings, '../services/ssoCatalogStore': catalog });
    const sessions = reload();
    const user = crypto.randomBytes(16).toString('hex'), ssoSid = crypto.randomUUID(), generation = '9007199254740993';
    const make = () => sessions.createSession(user, 'fixture', '127.0.0.1', ssoSid, new Date(Date.now() + 3600000), generation);
    try {
        await redis.ping();
        await pool.query(`CREATE TABLE ${table} (
            session_id VARCHAR(128) PRIMARY KEY, user_id BINARY(16) NOT NULL,
            last_seen DATETIME NOT NULL, last_sign_in DATETIME NOT NULL,
            user_agent VARCHAR(255), ip_address VARCHAR(45), sso_sid VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci, sso_expires_at DATETIME,
            sso_role_generation BIGINT NOT NULL DEFAULT 0, stepup_at DATETIME, stepup_method VARCHAR(16))`);
        created = true;
        const migration = load('db/ssoSessionMigration.js', {});
        await migration.migrateSsoSessions(fixturePool); await migration.migrateSsoSessions(fixturePool);
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
        await t.test('terminal logout serializes behind an admitted callback, and later/restarted callbacks stay rejected', async () => {
            const master = crypto.randomUUID(), subject = user.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
            const gate = barrier(); creationGate = gate;
            const create = sessions.createSession(user, null, null, master, new Date(Date.now() + 3600000), generation);
            await gate.entered;
            const revoke = sessions.revokeSessionsBySsoSid(master, subject);
            gate.release(); const id = await create; await revoke;
            assert.equal(await sessions.getSession(id), null);
            const restarted = reload();
            await assert.rejects(restarted.createSession(user, null, null, master), /sso_session_revoked/);
            await assert.rejects(restarted.revokeSessionsBySsoSid(master, crypto.randomUUID()), /sso_session_binding_mismatch/);
            const [[state]] = await pool.execute(`SELECT revoked FROM ${stateTable} WHERE sso_sid=?`, [master]);
            assert.equal(state.revoked, 1);
        });
        await t.test('terminal logout before any local callback persists even without a session/index', async () => {
            const master = crypto.randomUUID(), subject = user.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
            assert.equal(await sessions.revokeSessionsBySsoSid(master, subject), 0);
            await assert.rejects(reload().createSession(user, null, null, master), /sso_session_revoked/);
        });
        await t.test('actual session membership queries use indexed terminal SID lookups across utf8mb4/ascii charsets', async () => {
            const master='abcdefab-cdef-4abc-8def-abcdefabcdef';
            const id=await sessions.createSession(user,null,null,master,new Date(Date.now()+3600000),generation),values=[],parameters=[];
            for (let n=0;n<2048;n++) { values.push('(?,?,0)'); parameters.push(crypto.randomUUID(),Buffer.from(user,'hex')); }
            await pool.execute(`INSERT INTO ${stateTable}(sso_sid,subject_id,revoked) VALUES ${values.join(',')}`,parameters);
            await pool.query(`ANALYZE TABLE ${stateTable}`);
            const [[outer]]=await pool.execute(`SELECT sso_sid FROM ${table} WHERE session_id=?`,[id]);
            const [[target]]=await pool.execute(`SELECT sso_sid FROM ${stateTable} WHERE sso_sid=?`,[master]);
            assert.equal(outer.sso_sid,master);assert.equal(target.sso_sid,master);
            const [probe]=await pool.execute(`EXPLAIN SELECT sso_sid FROM ${stateTable} WHERE sso_sid=?`,[master]);
            assert.ok(probe.some(row=>row.key==='PRIMARY'&&['const','eq_ref','ref'].includes(row.type)));
            membershipQueries.length=0;assert.ok(await sessions.getSession(id));assert.ok(await sessions.getSessionById(id));
            assert.equal(membershipQueries.length,2);
            function extra(value) {
                if(/no matching row in const table/i.test(value||''))return 'no matching row in const table';
                if(/impossible where.*const tables/i.test(value||''))return 'Impossible WHERE after const tables';
                if(/using where/i.test(value||''))return 'Using where';
                if(/using index/i.test(value||''))return 'Using index';
                return value?'other':'';
            }
            const compact=plan=>plan.map(row=>({table:row.table,access_type:row.type,key:row.key,rows:row.rows,ref:row.ref,extra:extra(row.Extra)}));
            for(const [number,query] of membershipQueries.entries()) {
                const legacy=query.sql.replace(/state\.sso_sid=CONVERT\(LOWER\(sessions\.sso_sid\) USING ascii\) COLLATE ascii_bin/g,'state.sso_sid=sessions.sso_sid');
                const [actualPlan]=await pool.execute('EXPLAIN '+mapSql(query.sql),query.args),[legacyPlan]=await pool.execute('EXPLAIN '+mapSql(legacy),query.args);
                const actual=compact(actualPlan),reference=compact(legacyPlan);
                console.log(JSON.stringify({fixture:'terminal-sid-plan',query:number===0?'getSession':'getSessionById',actual,legacyReference:reference}));
                const stateRows=actual.filter(row=>row.table==='state');
                if(stateRows.length)assert.ok(stateRows.some(row=>row.key==='PRIMARY'&&['const','eq_ref','ref'].includes(row.access_type)),JSON.stringify(actual));
                else assert.ok(actual.some(row=>row.table===null&&['no matching row in const table','Impossible WHERE after const tables'].includes(row.extra)),JSON.stringify(actual));
                // Nonempty equal results and the direct PRIMARY probe above prove
                // a missing state EXPLAIN row is predicate constant-folding, not
                // an absent outer session or absent terminal-state key.
                const [actualRows]=await pool.execute(mapSql(query.sql),query.args),[legacyRows]=await pool.execute(mapSql(legacy),query.args);
                assert.equal(actualRows.length,1);assert.equal(legacyRows.length,1);assert.deepEqual(actualRows,legacyRows);
            }
            await pool.execute(`UPDATE ${stateTable} SET revoked=1 WHERE sso_sid=?`,[master]);
            assert.equal(await sessions.getSession(id),null);assert.equal(await sessions.getSessionById(id),null);
            await pool.execute(`UPDATE ${table} SET sso_sid=UPPER(sso_sid) WHERE session_id=?`,[id]);
            assert.equal(await sessions.getSession(id),null,'legacy uppercase SID must match canonical terminal state');
            assert.equal(await sessions.getSessionById(id),null);
        });
    } finally {
        try {
            if (created) { await pool.query(`DROP TABLE IF EXISTS ${stateTable}`); await pool.query(`DROP TABLE ${table}`); }
            const keys = await redis.keys('*');
            const unprefixed = keys.filter(key => key.startsWith(namespace)).map(key => key.slice(namespace.length));
            if (unprefixed.length) await redis.del(...unprefixed);
        } finally { await Promise.all([pool.end(), redis.quit()]); }
    }
});
