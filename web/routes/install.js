const express = require('express');
const router = express.Router();
const path = require('path');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const {
    testDatabaseConnection,
    setupDatabase,
    generateSessionSecret,
    generateMfaEncryptionKey,
    generateSettingsSecretKey,
    writeEnvFile,
    markInstalled,
} = require('../services/installService');
const { markInstalled: markInstalledCache } = require('../middleware/installer');
const { clearInstallToken } = require('../lib/installToken');
const { resetPool, getPool } = require('../config/database');
const redisService = require('../services/redis');
const oidc = require('../lib/oidc');
const mtls = require('../services/mtlsService');
const { probeSso, probeSelfJwks, verifyAndPublish } = require('../services/installVerify');

// The installer. Reached only with the install token (see middleware/installer.js);
// everything here 404s once the site is installed.
//
// No account is created. videosite has no passwords of its own — roles come from
// the SSO, and its root org role becomes this site's superadmin the moment the
// role catalogue is published (the "root guarantee" in the SSO's events.ts).

// GET /install — the standalone installer page.
//
// no-store: the response depends on installer state (pre-install only — the gate
// 404s it once installed), so caching it at the edge would let people see the
// installer after the site is live.
router.get('/install', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'install.html'));
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const cleanHost = (v) => str(v).replace(/^https?:\/\//, '').split('/')[0];

// --- step 1: infrastructure -------------------------------------------------
// Probe DB / Redis / R2, apply the schema, run the migrations, write .env, and
// adopt it all in-process. Nothing is written until every probe passes.
router.post('/api/install/infra', async (req, res) => {
    try {
        const b = req.body || {};
        const dbPort = str(b.dbPort) || '3306';
        const redisPort = str(b.redisPort) || '6379';
        const redisDb = str(b.redisDb) || '0';

        const errors = {};
        if (!str(b.dbHost)) errors.dbHost = 'Enter the database host.';
        if (!str(b.dbUser)) errors.dbUser = 'Enter the database user.';
        if (!str(b.dbPassword)) errors.dbPassword = 'Enter the database password.';
        if (!str(b.dbName)) errors.dbName = 'Enter a database name.';
        if (!str(b.redisHost)) errors.redisHost = 'Enter the Redis host.';
        if (!str(b.r2Endpoint)) errors.r2Endpoint = 'Enter the R2 endpoint.';
        if (!str(b.r2BucketName)) errors.r2BucketName = 'Enter the bucket name.';
        if (!str(b.r2AccessKeyId)) errors.r2AccessKeyId = 'Enter the access key ID.';
        if (!str(b.r2SecretAccessKey)) errors.r2SecretAccessKey = 'Enter the secret access key.';
        if (!str(b.r2PublicDomain)) errors.r2PublicDomain = 'Enter the public media domain.';
        if (Object.keys(errors).length) return res.status(422).json({ errors });

        try {
            await testDatabaseConnection(str(b.dbHost), dbPort, str(b.dbUser), str(b.dbPassword));
        } catch (err) {
            return res.status(422).json({ errors: { dbPassword: 'Could not connect: ' + err.message } });
        }
        try {
            await redisService.testConnection({
                host: str(b.redisHost), port: redisPort, password: str(b.redisPassword), db: redisDb,
            });
        } catch (err) {
            return res.status(422).json({ errors: { redisHost: 'Could not connect: ' + err.message } });
        }
        try {
            const testClient = new S3Client({
                region: 'auto',
                endpoint: str(b.r2Endpoint),
                credentials: { accessKeyId: str(b.r2AccessKeyId), secretAccessKey: str(b.r2SecretAccessKey) },
            });
            await testClient.send(new HeadBucketCommand({ Bucket: str(b.r2BucketName) }));
        } catch (err) {
            return res.status(422).json({ errors: { r2BucketName: 'Could not reach the bucket: ' + err.message } });
        }

        // Everything answered — now commit.
        await setupDatabase(str(b.dbHost), dbPort, str(b.dbUser), str(b.dbPassword), str(b.dbName));

        const settingsSecretKey = generateSettingsSecretKey();
        writeEnvFile({
            dbHost: str(b.dbHost), dbPort, dbUser: str(b.dbUser), dbPassword: str(b.dbPassword), dbName: str(b.dbName),
            redisHost: str(b.redisHost), redisPort, redisPassword: str(b.redisPassword), redisDb,
            r2Endpoint: str(b.r2Endpoint), r2BucketName: str(b.r2BucketName),
            r2AccessKeyId: str(b.r2AccessKeyId), r2SecretAccessKey: str(b.r2SecretAccessKey),
            r2PublicDomain: cleanHost(b.r2PublicDomain),
            sessionSecret: generateSessionSecret(),
            mfaEncryptionKey: generateMfaEncryptionKey(),
            settingsSecretKey,
            clientKeyFile: process.env.OIDC_CLIENT_KEY_FILE || path.join(__dirname, '..', '.videosite-client-key.json'),
            port: process.env.PORT || 3000,
        });

        // Adopt the new config in this process (no restart).
        require('dotenv').config({ override: true, path: process.env.INSTALL_ENV_FILE || undefined });
        resetPool();
        try {
            await redisService.connect();
        } catch (err) {
            return res.status(500).json({ errors: { redisHost: 'Redis connect failed after save: ' + err.message } });
        }

        // schema.sql is a snapshot at the BASELINE migration (db/baseline.json), and
        // seed.sql marks exactly those applied — so this runs every migration added
        // since, which is the same code path an existing install takes at boot. That
        // is deliberate: new migrations need no fresh-install special case, so the two
        // paths cannot drift apart. See lib/dbBaseline.js.
        //
        // Strict, because a failure here must surface rather than hand the operator a
        // success page on top of a broken schema (the old installer never ran
        // migrations at all, and the first boot died either way).
        try {
            const { runMigrations } = require('../db/migrations');
            await runMigrations({ strict: true });
        } catch (err) {
            console.error('Install migrations failed:', err);
            return res.status(500).json({ errors: { dbName: 'Migrations failed: ' + err.message } });
        }

        res.json({ ok: true, settingsSecretKeySet: !!settingsSecretKey });
    } catch (err) {
        console.error('Install (infra) failed:', err);
        res.status(500).json({ errors: { dbHost: 'Setup failed: ' + err.message } });
    }
});

// --- step 2: site -----------------------------------------------------------
// site_protocol + site_hostname are load-bearing: the callback, back-channel and
// JWKS URLs all derive from them (lib/oidc.js loadConfig), and so do the values
// the operator pastes into the SSO. site_name becomes the client's display name.
router.post('/api/install/site', async (req, res) => {
    try {
        const b = req.body || {};
        const siteName = str(b.siteName);
        const hostname = cleanHost(b.siteHostname);
        const protocol = str(b.siteProtocol) === 'http' ? 'http' : 'https';

        const errors = {};
        if (!siteName) errors.siteName = 'Enter a site name.';
        else if (siteName.length > 100) errors.siteName = 'Site names are 100 characters or fewer.';
        if (!hostname) errors.siteHostname = 'Enter the hostname people will visit.';
        else if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(hostname)) errors.siteHostname = 'A bare hostname like stream.example.com — no scheme, no path.';
        if (Object.keys(errors).length) return res.status(422).json({ errors });

        await putSettings([
            ['site_name', siteName],
            ['site_protocol', protocol],
            ['site_hostname', hostname],
        ]);
        await oidc.loadConfig(); // the derived URLs change with the hostname

        const base = `${protocol}://${hostname}`;
        res.json({
            ok: true,
            base,
            derived: {
                callback: base + '/auth/callback',
                events: base + '/backchannel/events',
                jwks: base + '/.well-known/jwks.json',
            },
        });
    } catch (err) {
        console.error('Install (site) failed:', err);
        res.status(500).json({ errors: { siteName: 'Save failed: ' + err.message } });
    }
});

