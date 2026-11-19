'use strict';
// Deterministic in-memory fixtures around the actual session/cache/auth modules.
// No app startup, environment loading, network or external SQL/Redis dependency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function load(relative, dependencies, globals = {}) {
    const file = path.join(__dirname, '..', relative), module = { exports: {} };
    const requireFixture = name => {
        if (!Object.hasOwn(dependencies, name)) throw new Error('unexpected_import:' + name);
        return dependencies[name];
    };
    vm.runInNewContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})',
        { Buffer, Date, AbortSignal, URLSearchParams, console: { log() {}, warn() {}, error() {} }, ...globals },
        { filename: file })(requireFixture, module, module.exports);
    return module.exports;
}
function barrier() {
    let entered, release;
    return { entered: new Promise(resolve => { entered = resolve; }),
        released: new Promise(resolve => { release = resolve; }), arrive: () => entered(), release: () => release() };
}
function redisFixture() {
    const hashes = new Map(), sets = new Map(), values = new Map();
    const redis = {
        hashes, sets,
        async hgetall(key) { return { ...(hashes.get(key) || {}) }; },
        async smembers(key) { return [...(sets.get(key) || [])]; },
        async set(key, value, ...options) {
            if (options.includes('NX') && values.has(key)) return null;
            values.set(key, value); return 'OK';
        },
        async del(key) { hashes.delete(key); sets.delete(key); return Number(values.delete(key)); },
        multi() {
            const operations = [], tx = {};
            for (const name of ['hset', 'expire', 'sadd', 'srem', 'del', 'hgetall']) {
                tx[name] = (...args) => { operations.push([name, args]); return tx; };
            }
            tx.exec = async () => operations.map(([name, [key, value]]) => {
                let result = 1;
                if (name === 'hset') hashes.set(key, { ...(hashes.get(key) || {}), ...value });
                if (name === 'sadd') { const members = sets.get(key) || new Set(); members.add(value); sets.set(key, members); }
                if (name === 'srem') sets.get(key)?.delete(value);
                if (name === 'del') { hashes.delete(key); sets.delete(key); values.delete(key); }
                if (name === 'hgetall') result = { ...(hashes.get(key) || {}) };
                return [null, result];
            });
            return tx;
        },
    };
    return redis;
}
function fixture() {
    const now = Date.now(), redis = redisFixture(), rows = new Map(), states = new Map();
    const uid = '00000000000000000000000000000001', sid = 'synthetic-local-session', ssoSid = '00000000-0000-4000-8000-000000000010';
    const row = { session_id: sid, user_id: uid, last_seen: new Date(now), last_sign_in: new Date(now),
        ip_address: '127.0.0.1', user_agent: 'fixture', sso_sid: ssoSid, sso_expires_at: new Date(now + 3600000),
        sso_role_generation: '0', stepup_at: null, stepup_method: null };
    rows.set(sid, row);
    let settingsBarrier, deletionBarrier, stepupLockBarrier, sqlFailure = false, membershipReads = 0, clockOffset = 0;
    const sessionClock = new Proxy(Date, { get(target, key) { return key === 'now' ? () => now + clockOffset : Reflect.get(target, key); } });
    const sameUser = (value, id) => value === (Buffer.isBuffer(id) ? id.toString('hex') : id);
    const pool = { async execute(input, args) {
        const sql = input.replace(/\s+/g, ' ').trim();
        if (sqlFailure) throw new Error('synthetic_sql_unavailable');
        if (sql.startsWith('SELECT session_id, user_id, last_seen,')) {
            membershipReads++; const row = rows.get(args[0]), state = row && states.get(row.sso_sid);
            return [row ? [{ ...row, sso_revoked: !!state && (state.revoked || state.subject_id !== row.user_id) }] : []];
        }
        if (sql === 'SELECT session_id, user_id FROM sessions WHERE sso_sid = ?' || sql === 'SELECT session_id,user_id FROM sessions WHERE sso_sid=? FOR UPDATE') {
            return [[...rows.values()].filter(r => r.sso_sid === args[0]).map(r => ({ session_id: r.session_id, user_id: r.user_id }))];
        }
        if (sql.startsWith('SELECT session_id, user_id FROM sessions WHERE session_id = ?')) {
            membershipReads++; const r = rows.get(args[0]), state = r && states.get(r.sso_sid);
            return [r && !state?.revoked ? [{ session_id: r.session_id, user_id: r.user_id }] : []];
        }
        if (sql === 'SELECT user_id FROM sessions WHERE session_id = ?') {
            const r = rows.get(args[0]); return [r ? [{ user_id: r.user_id }] : []];
        }
        if (sql.startsWith('DELETE FROM sessions WHERE')) {
            if (deletionBarrier) { const gate = deletionBarrier; deletionBarrier = null; gate.arrive(); await gate.released; }
            for (const [id, r] of rows) {
                const matches = sql.includes('WHERE sso_sid') ? r.sso_sid === args[0]
                    : sql.includes('WHERE user_id') ? sameUser(r.user_id, args[0]) && (!sql.includes('session_id !=') || id !== args[1])
                        : id === args[0];
                if (matches) rows.delete(id);
            }
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO sso_session_state')) {
            if (!states.has(args[0])) states.set(args[0], { subject_id: args[1].toString('hex'), revoked: 0 });
            return [{ affectedRows: 1 }];
        }
        if (sql === 'SELECT subject_id,revoked FROM sso_session_state WHERE sso_sid=? FOR UPDATE') {
            if (stepupLockBarrier) { const gate = stepupLockBarrier; stepupLockBarrier = null; gate.arrive(); await gate.released; }
            return [[{ ...states.get(args[0]) }]];
        }
        if (sql === 'UPDATE sso_session_state SET revoked=1 WHERE sso_sid=?') { states.get(args[0]).revoked = 1; return [{ affectedRows: 1 }]; }
        if (sql.startsWith('INSERT INTO sessions ')) {
            const [id, user, seen, signIn, agent, ip, sso, expires, generation] = args;
            rows.set(id, { session_id: id, user_id: user.toString('hex'), last_seen: seen, last_sign_in: signIn,
                user_agent: agent, ip_address: ip, sso_sid: sso, sso_expires_at: expires,
                sso_role_generation: String(generation), stepup_at: null, stepup_method: null });
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE sessions SET stepup_at = ?, stepup_method = ?')) {
            const [at, method, id, user, sso] = args, r = rows.get(id);
            const matched = r && sameUser(r.user_id, user) && r.sso_sid === sso;
            if (matched) { r.stepup_at = at; r.stepup_method = method; }
            return [{ affectedRows: matched ? 1 : 0 }];
        }
        if (sql === 'SELECT stepup_at, stepup_method FROM sessions WHERE session_id = ?') {
            const r = rows.get(args[0]); return [r ? [{ stepup_at: r.stepup_at, stepup_method: r.stepup_method }] : []];
        }
        throw new Error('unexpected_sql:' + sql);
    } };
    const settings = { async getSetting(key, fallback) {
        if (settingsBarrier) { const gate = settingsBarrier; settingsBarrier = null; gate.arrive(); await gate.released; }
        return ({ session_inactivity_days: '1', session_max_days: '3' })[key] ?? fallback;
    } };
    Object.assign(pool, { getConnection: async () => pool, query: async () => [], beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} });
    const protocol = load('lib/ssoRoleProtocol.js', { 'node:crypto': crypto });
    const catalog = load('services/ssoCatalogStore.js', { 'node:crypto': crypto, '../lib/ssoRoleProtocol': protocol });
    const cache = load('services/cache/sessionCache.js', { '../redis': { getClient: () => redis } });
    const reloadSessions = () => load('config/session.js', { crypto, './database': { getPool: () => pool, idBuf: id => Buffer.from(id, 'hex') },
        '../services/cache/sessionCache': cache, '../services/cache/settingsCache': settings, '../services/ssoCatalogStore': catalog }, { Date: sessionClock });
    const sessions = reloadSessions();
    const authority = { subject_id: '00000000-0000-4000-8000-000000000001', role_id: 2, blocked: 0, effects_pending: 0, session_generation: '0' };
    const auth = load('middleware/auth.js', {
        '../config/session': sessions,
        '../services/permissionService': { resolveAuthBundle: async () => ({ role_id: 2, permission_level: 10, permissions: { fixtureRead: true } }) },
        '../services/cache/userCache': { getUserMeta: async () => ({ role_id: 2, username: 'fixture', display_name: 'Fixture' }) },
        '../services/ssoRoleAuthority': { service: () => ({ sessionState: async () => authority, completeEffects: async () => {} }) },
        '../lib/ssoRoleProtocol': protocol, '../services/ssoActivity': { reportActivity: async () => {} },
        '../services/userService': { invalidateUserCaches: async () => {} },
    });
    return { now, uid, sid, ssoSid, row, rows, states, redis, cache, sessions, authority, reloadSessions,
        settingsGate() { settingsBarrier = barrier(); return settingsBarrier; },
        deletionGate() { deletionBarrier = barrier(); return deletionBarrier; },
        stepupLockGate() { stepupLockBarrier = barrier(); return stepupLockBarrier; },
        advanceClock(ms) { clockOffset += ms; },
        failSql() { sqlFailure = true; }, membershipReads: () => membershipReads,
        async seedCache(id = sid, data = row) {
            await cache.createSession(id, { userId: data.user_id, lastSignIn: data.last_sign_in, lastSeen: data.last_seen,
                ipAddress: data.ip_address, userAgent: data.user_agent, ssoExpiresAt: data.sso_expires_at,
                ssoSid: data.sso_sid, roleGeneration: data.sso_role_generation }, 3600);
        },
        async authorize(id = sid) {
            const res = { locals: {}, clearCookie() {}, status(code) { this.statusCode = code; return this; }, json() { return this; } };
            const req = { cookies: { sid: id }, headers: {}, socket: { remoteAddress: '127.0.0.1' }, originalUrl: '/api/fixture' };
            await auth.loadUser(req, res, () => {});
            let admitted = false; auth.requireAuth(req, res, () => { admitted = true; });
            return { admitted, user: res.locals.user, status: res.statusCode || 200 };
        },
    };
}
const deletions = {
    sid: f => f.sessions.deleteSessionsBySsoSid(f.ssoSid),
    id: f => f.sessions.deleteSession(f.sid),
    user: f => f.sessions.deleteUserSessions(f.uid),
};

