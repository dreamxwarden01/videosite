require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { cleanExpiredSessions } = require('./config/session');
const backgroundTasks = require('./lib/backgroundTasks');

const app = express();
let shuttingDown = false;
let startupFailed = false;

// Reject requests on existing keep-alive connections before any body/auth work.
app.use((_req, res, next) => {
    if (!shuttingDown) return next();
    res.set({ Connection: 'close', 'Cache-Control': 'no-store' });
    return res.status(503).json({ error: 'service_stopping' });
});

function safeError(error) {
    const codes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
        'EADDRINUSE', 'EACCES', 'ENOENT', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'];
    const names = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
        'AggregateError', 'InstallStateUnknownError'];
    return codes.includes(error?.code) ? error.code : names.includes(error?.name) ? error.name : 'Error';
}

// API responses should never be cached: ETags trigger 304s that complicate
// debugging (have to strip If-None-Match by hand), and stale JSON in a
// browser cache is more confusing than useful for a session-scoped app.
// Disabling here only affects res.json/res.send — express.static keeps its
// own ETag handling so hashed bundle assets still cache properly.
app.disable('etag');

// Middleware
//
// morgan('dev') logs :url with the query string attached, which on
// /auth/callback means live single-use authorization codes (and the flow state)
// land in the container log. Strip the query from the auth routes rather than
// relying on log retention to age the credentials out; every other route keeps
// its full URL, which is what makes the log useful.
// Routes whose query string carries a live single-use credential. /auth/*
// holds the authorization code and flow state; /install holds the install
// token, which gates an unauthenticated takeover surface. Match
// case-insensitively — Express routing is case-insensitive by default, so
// /Auth/Callback reaches the same handler and must be redacted the same way.
const LOGGED_QUERY_REDACTED = /^\/(auth|install)(\/|$|\?)/i;
morgan.token('safeurl', (req) => {
    const url = req.originalUrl || req.url || '';
    return LOGGED_QUERY_REDACTED.test(url) ? url.split('?')[0] : url;
});
// Compress origin responses. Cloudflare compresses edge->client regardless, so
// this is purely about the origin->edge leg — which for /api is every single
// request forever, because no-store guarantees the edge never absorbs one.
// Static assets are amortised to once per colo per deploy by the immutable
// headers, so the JSON is where this actually pays.
// Compress origin responses. Cloudflare compresses edge->client regardless, so
// this is about the origin->edge leg — which for /api is every request forever,
// because no-store guarantees the edge never absorbs one. Static assets are
// amortised to once per colo per deploy by the immutable headers, so the JSON is
// where it pays.
//
// Encoding is left to normal negotiation: compression@1.8 prefers brotli when
// the client offers it, which is both smaller and readable by current debugging
// proxies (Charles has decoded brotli since 3.12).
app.use(compression());