// --- step 3: SSO ------------------------------------------------------------
// Saves the connection and MINTS OUR CLIENT KEY. The key must exist before the
// operator registers us: the SSO fetch-verifies jwks_uri at registration, so a
// key-less videosite simply cannot be added.
router.post('/api/install/sso', async (req, res) => {
    try {
        const b = req.body || {};
        const issuer = str(b.ssoIssuer).replace(/\/+$/, '');
        const clientId = str(b.ssoClientId) || 'videosite';
        const portal = str(b.accountPortalUrl).replace(/\/+$/, '');

        const errors = {};
        const httpsOk = (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
        if (!httpsOk(issuer)) errors.ssoIssuer = 'Enter the SSO’s https:// issuer, e.g. https://sso.example.com';
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(clientId)) errors.ssoClientId = 'Letters, digits, dot, dash and underscore only.';
        if (portal && !httpsOk(portal)) errors.accountPortalUrl = 'Enter the portal’s https:// URL.';
        if (Object.keys(errors).length) return res.status(422).json({ errors });

        await putSettings([
            ['sso_issuer', issuer],
            ['sso_client_id', clientId],
            ...(portal ? [['sso_account_portal_url', portal]] : []),
        ]);
        await oidc.loadConfig();

        const key = await oidc.ensureClientKey();
        res.json({ ok: true, clientId, kid: key.kid, created: key.created });
    } catch (err) {
        console.error('Install (sso) failed:', err);
        res.status(500).json({ errors: { ssoIssuer: 'Save failed: ' + err.message } });
    }
});