for (const [kind, revoke] of Object.entries(deletions)) {
    test(kind + ' deletion cannot make a late SQL-to-cache refill authenticate a later request', async () => {
        const f = fixture(), gate = f.settingsGate();
        const oldRead = f.sessions.getSession(f.sid); await gate.entered;
        await revoke(f); assert.equal(f.rows.size, 0);
        gate.release(); await oldRead;
        assert.ok(await f.cache.getSession(f.sid), 'fixture must actually produce the late orphan');
        assert.equal(await f.sessions.getSessionById(f.sid), null);
        const next = await f.authorize(); assert.equal(next.admitted, false); assert.equal(next.status, 401);
        assert.equal(await f.cache.getSession(f.sid), null);
    });
    test(kind + ' deletion-created cache miss cannot resurrect authentication from a previously warm cache', async () => {
        const f = fixture(); await f.seedCache();
        const deletion = f.deletionGate(), pendingDelete = revoke(f); await deletion.entered;
        assert.equal(await f.cache.getSession(f.sid), null);
        assert.ok(f.rows.has(f.sid), 'SQL is still present between deletion stores');
        const refill = f.settingsGate(), oldRead = f.sessions.getSession(f.sid); await refill.entered;
        deletion.release(); await pendingDelete;
        refill.release(); await oldRead;
        assert.ok(await f.cache.getSession(f.sid));
        assert.equal((await f.authorize()).admitted, false);
    });
}
test('existing SQL-less cache is rejected even when its user, expiry and role generation are otherwise valid', async () => {
    const f = fixture(); await f.seedCache(); f.rows.clear();
    assert.equal(await f.sessions.getSessionById(f.sid), null);
    assert.equal((await f.authorize()).admitted, false);
    assert.equal(await f.cache.getSession(f.sid), null);
});
test('every warm-cache read consults SQL and returns SQL authentication fields with live cached activity', async () => {
    const f = fixture(); await f.seedCache();
    const hash = f.redis.hashes.get('session:user:' + f.sid);
    hash.last_seen = String(f.now + 1000); hash.last_sign_in = String(f.now + 999999);
    hash.sso_expires_at = String(f.now + 99999999);
    const session = await f.sessions.getSession(f.sid);
    assert.equal(session.last_seen, f.now + 1000);
    assert.equal(session.last_sign_in, f.row.last_sign_in.getTime());
    assert.equal(session.sso_expires_at, f.row.sso_expires_at.getTime());
    await f.sessions.getSession(f.sid); assert.equal(f.membershipReads(), 2);
});
test('cached user, SSO sid and generation mismatches cannot replace SQL authority or activity', async () => {
    for (const [field, value] of [['user_id', '00000000000000000000000000000002'], ['sso_sid', 'wrong-sso'], ['sso_role_generation', '900']]) {
        const f = fixture(); await f.seedCache();
        const hash = f.redis.hashes.get('session:user:' + f.sid); hash[field] = value; hash.last_seen = String(f.now + 99999);
        const session = await f.sessions.getSession(f.sid);
        assert.equal(session.user_id, f.uid); assert.equal(session.sso_sid, f.ssoSid);
        assert.equal(session.sso_role_generation, '0'); assert.equal(session.last_seen, f.now);
    }
});
test('SQL outage fails closed despite a warm valid session cache', async () => {
    const f = fixture(); await f.seedCache(); f.failSql();
    await assert.rejects(f.sessions.getSession(f.sid), /synthetic_sql_unavailable/);
    await assert.rejects(f.sessions.getSessionById(f.sid), /synthetic_sql_unavailable/);
    assert.equal((await f.authorize()).admitted, false);
});
test('normal login replacement creates a fresh SQL session under the same valid SSO sid', async () => {
    const f = fixture(); await f.seedCache();
    await f.sessions.deleteSessionsBySsoSid(f.ssoSid);
    const replacement = await f.sessions.createSession(f.uid, 'fixture', '127.0.0.1', f.ssoSid, new Date(f.now + 3600000), '0');
    assert.notEqual(replacement, f.sid); assert.equal((await f.authorize(replacement)).admitted, true);
    assert.equal((await f.authorize(f.sid)).admitted, false);
    assert.equal((await f.sessions.getSession(replacement)).sso_sid, f.ssoSid);
});
test('role effects and revocation generation remain independent request gates', async () => {
    const f = fixture(); await f.seedCache();
    f.authority.effects_pending = 1; assert.equal((await f.authorize()).admitted, false);
    f.authority.effects_pending = 0; f.authority.session_generation = '1';
    assert.equal((await f.authorize()).admitted, false);
});
test('SQL absolute/SSO expiry and SQL step-up stamps retain authority over cached values', async () => {
    const f = fixture(); f.row.last_sign_in = new Date(f.now - 4 * 86400000); await f.seedCache();
    f.redis.hashes.get('session:user:' + f.sid).last_sign_in = String(f.now);
    assert.equal(await f.sessions.isSessionValid(await f.sessions.getSession(f.sid)), false);
    f.row.last_sign_in = new Date(f.now); f.row.sso_expires_at = new Date(f.now - 1000);
    f.redis.hashes.get('session:user:' + f.sid).sso_expires_at = String(f.now + 999999);
    assert.equal(await f.sessions.isSessionValid(await f.sessions.getSession(f.sid)), false);
    f.row.stepup_at = new Date(f.now - 1000); f.row.stepup_method = 'passkey';
    const proof = await f.sessions.getSessionStepup(f.sid);
    assert.equal(proof.stepupAt, f.now - 1000); assert.equal(proof.method, 'passkey');
    f.rows.clear(); assert.equal(await f.sessions.getSessionStepup(f.sid), null);
});
test('live cached activity still prevents stale SQL flush timestamps from expiring an active session', async () => {
    const f = fixture(); f.row.last_seen = new Date(f.now - 2 * 86400000); await f.seedCache();
    f.redis.hashes.get('session:user:' + f.sid).last_seen = String(f.now);
    assert.equal(await f.sessions.isSessionValid(await f.sessions.getSession(f.sid)), true);
    f.redis.hashes.clear(); assert.equal(await f.sessions.isSessionValid(await f.sessions.getSession(f.sid)), false);
});

