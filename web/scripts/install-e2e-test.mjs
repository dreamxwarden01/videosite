// End-to-end test for videosite's first-run installer.
//
// Boots a REAL, uninstalled videosite against a THROWAWAY MariaDB container and
// a scratch Redis db, then drives the installer the way the browser will:
//   gate/lock -> infrastructure -> site -> SSO (mints our client key) -> mTLS
//   -> connect (BLOCKED while unregistered) -> register at the SSO -> verify
//   -> finish -> the site is live and /install is gone.
//
// The interesting assertions are the ones about the gate: every distinct failure
// reason the SSO can give us, and the fact that finish CANNOT be reached until a
// real 204 comes back.
//
// Requires: Docker, Redis on 127.0.0.1:6379, and the dev SSO up at SSO_ISSUER
// with its Postgres reachable (that is how we play "the operator adds the client
// in the SSO admin").
//
// Run:  node scripts/install-e2e-test.mjs        (from videosite-local)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import pg from 'pg';
import dbBaseline from '../lib/dbBaseline.js';

const { checkDbBaseline, readMigrationIds } = dbBaseline;

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PORT = 3399;
const DB_CONTAINER = 'videosite-install-e2e-db';
const REDIS_DB = '9'; // scratch — never the dev db 0
const CLIENT_ID = 'videosite-e2e';
const SITE_NAME = 'Acme Media E2E';
const SSO_ISSUER = process.env.SSO_ISSUER_TEST || 'https://sso-dev.dreamxwarden.ca';

// Registering the client is normally the operator clicking around the SSO admin.
// The test does it straight in the SSO's database — same end state, no UI driving.
function ssoDatabaseUrl() {
  if (process.env.SSO_DATABASE_URL) return process.env.SSO_DATABASE_URL;
  const envPath = path.resolve(ROOT, '..', '.env'); // the dreamsso repo root
  const m = fs.readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error('no DATABASE_URL in ' + envPath);
  return m[1].trim().replace(/^"|"$/g, '');
}
const SSO_PG = ssoDatabaseUrl();

let pass = 0;
let fail = 0;
const check = (n, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.error('  ✗ ' + n, detail !== undefined ? JSON.stringify(detail) : ''); }
};

let cookie = '';
async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(90_000), // the infra step applies a schema + 25 migrations
  });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('install_token=')) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-install-'));
