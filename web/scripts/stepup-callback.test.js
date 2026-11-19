'use strict';
// Execute the actual auth router with isolated OIDC/session dependencies: no app
// boot, network, credentials, SQL or Redis. Test browser cookies across requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const USER = '00000000000040008000000000000001';
const SUB = '00000000-0000-4000-8000-000000000001';
const SID = '00000000-0000-4000-8000-000000000010';
const OTHER_SID = '00000000-0000-4000-8000-000000000020';
const TTL = 600000;
function fixture() {
    let now = 1800000000000, sequence = 0, exchanged = 0;
    const routes = new Map(), jar = { sid: 'local-original', oidc_idt: 'synthetic-hint' }, stamps = [];
    let current = { session_id: jar.sid, user_id: USER };
    let session = { session_id: jar.sid, user_id: USER, sso_sid: SID };
    let valid = true, stampResult = true, exchangeHook = async () => {}, sessionHook = async () => {};
    let claims = { sub: SUB, sid: SID, acr: 'urn:dreamsso:stepup', amr: ['otp'], auth_time: now / 1000 };
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const sessionDeps = {
        getSession: async () => { await sessionHook(); return session; }, isSessionValid: async () => valid,
        stampSessionStepup: async (...args) => { stamps.push(args); return stampResult; },
        createSession: async () => { throw new Error('stepup_must_not_create_session'); },
        deleteSessionsBySsoSid: async () => { throw new Error('stepup_must_not_rotate_session'); },
    };
    const dependencies = {
        express: { Router: () => ({ get: (name, handler) => routes.set(name, handler), post() {} }) },
        '../lib/oidc': {
            beginFlow: () => ({ verifier: 'synthetic-verifier', challenge: 'synthetic-challenge', state: 'flowstate' + (++sequence), nonce: 'synthetic-nonce' }),
            authorizeUrl: ({ extra }) => '/synthetic-authorize?stepup=' + (extra?.stepup || ''),
            exchangeCode: async (code, verifier) => { assert.equal(code, 'synthetic-code'); assert.equal(verifier, 'synthetic-verifier'); exchanged++; await exchangeHook(); return { id_token: 'synthetic-token' }; },
            verifyIdToken: async (token, nonce) => { assert.equal(token, 'synthetic-token'); assert.equal(nonce, 'synthetic-nonce'); return claims; },
        },
        '../config/session': sessionDeps,
        '../middleware/stepup': { STEPUP_METHODS: ['totp', 'passkey'], STEPUP_WINDOW_MS: TTL },
        '../middleware/auth': { SESSION_COOKIE: 'sid', getClientIp() {} },
        '../services/userService': { findOrCreateBySub: async () => { throw new Error('stepup_must_not_change_profile'); } },
    };
    const file = path.join(__dirname, '..', 'routes/auth.js'), module = { exports: {} };
    vm.runInNewContext('(function(require,module,exports){\n' + fs.readFileSync(file, 'utf8') + '\n})',
        { Date: Clock, process: { env: {} }, console: { error() {}, warn() {} } }, { filename: file })(
        name => { assert.ok(Object.hasOwn(dependencies, name), 'unexpected dependency ' + name); return dependencies[name]; }, module, module.exports);
    async function request(route, query) {
        const cookies = { ...jar }, changed = [], cleared = [];
        const res = { locals: { user: current }, redirect(value) { this.location = value; return this; },
            cookie(name, value, options) { jar[name] = value; changed.push([name, options]); },
            clearCookie(name) { delete jar[name]; cleared.push(name); } };
        await routes.get(route)({ query, cookies, headers: { host: 'synthetic.invalid' } }, res);
        return { ...res, changed, cleared };
    }
    return {
        jar, stamps, get exchanged() { return exchanged; }, get current() { return current; },
        get session() { return session; }, get claims() { return claims; }, get now() { return now; },
        setCurrent(value) { current = value; }, setSession(value) { session = value; }, setValid(value) { valid = value; },
        setStampResult(value) { stampResult = value; }, advance(ms) { now += ms; },
        exchangeHook(value) { exchangeHook = value; }, sessionHook(value) { sessionHook = value; },
        async start(required = 'totp,passkey') {
            const res = await request('/auth/stepup/start', { returnTo: '/editor?draft=kept', required });
            const name = res.changed.find(([name]) => name.startsWith('oidc_flow_'))?.[0];
            return { res, name, flow: name ? JSON.parse(jar[name]) : null };
        },
        rewriteFlow(started, patch) { Object.assign(started.flow, patch); jar[started.name] = JSON.stringify(started.flow); },
        callback(started) { return request('/auth/callback', { state: started.flow.state, code: 'synthetic-code' }); },
        request,
    };
}

