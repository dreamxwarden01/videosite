// OIDC relying-party helper for the DreamSSO integration.
//
// videosite is CommonJS but `jose` is ESM-only (v3+), so jose is loaded lazily
// via dynamic import() — legal inside CJS — and cached. Everything here is the
// back/front-channel plumbing the routes/auth.js flow drives:
//   beginFlow -> authorizeUrl  (front channel: browser -> SSO /authorize)
//   exchangeCode -> verifyIdToken -> userinfo  (back channel: S2S)
//   endSessionUrl  (RP-initiated logout)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSetting } = require('../services/cache/settingsCache');
const { ClientSigningKeyStore, ClientSigningKeyError, legacyState, publicJwks: projectJwks, status: keyStatus } = require('../services/clientSigningKeys');
const { s2sFetch } = require('../services/s2sFetch'); // presents the mTLS client cert when enforcement is on

// Connection config — env defaults, overlaid from site_settings (admin-editable
// in the SSO card) via loadConfig() at boot + after a connection save. KEY_FILE
// stays env (a secret file path, not a card field). INTERNAL = back-channel host
// for /token,/jwks,/userinfo (defaults to the issuer; SSO_INTERNAL overrides).
let ISSUER       = process.env.SSO_ISSUER;
let CLIENT_ID    = process.env.OIDC_CLIENT_ID || 'videosite';
let REDIRECT_URI = process.env.OIDC_REDIRECT_URI;
let INTERNAL     = process.env.SSO_INTERNAL || ISSUER;
let POST_LOGOUT  = process.env.OIDC_POST_LOGOUT_REDIRECT;

// Resolved at CALL time, not import time: a fresh install boots with no .env at
// all, and the installer writes OIDC_CLIENT_KEY_FILE into it mid-run. Capturing
// this in a const at import left the key path permanently undefined.
function keyFile() {
    return process.env.OIDC_CLIENT_KEY_FILE || path.join(__dirname, '..', '.videosite-client-key.json');
}

// jose is ESM-only — import once, lazily, and cache the module promise.
let _josePromise;
function jose() { return (_josePromise ||= import('jose')); }

// Cached client signing key (private_key_jwt) + remote JWKS resolver.
let _clientKey, _jwks;

// Overlay editable connection params from site_settings (env fallback when a
// setting is unset/blank). Resets the cached JWKS resolver in case the back-
// channel host changed. Safe before settings exist — keeps env defaults.
async function loadConfig() {
  try {
    const pick = async (key, dflt) => { const v = await getSetting(key, null); return (v != null && v !== '') ? v : dflt; };
    ISSUER    = await pick('sso_issuer',    process.env.SSO_ISSUER);
    CLIENT_ID = await pick('sso_client_id', process.env.OIDC_CLIENT_ID || 'videosite');
    // callback + post-logout are videosite's OWN endpoints — derived from the site
    // hostname (not separately configured, so they can't drift). Env is the fallback.
    const proto = await getSetting('site_protocol', 'https');
    const host = await getSetting('site_hostname', '');
    const base = host ? `${proto}://${host}` : null;
    REDIRECT_URI = base ? base + '/auth/callback' : process.env.OIDC_REDIRECT_URI;
    POST_LOGOUT  = base ? base + '/' : process.env.OIDC_POST_LOGOUT_REDIRECT;
    INTERNAL     = process.env.SSO_INTERNAL || ISSUER;
    _jwks = undefined;
  } catch { /* settings not ready (early boot) — keep env defaults */ }
}
// Key file: legacy single private JWK, or {keys:[current, previous], rotated_at}
// after a rotation. keys[0] signs; every key is published (overlap window).
function readKeyFile() {
  const raw = JSON.parse(readLegacyKeyBytes());
  return Array.isArray(raw.keys) ? raw : { keys: [raw] };
}