let child = null;
const sso = new pg.Pool({ connectionString: SSO_PG });

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function startDb() {
  try { sh('docker', ['rm', '-f', DB_CONTAINER]); } catch { /* not running */ }
  sh('docker', ['run', '-d', '--rm', '--name', DB_CONTAINER,
    '-e', 'MARIADB_ROOT_PASSWORD=e2eroot',
    '-p', `${DB_PORT}:3306`, 'mariadb:11']);
  // Wait for it to accept connections.
  for (let i = 0; i < 60; i++) {
    try {
      const c = await mysql.createConnection({ host: '127.0.0.1', port: DB_PORT, user: 'root', password: 'e2eroot' });
      await c.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('throwaway MariaDB never came up');
}

// Boot videosite with an EMPTY DB_HOST so it can't consider itself installed —
// dotenv will not overwrite a key that is already present in process.env, so
// this beats the real .env sitting next to server.js.
function boot() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'development',
        DB_HOST: '', DB_NAME: '', DB_USER: '', DB_PASSWORD: '',
        REDIS_HOST: '', SSO_ISSUER: '', OIDC_CLIENT_ID: '',
        INSTALL_ENV_FILE: path.join(tmp, '.env'),
        INSTALL_TOKEN_FILE: path.join(tmp, '.install-token'),
        OIDC_CLIENT_KEY_FILE: path.join(tmp, 'client-key.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // node re-execs nothing, but keep the group killable
    });
    let out = '';
    const t = setTimeout(() => reject(new Error('boot timeout: ' + out)), 30_000);
    const scan = (d) => {
      out += d;
      const m = out.match(/\/install\?token=(\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited (${c}): ` + out)); });
  });
}

// The installer really does a HeadBucket, so the test needs credentials that work.
// Default to the dev .env's — HeadBucket is a read-only existence check, it writes
// nothing. Override with E2E_R2_* to point somewhere else.
function devEnv(key) {
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  } catch {
    return '';
  }
}

const INFRA = {
  dbHost: '127.0.0.1', dbPort: String(DB_PORT), dbUser: 'root', dbPassword: 'e2eroot', dbName: 'videosite_e2e',
  redisHost: '127.0.0.1', redisPort: '6379', redisPassword: '', redisDb: REDIS_DB,
  r2Endpoint: process.env.E2E_R2_ENDPOINT || devEnv('R2_ENDPOINT'),
  r2BucketName: process.env.E2E_R2_BUCKET || devEnv('R2_BUCKET_NAME'),
  r2AccessKeyId: process.env.E2E_R2_KEY || devEnv('R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: process.env.E2E_R2_SECRET || devEnv('R2_SECRET_ACCESS_KEY'),
  r2PublicDomain: 'media.example.com',
};

try {
  console.log('videosite install e2e — workdir ' + tmp + '\n');
  if (!INFRA.r2Endpoint) {
    console.error('No R2 credentials (neither E2E_R2_* nor the dev .env). The installer really calls');
    console.error('HeadBucket, so the infrastructure step cannot pass without them.');
    process.exit(1);
  }

  console.log('spinning up a throwaway MariaDB…');
  // ---- db baseline (static) ----
  // Fail fast and legibly: drift between schema.sql and seed.sql surfaces downstream as
  // a duplicate-column error mid-install, or as nothing at all. scripts/db-baseline-test.js
  // proves the guard itself catches each way of breaking it.
  const baseline = checkDbBaseline();
  check('db baseline: schema.sql, seed.sql and migrations.js agree', baseline.ok, baseline.errors);

  await startDb();

  // ---- boot uninstalled ----
  const token = await boot();
  check('boots uninstalled, logs an install token', !!token);
  check('.install-token written 0600', (fs.statSync(path.join(tmp, '.install-token')).mode & 0o777) === 0o600);

  // ---- the gate ----
  check('GET / -> neutral 503 (does NOT redirect to /install)', (await req('GET', '/')).status === 503);
  const root = await req('GET', '/');
  check('  and the 503 never names the installer', !/install/i.test(root.text));
  check('GET /api/courses -> 503', (await req('GET', '/api/courses')).status === 503);
  check('GET /install without a token -> the SAME 503', (await req('GET', '/install')).status === 503);
  check('GET /install?token=wrong -> 503', (await req('GET', '/install?token=nope')).status === 503);
  check('POST /api/install/infra without a token -> 503', (await req('POST', '/api/install/infra', {})).status === 503);
  check('GET /.well-known/jwks.json -> not gated (the SSO must read it mid-install)',
    (await req('GET', '/.well-known/jwks.json')).status !== 503);

  const page = await req('GET', `/install?token=${token}`);
  check('GET /install?token=REAL -> the installer', page.status === 200);
  check('  and drops the install_token cookie', cookie.startsWith('install_token='));

  // ---- step 1: infrastructure ----
  const badInfra = await req('POST', '/api/install/infra', { ...INFRA, dbHost: '', dbName: '' });
  check('infra: missing fields -> 422 with per-field errors',
    badInfra.status === 422 && !!badInfra.json.errors.dbHost && !!badInfra.json.errors.dbName, badInfra.json);

  const badPw = await req('POST', '/api/install/infra', { ...INFRA, dbPassword: 'wrong' });
  check('infra: wrong DB password -> 422 on the password field',
    badPw.status === 422 && /Could not connect/.test(badPw.json.errors.dbPassword || ''), badPw.json);
  check('  nothing written yet', !fs.existsSync(path.join(tmp, '.env')));

  const badBucket = await req('POST', '/api/install/infra', { ...INFRA, r2BucketName: 'no-such-bucket-e2e-xyz' });
  check('infra: unreachable bucket -> 422 (the R2 probe really runs)',
    badBucket.status === 422 && !!badBucket.json.errors.r2BucketName, badBucket.json);

  const infra = await req('POST', '/api/install/infra', INFRA);
  check('infra: valid -> 200', infra.status === 200, infra.json);

  const envText = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
  check('.env written 0600', (fs.statSync(path.join(tmp, '.env')).mode & 0o777) === 0o600);
  check('.env carries SETTINGS_SECRET_ENCRYPTION_KEY (the old installer never wrote it)',
    /^SETTINGS_SECRET_ENCRYPTION_KEY=[0-9a-f]{64}$/m.test(envText));
  check('.env carries no Turnstile keys', !/TURNSTILE/.test(envText));

  const db = await mysql.createConnection({
    host: '127.0.0.1', port: DB_PORT, user: 'root', password: 'e2eroot', database: 'videosite_e2e',
  });
  // The live half of the drift guard. schema.sql lays down the baseline and the
  // installer runs everything after it, so the finished database must record EXACTLY
  // the migrations db/migrations.js defines — no phantom id seeded that never ran, and
  // none of the post-baseline ones skipped.
  const [migRows] = await db.query('SELECT migration_id FROM schema_migrations');
  const recorded = migRows.map((r) => r.migration_id).sort();
  const defined = [...readMigrationIds()].sort();
  check('installed DB records exactly the migrations migrations.js defines',
    recorded.length === defined.length && recorded.every((id, i) => id === defined[i]),
    { onlyInDb: recorded.filter((x) => !defined.includes(x)),
      neverRan: defined.filter((x) => !recorded.includes(x)) });
  const [pwCols] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = 'videosite_e2e' AND TABLE_NAME = 'users'
        AND COLUMN_NAME IN ('password_hash','password_changed_at')`);
  check('users.password_hash / password_changed_at are gone', pwCols.length === 0, pwCols);
  const [[{ n: userCount }]] = await db.query('SELECT COUNT(*) n FROM users');
  check('NO account was created by the installer', userCount === 0, { userCount });

  // ---- step 2: site ----
  const badSite = await req('POST', '/api/install/site', { siteName: '', siteHostname: 'https://x/y' });
  check('site: bad input -> 422 per field',
    badSite.status === 422 && !!badSite.json.errors.siteName, badSite.json);

  const site = await req('POST', '/api/install/site', {
    siteName: SITE_NAME, siteHostname: `127.0.0.1:${PORT}`, siteProtocol: 'http',
  });
  check('site: saved, and the URLs derive from the hostname',
    site.status === 200 && site.json.derived.callback === `${BASE}/auth/callback`
      && site.json.derived.jwks === `${BASE}/.well-known/jwks.json`, site.json);

  // ---- step 3: SSO (mints our client key) ----
  const badSso = await req('POST', '/api/install/sso', { ssoIssuer: 'sso.example.com', ssoClientId: CLIENT_ID });
  check('sso: non-https issuer -> 422', badSso.status === 422 && !!badSso.json.errors.ssoIssuer);

  const ssoStep = await req('POST', '/api/install/sso', { ssoIssuer: SSO_ISSUER, ssoClientId: CLIENT_ID });
  check('sso: saved + client key MINTED', ssoStep.status === 200 && ssoStep.json.created === true && !!ssoStep.json.kid, ssoStep.json);
  const kid = ssoStep.json.kid;
  check('client key file written 0600', (fs.statSync(path.join(tmp, 'client-key.json')).mode & 0o777) === 0o600);

  const jwks = await req('GET', '/.well-known/jwks.json');
  check('jwks_uri now serves the PUBLIC key (this is what the SSO fetches at registration)',
    jwks.status === 200 && jwks.json.keys[0].kid === kid && jwks.json.keys[0].d === undefined, jwks.json);

  const probe = await req('GET', '/api/install/probe-sso?url=' + encodeURIComponent(SSO_ISSUER));
  check('sso probe: the live SSO -> ok + issuer matches', probe.json.ok === true, probe.json);

  // ---- step 5 BEFORE registering: every failure must be diagnosable ----
  const connect = await req('GET', '/api/install/connect');
  check('connect: pre-flight confirms OUR key set is readable', connect.json.preflight.ok === true, connect.json.preflight);
  check('connect: hands over what to paste (client id, hostname, paths)',
    connect.json.clientId === CLIENT_ID && connect.json.paths.redirect === '/auth/callback', connect.json);

  await sso.query('DELETE FROM oauth_clients WHERE client_id = $1', [CLIENT_ID]);
  const unknown = await req('POST', '/api/install/verify');
  check('VERIFY BLOCKED: not in the client list -> 422 unknown_client',
    unknown.status === 422 && unknown.json.stage === 'identity' && unknown.json.reason === 'unknown_client', unknown.json);

  const blockedFinish = await req('POST', '/api/install/finish', {});
  check('FINISH BLOCKED while unregistered (the server re-verifies)',
    blockedFinish.status === 422 && blockedFinish.json.reason === 'unknown_client', blockedFinish.json);
  check('  and the site is still NOT live', (await req('GET', '/')).status === 503);

  // Registered, but with no key the SSO can read.
  await sso.query(
    `INSERT INTO oauth_clients (client_id, name, redirect_uris, jwks_uri)
     VALUES ($1, $2, $3, NULL)`,
    [CLIENT_ID, 'placeholder', [`${BASE}/auth/callback`]],
  );
  const noKey = await req('POST', '/api/install/verify');
  check('VERIFY BLOCKED: registered but no jwks_uri -> no_registered_key',
    noKey.status === 422 && noKey.json.reason === 'no_registered_key', noKey.json);

  // Registered with the WRONG key.
  const wrong = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  wrong.kid = 'not-our-kid';
  wrong.alg = 'EdDSA';
  await sso.query('UPDATE oauth_clients SET jwks = $2, jwks_uri = NULL WHERE client_id = $1',
    [CLIENT_ID, JSON.stringify({ keys: [wrong] })]);
  const badKey = await req('POST', '/api/install/verify');
  check('VERIFY BLOCKED: the SSO holds a DIFFERENT key -> invalid_token',
    badKey.status === 422 && badKey.json.reason === 'invalid_token', badKey.json);

  // ---- the operator registers us properly (this is the SSO admin action) ----
  await sso.query('UPDATE oauth_clients SET jwks = NULL, jwks_uri = $2 WHERE client_id = $1',
    [CLIENT_ID, `${BASE}/.well-known/jwks.json`]);

  const verified = await req('POST', '/api/install/verify');
  check('VERIFY PASSES once we are registered with our jwks_uri', verified.status === 200 && verified.json.ok === true, verified.json);
  check('  and it published the role catalogue', Array.isArray(verified.json.roles.roles) && verified.json.roles.roles.length > 0);

  // ---- what the roles.sync actually did at the SSO ----
  const { rows: appRoles } = await sso.query('SELECT role_id, name, level FROM app_roles WHERE client_id = $1 ORDER BY level', [CLIENT_ID]);
  check('SSO stored our role catalogue', appRoles.length >= 3, appRoles);
  const { rows: [clientRow] } = await sso.query('SELECT name FROM oauth_clients WHERE client_id = $1', [CLIENT_ID]);
  check('SSO took our site_name as the client display name (RP owns its name)',
    clientRow.name === SITE_NAME, clientRow);
  const { rows: [cat] } = await sso.query('SELECT default_role_id FROM app_role_catalogs WHERE client_id = $1', [CLIENT_ID]);
  check('SSO stored our default role', cat && cat.default_role_id !== null, cat);
  const { rows: rootDefaults } = await sso.query(
    `SELECT d.app_role_id FROM org_role_app_defaults d JOIN org_roles r ON r.slug = d.role_slug
      WHERE d.client_id = $1 AND r.level = 0`, [CLIENT_ID]);
  const topRole = appRoles[0].role_id;
  check('ROOT GUARANTEE: the SSO root org role got this site\'s TOP role — that IS the admin bootstrap',
    rootDefaults.length > 0 && rootDefaults.every((d) => d.app_role_id === topRole), { rootDefaults, topRole });

  // ---- finish ----
  const finish = await req('POST', '/api/install/finish', { skippedCert: true });
  check('finish -> 200', finish.status === 200 && finish.json.ok === true, finish.json);
  check('  sends the operator to /auth/login, NOT the /login that never existed',
    finish.json.signIn.endsWith('/auth/login'), finish.json.signIn);
  check('the install token is burned', !fs.existsSync(path.join(tmp, '.install-token')));

  // ---- the site is live ----
  check('/install is gone (404, not 503)', (await req('GET', `/install?token=${token}`)).status === 404);
  check('/api/install/infra is gone', (await req('POST', '/api/install/infra', {})).status === 404);
  const home = await req('GET', '/');
  check('the site now serves (no longer 503)', home.status === 200, { status: home.status });

  await db.end();
} catch (e) {
  fail++;
  console.error('EXCEPTION:', e);
} finally {
  try { await sso.query('DELETE FROM app_roles WHERE client_id = $1', [CLIENT_ID]); } catch { /* */ }
  try { await sso.query('DELETE FROM app_role_catalogs WHERE client_id = $1', [CLIENT_ID]); } catch { /* */ }
  try { await sso.query('DELETE FROM org_role_app_defaults WHERE client_id = $1', [CLIENT_ID]); } catch { /* */ }
  try { await sso.query('DELETE FROM oauth_clients WHERE client_id = $1', [CLIENT_ID]); } catch { /* */ }
  await sso.end().catch(() => {});
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  try { sh('docker', ['rm', '-f', DB_CONTAINER]); } catch { /* */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nvideosite install e2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