test('terminal SID logout blocks a late callback and survives a fresh module instance without blocking normal replacement', async () => {
    const f = fixture(), subject = f.uid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    await f.seedCache();
    await f.sessions.revokeSessionsBySsoSid(f.ssoSid, subject);
    const restarted = f.reloadSessions();
    await assert.rejects(restarted.createSession(f.uid, 'fixture', null, f.ssoSid, new Date(f.now + 3600000)), /sso_session_revoked/);
    assert.equal(await restarted.getSession(f.sid), null);
    // A different live SSO session still supports ordinary local replacement.
    const live = '00000000-0000-4000-8000-000000000020';
    const first = await restarted.createSession(f.uid, null, null, live);
    await restarted.deleteSessionsBySsoSid(live);
    const replacement = await restarted.createSession(f.uid, null, null, live);
    assert.notEqual(first, replacement); assert.ok(await restarted.getSession(replacement));
});
test('callback insertion before terminal logout is deleted, and a retained SQL/cache row is denied by terminal state', async () => {
    const f = fixture(), subject = f.uid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    const inserted = await f.sessions.createSession(f.uid, null, null, f.ssoSid);
    await f.sessions.revokeSessionsBySsoSid(f.ssoSid, subject);
    assert.equal(await f.sessions.getSession(inserted), null);
    f.rows.set(f.sid, f.row); await f.seedCache();
    assert.equal(await f.sessions.getSession(f.sid), null);
    assert.equal(await f.sessions.getSessionById(f.sid), null);
});
test('a signed logout subject cannot revoke a SID already bound to a different subject', async () => {
    const f = fixture(); await f.sessions.createSession(f.uid, null, null, f.ssoSid);
    await assert.rejects(f.sessions.revokeSessionsBySsoSid(f.ssoSid, '00000000-0000-4000-8000-000000000099'), /sso_session_binding_mismatch/);
    assert.equal(f.states.get(f.ssoSid).revoked, 0);
});