function readLegacyKeyBytes() {
  const fd=fs.openSync(keyFile(),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd),uid=process.getuid?.();
    if(!before.isFile()||before.nlink!==1||(before.mode&0o777)!==0o600||(uid!==undefined&&before.uid!==uid)||before.size<1||before.size>65536)throw new ClientSigningKeyError();
    const buffer=Buffer.alloc(65537);let size=0;
    while(size<buffer.length){const read=fs.readSync(fd,buffer,size,buffer.length-size,null);if(!read)break;size+=read;}
    const after=fs.fstatSync(fd);
    if(size!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new ClientSigningKeyError();
    return buffer.subarray(0,size).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function signingStore() {
  if(!process.env.DB_HOST&&!process.env.DB_NAME)return null;
  if(!process.env.DB_HOST||!process.env.DB_NAME)throw new ClientSigningKeyError();
  return new ClientSigningKeyStore(require('../config/database').getPool(),readLegacyKeyBytes);
}
async function keyView(reconcile=false,strictReconcile=true) {
  try {
    const store=signingStore();
    return store?await store.read(reconcile,strictReconcile):{state:legacyState(readLegacyKeyBytes(),Date.now()),at:Date.now(),legacy:true};
  } catch { throw new ClientSigningKeyError(); }
}

// Mint this app's OIDC client key if it doesn't exist yet. The SSO never
// receives the private half — it reads the public one from our jwks_uri — so
// there is nothing for the operator to copy, and the key must exist BEFORE they
// register us (the SSO fetch-verifies jwks_uri at registration). Idempotent.
// Previously this key came from an out-of-band script that also wrote the public
// JWK straight into the SSO's database; that can't exist for a real install.
async function ensureClientKey() {
  const file = keyFile();
  const store=signingStore();
  if(store&&await store.authoritative()){const current=await store.info();return{kid:current.kid,created:false};}
  if (fs.existsSync(file)) {
    const f = readKeyFile();
    return { kid: f.keys[0].kid || null, created: false };
  }
  const { calculateJwkThumbprint } = await jose();
  const jwk = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  jwk.kid = await calculateJwkThumbprint(jwk); // RFC 7638 (public members only)
  jwk.alg = 'EdDSA';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ keys: [jwk] }, null, 2) + '\n', { mode: 0o600 });
  _clientKey = undefined;
  return { kid: jwk.kid, created: true };
}
// Selection always consults current authority; imported CryptoKeys cache by kid.
async function clientKey() {
  const {state}=await keyView(true,false),selected=state.current;
  if(_clientKey?.kid===selected.kid)return _clientKey;
  const {importJWK}=await jose();
  const pair={kid:selected.kid,key:await importJWK(selected,'EdDSA')};_clientKey=pair;return pair;
}
async function rotateClientKey() {
  try { const store=signingStore();if(!store)throw new ClientSigningKeyError();return await store.schedule(); }
  catch { throw new ClientSigningKeyError(); }
}
async function clientKeyInfo() {
  const {state,at}=await keyView(true);return{...keyStatus(state),published:projectJwks(state,at).keys.length};
}

function hasClientKey() {
  return fs.existsSync(keyFile());
}
async function jwks() {
  if (_jwks) return _jwks;
  const { createRemoteJWKSet } = await jose();
  _jwks = createRemoteJWKSet(new URL(INTERNAL + '/jwks'));
  return _jwks;
}

// PKCE + state + nonce for one authorization request. Caller stashes these in
// the short-lived flow cookie and checks them on the callback.
function beginFlow() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state     = crypto.randomBytes(16).toString('base64url');
  const nonce     = crypto.randomBytes(16).toString('base64url');
  return { verifier, challenge, state, nonce };
}

function authorizeUrl({ challenge, state, nonce, extra = {} }) {
  const u = new URL(ISSUER + '/authorize');
  u.search = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'openid profile email', state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
    ...extra, // step-up (Phase 2) passes prompt / max_age / acr_values here
  }).toString();
  return u.toString();
}