app.use(morgan(':method :safeurl :status :response-time ms - :res[content-length]'));
// Available while registering the RP, before installation/session gates. Mount
// before body parsers so every non-GET method, including HEAD, returns405.
app.use(require('./routes/publicJwks').publicJwksRouter());
app.use('/backchannel/events', require('./middleware/ssoEventBody').eventFormParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static assets before install check (CSS/JS/images needed by install page)
// Vite content-hashes everything under /assets, so a given URL's bytes can
// never change — the filename changes instead. `immutable` tells the browser to
// skip revalidation entirely for a year. Without it serve-static defaults to
// max-age=0 and every bundle costs a conditional request on every page load.
app.use('/assets', express.static(path.join(__dirname, 'client', 'dist', 'assets'), {
    maxAge: '1y', immutable: true,
}));
app.use('/favicon.ico', express.static(path.join(__dirname, 'client', 'dist', 'favicon.ico')));

// Shaka Player, vendored from npm into a version/content-stamped directory
// (see client/vite.config.js). Local UI-font transforms change its CSS bytes,
// so both dependency upgrades and transform changes must get a fresh URL
// rather than reusing a response already cached as immutable.
app.use('/vendor', express.static(path.join(__dirname, 'client', 'dist', 'vendor'), {
    maxAge: '1y', immutable: true,
}));

// Content-versioned UI font assets must also work before installation/auth.
// The dedicated router rejects non-reads and missing files before SPA routing.
app.use('/fonts', require('./routes/fonts').fontsRouter());

// Installation check middleware
const { checkInstalled } = require('./middleware/installer');
app.use(checkInstalled);

// Serve remaining static files after install check
app.use(express.static(path.join(__dirname, 'client', 'dist'), { index: false }));

// Auth middleware (load user on every request if session cookie exists)
const { loadUser } = require('./middleware/auth');
// loadUser is scoped to the routers that actually read res.locals.user (/api
// and /auth) rather than mounted app-wide. Two reasons, both real:
//
// 1. Correctness of the cache headers. loadUser calls res.clearCookie(sid) on a
//    stale, expired or orphaned session, and it used to run ahead of the SPA
//    shell (public, max-age=120) and the 404 catch-all (public, max-age=600).
//    Those responses then went out as publicly cacheable AND carrying
//    `Set-Cookie: sid=; Expires=1970`. Cloudflare declines to cache anything
//    with a Set-Cookie, so the edge caching those constants exist for silently
//    never happened for exactly the users with expired sessions — and any cache
//    that does NOT implement that heuristic (a corporate proxy, a future CDN,
//    or a Cache Rule someone adds to make /assets/* eligible) would store the
//    cookie-clearing header and replay it to everyone, logging them out for the
//    life of the entry. The 404 branch was the dangerous one: it fires for
//    stray .js/.css/.ico paths, exactly the extensions an edge treats as
//    cacheable by default.
//
// 2. Cost. Resolving a session is ~8-10 Redis operations INCLUDING A WRITE
//    (session read, validity + limits, user meta, activity touch, auth bundle).
//    Doing all of that to hand back a byte-identical 480-byte static shell —
//    and then labelling the result `public`, i.e. explicitly user-independent —
//    was a contradiction, and every bot hitting an unmatched URL with a stale
//    cookie drove Redis traffic through the 404 handler.
//
// Session activity is still refreshed on every page load: the SPA calls
// /api/me on mount, and playback keeps up a steady stream of /api traffic.
app.use('/api', loadUser);
app.use('/auth', loadUser);

// Routes
const installRoutes = require('./routes/install');
const authRoutes = require('./routes/auth'); // now the OIDC RP flow (login/callback/error/logout)
const backchannelRoutes = require('./routes/backchannel'); // SSO event receiver (logout, role-sync requests, ...)
const apiAppRoutes = require('./routes/api/app');
const apiPagesRoutes = require('./routes/api/pages');
const apiAdminRoutes = require('./routes/api/admin');
const apiUploadRoutes = require('./routes/api/upload');
const apiVideoRoutes = require('./routes/api/videos');
const apiWorkerRoutes = require('./routes/api/worker');
const apiMfaAdminRoutes = require('./routes/api/mfa-admin'); // site MFA POLICY admin (kept)
const apiMaterialRoutes = require('./routes/api/materials');
const apiSsoRoutes = require('./routes/api/sso'); // DreamSSO connection + mTLS admin
// Identity (registration, password reset, login MFA, self-service password/
// email) lives at the SSO now — the local flows were removed outright.

// Belt-and-suspenders: disabling app-level etag stops 304s, but a browser
// that previously cached an /api response (e.g. with a stale Cache-Control
// from before this change) could still reuse it. no-store on every /api
// reply makes the cache miss explicit.
//
// MUST be mounted BEFORE every /api/* router below — Express middleware
// runs in declaration order, and the routers below register their own
// /api/* paths (some via app.use(routes) without a prefix, some via
// app.use('/api', routes)). Originally this lived between the two groups,
// which let some of those paths bypass it. Moving it up plugs that hole.
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

app.use(installRoutes);
// /auth/* is per-user or per-flow without exception, and none of it may be
// cached. The /api no-store guard below is mounted on '/api', so it never
// covered these. Two of them are cacheable-status responses that carry no
// Set-Cookie for Cloudflare to key off: /auth/login returns a bare 302 when the
// user is already signed in, and /auth/stepup/status returns this session's
// step-up state as 200 JSON. A cached /auth/login 302 would send every
// anonymous visitor to returnTo instead of the SSO — a login loop for the whole
// colo — and a cached stepup/status hands one user's state to another. The
// origin should say so itself rather than depend on an edge rule's path scope.
app.use('/auth', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(authRoutes);

app.use(backchannelRoutes); // /backchannel/events (envelope-authed, no session; unified path)
app.use('/api', apiAppRoutes);
app.use('/api', apiPagesRoutes);
app.use('/api', apiAdminRoutes);
app.use('/api', apiUploadRoutes);
app.use('/api', apiVideoRoutes);
app.use('/api', apiWorkerRoutes);
app.use('/api', apiMfaAdminRoutes);
app.use('/api', apiMaterialRoutes);
app.use('/api', apiSsoRoutes);

// SPA route allowlist — every client path that should serve index.html must
// appear here. Anything not in the list (and not handled by an earlier
// router or static-file middleware) falls through to the 404 catch-all
// below and gets a real status 404 + standalone 404.html.
//
// MUST stay in sync with client/src/App.jsx. We don't auto-derive — the
// list is small enough that manual maintenance is cheaper than the build-
// time / shared-module gymnastics, and additions are rare.
//
// Static asset routes (/assets/*, /favicon.ico, /install.html) are served
// by express.static earlier in the middleware chain, so they don't need
// listing here. The /install client path is owned by routes/install.js.
const spaPaths = [
    // '/' stays so an authenticated landing renders; login itself is the
    // backend /auth/* routes (not SPA paths), and unauth users get
    // full-page-redirected there by ProtectedRoute.
    '/',

    // Authenticated user pages
    '/course/:courseId',
    '/course/:courseId/materials',  // materials tab of the course view
    '/course/:courseId/watch/:videoId',  // video playback (nested so the sidebar keeps the course highlighted)

    // Admin
    '/admin/courses',
    '/admin/courses/:courseId',
    '/admin/users',
    '/admin/users/:id/edit',
    '/admin/enrollment',
    '/admin/roles',
    '/admin/settings',          // redirects (client-side) to /admin/settings/general
    '/admin/settings/:pane',    // per-pane deep links + the step-up returnTo target
    '/admin/transcoding',
    '/admin/mfa-settings',      // legacy → redirects (client-side) to /admin/settings/mfa
];

const spaIndexPath = path.join(__dirname, 'client', 'dist', 'index.html');
const notFoundPath = path.join(__dirname, 'client', 'dist', '404.html');

// Cache-Control values for the HTML responses Express owns. Set here
// instead of at the nginx layer because nginx's add_header rules don't
// preserve upstream status codes cleanly (error_page-mapped responses
// kept rewriting 404 → 200), and routing decisions already live in this
// file — having Express set its own cache headers keeps everything in
// one place.
const SPA_SHELL_CACHE = 'public, max-age=120';   // 2 min — bundle URLs are hashed, deploys propagate within window
const NOT_FOUND_CACHE = 'public, max-age=600';   // 10 min — 404s rarely become real

// Allowlisted SPA paths get the shell. GET handles HEAD too (Express).
// Other methods (POST, PUT, etc.) fall through to the 404 — actions live
// under /api, never on a client path.
app.get(spaPaths, (req, res) => {
    if (fs.existsSync(spaIndexPath)) {
        res.set('Cache-Control', SPA_SHELL_CACHE);
        return res.sendFile(spaIndexPath);
    }
    // No build yet (dev without build) — give a useful hint instead of
    // a generic 404, since 404.html probably doesn't exist either.
    res.status(404).json({ error: 'SPA not built. Run: cd client && npm run build' });
});

// Catch-all — anything that didn't match an earlier router, a static file,
// or an SPA path. Returns a real 404 status code (no more 200 + SPA shell
// for /wp-admin.php and friends).
app.use((req, res) => {
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }

    if (fs.existsSync(notFoundPath)) {
        res.set('Cache-Control', NOT_FOUND_CACHE);
        return res.status(404).sendFile(notFoundPath);
    }

    // 404.html missing (shouldn't happen post-build) — last-resort minimal
    // body so we still return the right status code.
    res.status(404).type('html').send('<!DOCTYPE html><title>Page not found</title><h1>404 — Page not found</h1>');
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    const message = process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.';

    if (req.originalUrl.startsWith('/api/')) {
        return res.status(500).json({ error: message });
    }

    // Set the status explicitly: a custom error middleware runs instead of
    // finalhandler, so res.statusCode is still 200 here and every unhandled
    // error on a non-API path was being reported as a successful 200 — with
    // send()'s default `public, max-age=0` on it. A malformed JSON body to any
    // SPA path was enough to produce that.
    res.status(err.status || err.statusCode || 500);
    res.set('Cache-Control', 'no-store');
    if (fs.existsSync(spaIndexPath)) {
        return res.sendFile(spaIndexPath);
    }

    res.json({ error: message });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000');
let startup = Promise.resolve();
let redisConnected = false;
const server = app.listen(PORT, () => {
    startup = initialize().catch(error => {
        startupFailed = true;
        console.error('Startup failed:', safeError(error));
        if (!shuttingDown) process.exit(1);
    });
});
server.on('request', (_req, res) => res.once('finish', () => {
    if (shuttingDown) server.closeIdleConnections();
}));
async function initialize() {
    if (shuttingDown) return;
    console.log(`VideoSite running on http://localhost:${PORT}`);

    // Resolve the install latch ONCE, here — every later request reads it from
    // RAM. Not installed => the gate answers everything with a neutral 503 and
    // only the token-locked installer responds.
    const { resolveInstallState, InstallStateUnknownError } = require('./middleware/installer');
    const { ensureInstallToken, clearInstallToken, TOKEN_FILE } = require('./lib/installToken');
    let alreadyInstalled;
    try {
        alreadyInstalled = await resolveInstallState();
    } catch (err) {
        if (shuttingDown) throw err;
        if (!(err instanceof InstallStateUnknownError)) throw err;
        // Configured box, unreachable database. Exit rather than come up: the
        // latch is resolved once and never re-checked, so serving on through
        // this would leave the process permanently believing it is a fresh
        // install — 503 on every path, the installer surface reopened, and a
        // startup banner naming the wrong problem. Same posture as the Redis
        // check below: a clear startup failure beats a half-working process.
        console.error('FATAL: could not determine install state —', safeError(err));
        console.error('The database is configured (DB_HOST/DB_NAME are set) but unreachable.');
        console.error('Refusing to start: continuing would look identical to an uninstalled site.');
        process.exit(1);
    }
    if (shuttingDown) return;
    if (!alreadyInstalled) {
        const token = ensureInstallToken();
        console.log('VideoSite — FIRST-RUN INSTALL');
        console.log(`  open:  /install?token=${token}`);
        console.log(`  token: ${TOKEN_FILE}`);
        return; // no migrations, no Redis, no pumps — there's nothing configured yet
    }
    // Installed: no installer, so no lock. Drops a token left behind by a run
    // that was interrupted before finish.
    clearInstallToken();

    // Run database migrations if the app is installed
    if (process.env.DB_HOST && process.env.DB_NAME) {
        try {
            const { runMigrations } = require('./db/migrations');
            await runMigrations();
        } catch (err) {
            if (shuttingDown) throw err;
            console.error('Failed to run migrations:', safeError(err));
        }
    }

    if (shuttingDown) return;

    // Connect Redis (required when installed). Fail loud and exit if unreachable —
    // a half-working cache is harder to debug than a clear startup failure.
    if (process.env.REDIS_HOST) {
        try {
            const redisService = require('./services/redis');
            await redisService.connect();
            redisConnected = true;
            if (shuttingDown) return;

            // Flush cached role permissions once. A deploy that adds a key to
            // ALL_PERMISSIONS leaves pre-deploy role:perms:* entries missing
            // that key (reads as false) until their 24h TTL expires; flushing
            // here forces a clean rebuild from DB.
            try {
                await require('./services/cache/permissionCache').invalidateAllRoles();
                if (shuttingDown) return;
            } catch (err) {
                if (shuttingDown) throw err;
                console.error('Role permission cache flush failed:', safeError(err));
            }
            if (shuttingDown) return;

            // Flush the site:settings Redis blob too. After migration 035 the
            // hmac_secret_key / email_secret_key rows are stored encrypted;
            // a stale pre-deploy site:settings blob still holds the plaintext
            // forms. The new readers tolerate either via the enc:v1: prefix
            // check, but invalidating once ensures the encrypted form lands
            // immediately rather than after the 30 min TTL.
            try {
                await require('./services/cache/settingsCache').invalidate();
                if (shuttingDown) return;
            } catch (err) {
                if (shuttingDown) throw err;
                console.error('Settings cache flush failed:', safeError(err));
            }
            if (shuttingDown) return;

            // Overlay the SSO connection config from site_settings (env fallback),
            // so admin edits in the SSO card take effect for the live OIDC flow.
            try {
                await require('./lib/oidc').loadConfig();
                if (shuttingDown) return;
            } catch (err) {
                if (shuttingDown) throw err;
                console.error('SSO config load failed:', safeError(err));
            }

            // Start the periodic write-coalescing flusher (drains dirty:session:user
            // every 15 min into DB). Phase 5 will plug watch + transcode into the
            // same module.
            if (shuttingDown) return;
            const flusher = require('./services/flusher');
            flusher.start();

            // SSO event pump: boot-time full role report (self-healing) +
            // the 60s retry sweep for the outbound event queue.
            require('./services/ssoEvents').start();
        } catch (err) {
            throw err; // Report a safe error code and retain failure even during stop.
        }
    }

    if (shuttingDown) return;

    // Clean expired sessions every hour
    backgroundTasks.interval(cleanExpiredSessions, 60 * 60 * 1000);

    // Clean expired MFA challenges, bmfa tokens, and TOTP rate limits every hour
    // (registration/password-reset/email-OTP cleanups left with their features —
    // identity lives at the SSO now)
    const { cleanupExpiredChallenges, cleanupExpiredBmfa, cleanupExpiredTotpRateLimits } = require('./services/mfaService');
    backgroundTasks.interval(async () => {
        const results = await Promise.allSettled([
            cleanupExpiredChallenges(),
            cleanupExpiredBmfa(),
            cleanupExpiredTotpRateLimits(),
        ]);
        for (const result of results) {
            if (result.status === 'rejected') console.error('MFA cleanup failed:', safeError(result.reason));
        }
    }, 60 * 60 * 1000);

    // Periodic R2 deletion reaper. Drains pending_deletes rows whose
    // execute_at has passed. Boot drain runs immediately so rows queued
    // during downtime get picked up; subsequent ticks every 60s (env-
    // configurable via DELETION_REAPER_INTERVAL_MS).
    //
    // Note: the previous hourly cleanupStaleMaterials cron is gone —
    // attachment uploads are now heartbeat-tracked in upload_sessions,
    // so stale detection happens within 60s via the per-session timer.
    const deletionService = require('./services/deletionService');
    deletionService.startReaper();

    // Clean expired worker sessions every hour
    const { cleanupExpiredWorkerSessions } = require('./services/workerAuthService');
    backgroundTasks.interval(async () => {
        try {
            const n = await cleanupExpiredWorkerSessions();
            if (n > 0) console.log(`Cleaned ${n} expired worker sessions`);
        } catch (err) {
            console.error('Worker session cleanup error:', err.message);
        }
    }, 60 * 60 * 1000);

    // Periodic stale-task / pending-TTL reset. Backstop for the in-process
    // per-job timer (lost on server restart) and for workers that died
    // between reserving (queued → pending) and leasing. Runs every 60s
    // because it's a recovery path — the in-process timer fires at 2 min
    // for actively-tracked jobs and the pending hold is only 10s.
    const { resetStaleTasks, resetExpiredPendingTasks } = require('./services/processingService');
    backgroundTasks.interval(async () => {
        try {
            await resetExpiredPendingTasks();
            await resetStaleTasks();
        } catch (err) {
            console.error('Periodic stale-task reset error:', err.message);
        }
    }, 60 * 1000);

    // Sweep stale upload sessions on startup and restart their timers
    try {
        const { resetStaleUploads } = require('./services/uploadSessionService');
        await resetStaleUploads();
    } catch (err) {
        if (shuttingDown) throw err;
        console.error('Failed to reset stale uploads:', safeError(err));
    }
}

// One total budget, including HTTP requests, startup, background work and final
// persistence. The container stop grace must exceed this 25s application budget.
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    const deadline = setTimeout(() => {
        console.error('Shutdown deadline (25s) exceeded, forcing exit.');
        process.exit(1);
    }, 25_000);
    let exitCode = 0;
    // Cancel future producers immediately. Accepted requests/startup are still
    // allowed to complete before closing their Redis/database dependencies.
    const backgroundStopped = backgroundTasks.stop();

    try {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeIdleConnections();
        });
    } catch (err) {
        exitCode = 1;
        console.error('Error closing HTTP server:', safeError(err));
    }

    await startup;
    if (startupFailed) exitCode = 1;
    // Requests may detach durable work while draining. Wait again now admission
    // and startup are closed; track() permits only already-started promises.
    const results = [...await backgroundStopped, ...await backgroundTasks.wait()];
    for (const result of results) {
        if (result.status === 'rejected') console.error('Background task failed during stop:', safeError(result.reason));
    }

    if (redisConnected) {
        try {
            // Stop the flusher's interval and drain any remaining dirty sets
            // to DB before disconnecting Redis.
            const flusher = require('./services/flusher');
            flusher.stop();
            const drained = await flusher.flushAll();
            if (drained > 0) console.log(`Flusher: drained ${drained} sessions on shutdown`);
        } catch (err) {
            exitCode = 1;
            console.error('Error during shutdown flush:', safeError(err));
        }
    }
    try {
        // Also closes a partially connected client if startup failed/stopped.
        await require('./services/redis').quit();
    } catch (err) {
        exitCode = 1;
        console.error('Error during Redis quit:', safeError(err));
    }

    try {
        await require('./config/database').closePool();
    } catch (err) {
        exitCode = 1;
        console.error('Error closing database pool:', safeError(err));
    }
    clearTimeout(deadline);
    process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