// Actual stamp helper shares the existing terminal-session lock, and its SQL
// update predicates cannot move proof onto a different local/SSO session.
function stepupBinding(f) {
    return { userId: f.uid, ssoSid: f.ssoSid, authenticatedAt: new Date(f.now - 5000), expiresAt: f.now + 600000 };
}
test('bound step-up stamps the verified factor time on only the original row', async () => {
    const f = fixture(), binding = stepupBinding(f);
    assert.equal(await f.sessions.stampSessionStepup(f.sid, 'passkey', binding), true);
    assert.equal(f.row.stepup_at.getTime(), binding.authenticatedAt.getTime());
    assert.equal(f.row.stepup_method, 'passkey');
    assert.equal(f.states.get(f.ssoSid).revoked, 0);
});
test('bound step-up cannot stamp a deleted original or its same-user replacement', async () => {
    const f = fixture();
    await f.sessions.deleteSessionsBySsoSid(f.ssoSid);
    const replacement = await f.sessions.createSession(f.uid, null, null, f.ssoSid);
    assert.equal(await f.sessions.stampSessionStepup(f.sid, 'passkey', stepupBinding(f)), false);
    assert.equal(f.rows.get(replacement).stepup_at, null);
});
test('bound step-up cannot stamp a row rebound to another master or subject', async () => {
    const f = fixture(); f.row.sso_sid = '00000000-0000-4000-8000-000000000020';
    assert.equal(await f.sessions.stampSessionStepup(f.sid, 'passkey', stepupBinding(f)), false);
    f.row.sso_sid = f.ssoSid; f.row.user_id = '00000000000000000000000000000002';
    assert.equal(await f.sessions.stampSessionStepup(f.sid, 'passkey', stepupBinding(f)), false);
    assert.equal(f.row.stepup_at, null);
});
test('terminal state blocks bound stamp even if a SQL row is retained', async () => {
    const f = fixture(); f.states.set(f.ssoSid, { subject_id: f.uid, revoked: 1 });
    assert.equal(await f.reloadSessions().stampSessionStepup(f.sid, 'passkey', stepupBinding(f)), false);
    assert.equal(f.row.stepup_at, null);
});
test('original master subject mismatch rejects bound stamp', async () => {
    const f = fixture(); f.states.set(f.ssoSid, { subject_id: '00000000000000000000000000000002', revoked: 0 });
    await assert.rejects(f.sessions.stampSessionStepup(f.sid, 'passkey', stepupBinding(f)), /sso_session_binding_mismatch/);
    assert.equal(f.row.stepup_at, null);
});
test('expired flow cannot stamp after waiting for the terminal-state lock', async () => {
    const f = fixture(), binding = stepupBinding(f), gate = f.stepupLockGate();
    const pending = f.sessions.stampSessionStepup(f.sid, 'passkey', binding);
    await gate.entered; f.advanceClock(600000); gate.release();
    assert.equal(await pending, false);
    assert.equal(f.row.stepup_at, null);
});