// private_key_jwt client assertion (RFC 7523) — our credential for the SSO's
// /token and /internal/* endpoints. iss=sub=CLIENT_ID, aud=ISSUER, 60s life.
// One definition, three callers (/token, /internal/avatar, /internal/session-activity).
async function signClientAssertion() {
  const { SignJWT } = await jose();
  const {kid,key} = await clientKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuer(CLIENT_ID).setSubject(CLIENT_ID).setAudience(ISSUER)
    .setIssuedAt(now).setExpirationTime(now + 60).setJti(crypto.randomUUID())
    .sign(key);
}

// Authorization-code -> tokens, authenticating with private_key_jwt (RFC 7523).
async function exchangeCode(code, verifier) {
  const assertion = await signClientAssertion();

  const r = await s2sFetch(INTERNAL + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('token_endpoint_error'); e.detail = tok; throw e; }
  return tok; // { id_token, access_token, token_type, expires_in, ... }
}

// Verify the id_token signature + iss/aud, and bind the nonce.
async function verifyIdToken(idToken, expectedNonce) {
  const { jwtVerify } = await jose();
  const { payload } = await jwtVerify(idToken, await jwks(), { issuer: ISSUER, audience: CLIENT_ID });
  if (payload.nonce !== expectedNonce) throw new Error('nonce_mismatch');
  return payload; // sub, preferred_username, name, email, email_verified, auth_time, acr, amr, ...
}

async function userinfo(accessToken) {
  const r = await s2sFetch(INTERNAL + '/userinfo', { headers: { authorization: 'Bearer ' + accessToken } });
  return r.ok ? r.json() : null;
}

// Verify an OIDC back-channel logout token (signed by the SSO, same JWKS as the
// id_token). Throws on anything off; returns the payload (with sid/sub) on success.
async function verifyLogoutToken(token) {
  const { jwtVerify } = await jose();
  const { payload } = await jwtVerify(token, await jwks(), { issuer: ISSUER, audience: CLIENT_ID });
  const ev = payload.events && payload.events['http://schemas.openid.net/event/backchannel-logout'];
  if (!ev) throw new Error('not_a_logout_token');
  if ('nonce' in payload) throw new Error('nonce_present'); // logout tokens MUST NOT carry a nonce
  if (!payload.sid && !payload.sub) throw new Error('missing_sid_or_sub');
  return payload;
}

// RP-initiated logout. SSO discovery: end_session_endpoint = /logout.
function endSessionUrl(idTokenHint) {
  const u = new URL(ISSUER + '/logout');
  u.search = new URLSearchParams({
    post_logout_redirect_uri: POST_LOGOUT,
    client_id: CLIENT_ID,
    ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
  }).toString();
  return u.toString();
}

// --- generic back-channel event channel (videosite <-> SSO) ---

// Sign an outbound envelope: {iss=sub=client, aud=issuer, iat, exp=+120s, jti,
// events: [{id, type, payload}...]} — the RP->SSO mirror of the SSO's signed
// event envelope, using the same registered client key as private_key_jwt.
async function signEventToken(events) {
  const { SignJWT } = await jose();
  const {kid,key} = await clientKey();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ events })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'events+jwt' })
    .setIssuer(CLIENT_ID).setSubject(CLIENT_ID).setAudience(ISSUER)
    .setIssuedAt(now).setExpirationTime(now + 120).setJti(crypto.randomUUID())
    .sign(key);
}

// Verify a JWT the SSO addressed to us — its JWKS, iss = SSO, aud = us, at most
// 5 minutes old, AND of the expected media type.
//
// `typ` is not decoration: every token the SSO signs for us shares iss/aud, so
// without it an events envelope and an activity-report verdict are
// interchangeable at the verifier. Each carries different authority — a verdict
// authorises destroying a session — and they must not be substitutable for each
// other just because both are validly signed.
async function verifySsoToken(token, typ) {
  const { jwtVerify } = await jose();
  const { payload } = await jwtVerify(token, await jwks(), {
    issuer: ISSUER, audience: CLIENT_ID, clockTolerance: 10, maxTokenAge: '5 minutes', typ,
  });
  return payload;
}