test('fresh step-up binds local session, original master SID and actual proof time', async () => {
    const f = fixture(), s = await f.start();
    assert.equal(s.flow.sessionId, 'local-original'); assert.equal(s.flow.subjectId, USER); assert.equal(s.flow.ssoSid, SID);
    assert.equal(s.flow.startedAt, f.now); assert.equal(s.res.changed[0][1].maxAge, TTL);
    f.advance(45000);
    const r = await f.callback(s);
    assert.equal(r.location, '/editor?draft=kept&stepup=done');
    assert.equal(f.stamps.length, 1); assert.equal(f.stamps[0][0], 'local-original'); assert.equal(f.stamps[0][1], 'totp');
    assert.equal(f.stamps[0][2].authenticatedAt.getTime(), (f.now - 45000));
    assert.equal(f.stamps[0][2].ssoSid, SID); assert.equal(f.stamps[0][2].userId, USER);
    assert.equal(f.jar.sid, 'local-original'); assert.equal(f.jar.oidc_idt, 'synthetic-hint');
    assert.equal(r.changed.length, 0); assert.deepEqual(r.cleared, [s.name]);
});

for (const [name, change] of [
    ['same user local replacement', f => { f.jar.sid = 'local-replacement'; f.setCurrent({ ...f.current, session_id: f.jar.sid }); }],
    ['browser cookie replaced', f => { f.jar.sid = 'local-replacement'; }],
    ['logout', f => f.setCurrent(null)],
    ['old in-flight flow has no binding', (f, s) => f.rewriteFlow(s, { sessionId: null })],
    ['current user changed', f => f.setCurrent({ ...f.current, user_id: '00000000000040008000000000000002' })],
]) {
    test(name + ' never exchanges or stamps the old flow', async () => {
        const f = fixture(), s = await f.start(); change(f, s); const r = await f.callback(s);
        assert.match(r.location, /stepup=failed$/); assert.equal(f.exchanged, 0); assert.equal(f.stamps.length, 0);
    });
}

for (const [name, change] of [
    ['returned SID differs', f => { f.claims.sid = OTHER_SID; }],
    ['returned SID missing', f => { delete f.claims.sid; }],
    ['returned SID malformed', f => { f.claims.sid = 'not-a-session'; }],
    ['returned subject differs', f => { f.claims.sub = OTHER_SID; }],
    ['original SQL session rebound', f => { f.session.sso_sid = OTHER_SID; }],
    ['original SQL session deleted or terminally revoked during exchange', f => f.exchangeHook(async () => f.setSession(null))],
    ['original session expired', f => f.setValid(false)],
    ['not a step-up ACR', f => { f.claims.acr = 'urn:dreamsso:2fa'; }],
    ['unaccepted factor', f => { f.claims.amr = ['email']; }],
    ['missing factor', f => { delete f.claims.amr; }],
    ['old auth_time before flow', f => { f.claims.auth_time -= 31; }],
    ['future auth_time', f => { f.claims.auth_time += 31; }],
    ['missing auth_time', f => { delete f.claims.auth_time; }],
    ['nonfinite auth_time', f => { f.claims.auth_time = Infinity; }],
    ['string auth_time', f => { f.claims.auth_time = String(f.claims.auth_time); }],
    ['fractional auth_time', f => { f.claims.auth_time += 0.1; }],
    ['flow reaches actual cookie TTL', f => f.advance(TTL)],
    ['flow expires during exchange', f => f.exchangeHook(async () => f.advance(TTL))],
    ['flow expires during final session read', f => f.sessionHook(async () => f.advance(TTL))],
    ['future flow start', (f, s) => f.rewriteFlow(s, { startedAt: f.now + 31000 })],
    ['missing flow start', (f, s) => f.rewriteFlow(s, { startedAt: null })],
]) {
    test(name + ' cannot stamp', async () => {
        const f = fixture(), s = await f.start(); change(f, s); const r = await f.callback(s);
        assert.match(r.location, /stepup=(account|failed)$/); assert.equal(f.stamps.length, 0);
    });
}

test('small issuer skew is clamped to local now, and passkey-only request is enforced', async () => {
    const f = fixture(), s = await f.start('passkey'); f.claims.auth_time += 30; f.claims.amr = ['passkey'];
    assert.match((await f.callback(s)).location, /stepup=done$/);
    assert.equal(f.stamps[0][2].authenticatedAt.getTime(), f.now);
    const g = fixture(), t = await g.start('passkey');
    assert.match((await g.callback(t)).location, /stepup=failed$/); assert.equal(g.stamps.length, 0);
});

test('uppercase master SID is compared canonically', async () => {
    const f = fixture(); f.session.sso_sid = SID.toUpperCase(); const s = await f.start(); f.claims.sid = SID.toUpperCase();
    assert.match((await f.callback(s)).location, /stepup=done$/);
});

test('lost SQL stamp race cannot report done', async () => {
    const f = fixture(), s = await f.start(); f.setStampResult(false);
    assert.match((await f.callback(s)).location, /stepup=failed$/);
});

test('separate concurrent flows keep their cookies and draft destinations', async () => {
    const f = fixture(), first = await f.start(), second = await f.start();
    assert.notEqual(first.name, second.name);
    assert.match((await f.callback(second)).location, /draft=kept&stepup=done$/);
    assert.ok(f.jar[first.name]); assert.equal(f.jar[second.name], undefined);
    assert.match((await f.callback(first)).location, /draft=kept&stepup=done$/);
    assert.equal(f.stamps.length, 2); assert.equal(f.jar.sid, 'local-original');
});

test('missing original SSO binding cannot start an unbound flow', async () => {
    const f = fixture(); f.session.sso_sid = null; const s = await f.start();
    assert.equal(s.flow, null); assert.match(s.res.location, /stepup=failed$/);
});