// Non-blocking discovery probe for the SSO field.
router.get('/api/install/probe-sso', async (req, res) => {
    res.json(await probeSso(typeof req.query.url === 'string' ? req.query.url.trim() : ''));
});

// --- step 4: mTLS client certificate (optional) -----------------------------
// Same service the admin SSO pane uses — generate an ECDSA P-256 key here (it
// never leaves), hand out the CSR, take the signed certificate back.
router.get('/api/install/mtls', async (_req, res) => {
    try {
        res.json(await mtls.getStatus());
    } catch (err) {
        res.status(500).json({ error: 'mtls_unavailable', detail: err.message });
    }
});

router.post('/api/install/mtls/csr', async (req, res) => {
    try {
        res.json(await mtls.startSetup(str((req.body || {}).cn)));
    } catch (err) {
        console.error('Install (mtls csr) failed:', err);
        res.status(500).json({ error: 'csr_failed', detail: err.message });
    }
});

router.post('/api/install/mtls/cert', async (req, res) => {
    try {
        const result = await mtls.installCert(str((req.body || {}).cert));
        if (!result.ok) return res.status(422).json({ error: 'invalid_cert', reason: result.reason });
        res.json({ ok: true, ...(await mtls.getStatus()) });
    } catch (err) {
        console.error('Install (mtls cert) failed:', err);
        res.status(500).json({ error: 'install_failed', detail: err.message });
    }
});

router.delete('/api/install/mtls', async (_req, res) => {
    try {
        await mtls.reset();
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'reset_failed', detail: err.message });
    }
});

// --- step 5: connect --------------------------------------------------------
// Everything the operator must paste into the SSO's new-client form, plus our own
// pre-flight (can the world read our key set?).
router.get('/api/install/connect', async (_req, res) => {
    try {
        const { getSetting } = require('../services/cache/settingsCache');
        const protocol = await getSetting('site_protocol', 'https');
        const hostname = await getSetting('site_hostname', '');
        const base = hostname ? `${protocol}://${hostname}` : '';
        const clientId = await getSetting('sso_client_id', 'videosite');
        const issuer = await getSetting('sso_issuer', '');
        const siteName = await getSetting('site_name', 'VideoSite');

        res.json({
            issuer,
            clientId,
            siteName,
            hostname,
            base,
            paths: { redirect: '/auth/callback', events: '/backchannel/events', jwks: '/.well-known/jwks.json' },
            derived: base
                ? {
                      callback: base + '/auth/callback',
                      events: base + '/backchannel/events',
                      jwks: base + '/.well-known/jwks.json',
                  }
                : null,
            key: oidc.hasClientKey() ? oidc.clientKeyInfo() : null,
            preflight: base ? await probeSelfJwks(base) : { ok: false, reason: 'no_hostname' },
        });
    } catch (err) {
        console.error('Install (connect) failed:', err);
        res.status(500).json({ error: 'connect_unavailable', detail: err.message });
    }
});

// THE GATE. One signed roles.sync proves the SSO knows us, that our key verifies,
// and that it accepted our role catalogue — and publishing that catalogue is what
// hands the SSO's root org role this site's top role. Anything less than a 204
// and the installer does not finish.
router.post('/api/install/verify', async (_req, res) => {
    const result = await verifyAndPublish();
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
});

// Finish: re-verify (never trust a stale client-side "verified"), then flip the
// latch and burn the token. From here /install 404s and the site is live.
router.post('/api/install/finish', async (req, res) => {
    try {
        const result = await verifyAndPublish();
        if (!result.ok) return res.status(422).json(result);

        const b = req.body || {};
        await markInstalled(
            process.env.DB_HOST, process.env.DB_PORT || '3306',
            process.env.DB_USER, process.env.DB_PASSWORD, process.env.DB_NAME
        );
        markInstalledCache();
        clearInstallToken();
        res.clearCookie('install_token', { path: '/' });

        const { getSetting } = require('../services/cache/settingsCache');
        const protocol = await getSetting('site_protocol', 'https');
        const hostname = await getSetting('site_hostname', '');
        res.json({
            ok: true,
            // /auth/login, NOT /login — the latter has never existed, and the old
            // installer sent every operator to it.
            signIn: hostname ? `${protocol}://${hostname}/auth/login` : '/auth/login',
            roles: result.roles,
            skippedCert: !!b.skippedCert,
        });
    } catch (err) {
        console.error('Install (finish) failed:', err);
        res.status(500).json({ error: 'finish_failed', detail: err.message });
    }
});

async function putSettings(pairs) {
    const pool = getPool();
    for (const [key, value] of pairs) {
        await pool.execute(
            'INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [key, value]
        );
    }
    const settingsCache = require('../services/cache/settingsCache');
    if (settingsCache.invalidate) await settingsCache.invalidate();
}

module.exports = router;