// Verify an inbound envelope from the SSO (its JWKS; audience = us).
async function verifyEventToken(token) {
  if (typeof token !== 'string' || !token || token.length > 262144) throw new Error('invalid_event_token');
  return verifySsoToken(token, 'events+jwt');
}

// Signed read, with the authority version carried in response headers from the
// same SSO SQL snapshot as the unchanged access-state JSON body.
async function fetchAccessState(sub) {
  const protocol = require('./ssoRoleProtocol');
  sub = protocol.subject(sub);
  const route = '/backchannel/access-state', requestId = crypto.randomUUID();
  const { SignJWT } = await jose();
  const {kid,key} = await clientKey(), now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ method: 'GET', path: route, action: 'access-state', subjects: [sub] })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'backchannel-query+jwt' })
    .setIssuer(CLIENT_ID).setSubject(CLIENT_ID).setAudience(ISSUER.replace(/\/$/, '') + route)
    .setIssuedAt(now).setExpirationTime(now + 120).setJti(requestId).sign(key);
  const response = await s2sFetch(INTERNAL + route, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('access_state_unavailable');
  const reader = response.body?.getReader(); if (!reader) throw new Error('access_state_unavailable');
  let length = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 65536) throw new Error('access_state_unavailable'); chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body.client_id !== CLIENT_ID || body.request_id !== requestId || body.complete !== true || !Array.isArray(body.subjects)
      || body.subjects.length !== 1 || body.subjects[0].sub !== sub) throw new Error('access_state_unavailable');
  const state = body.subjects[0];
  if (!state.account || !['active','disabled','locked','deleted','not_found'].includes(state.account.status)
      || !state.rp || typeof state.rp.catalog_synced !== 'boolean' || typeof state.allowed !== 'boolean'
      || !['allowed','no_access','unmanaged','unknown_role'].includes(state.rp.access)) throw new Error('access_state_unavailable');
  const role = protocol.roleId(state.rp.role_id);
  const epoch = response.headers.get('X-DreamSSO-Authority-Epoch');
  const rev = response.headers.get('X-DreamSSO-Authority-Revision');
  const authorityVersion = protocol.version(epoch === null ? undefined : epoch, rev === null ? undefined : rev);
  return { roleId: ['unknown_role','no_access'].includes(state.rp.access) ? null : role, version: authorityVersion, accountStatus: state.account.status,
    allowed: state.allowed && state.account.status === 'active' && state.rp.catalog_synced && state.rp.access === 'allowed' && role !== null };
}

function ssoEventsUrl() { return INTERNAL + '/backchannel/events'; }
function ssoActivityUrl() { return INTERNAL + '/internal/session-activity'; }

// Fetch avatar bytes from the SSO's internal endpoint (client assertion —
// same private_key_jwt material as /token). Returns a Buffer or null.
async function fetchInternalAvatar(file) {
  const assertion = await signClientAssertion();
  const r = await s2sFetch(INTERNAL + '/internal/avatar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    }),
  });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

// Public half of the client key(s) — served at /.well-known/jwks.json so the
// SSO fetches keys (and re-fetches after a rotation) instead of pinning a
// pasted copy. The key file holds one private JWK today; a {keys:[...]} file
// (old + new during a client-key rotation) is accepted. Only public members
// are emitted.
async function publicJwks() {
  const {state,at}=await keyView();return projectJwks(state,at);
}

module.exports = { loadConfig, beginFlow, authorizeUrl, exchangeCode, verifyIdToken, userinfo, verifyLogoutToken, endSessionUrl, signEventToken, verifyEventToken, verifySsoToken, ssoEventsUrl, ssoActivityUrl, signClientAssertion, publicJwks, fetchAccessState, fetchInternalAvatar, rotateClientKey, clientKeyInfo, ensureClientKey, hasClientKey };
