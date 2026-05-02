require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const { cleanExpiredSessions } = require('./config/session');

const app = express();

// API responses should never be cached: ETags trigger 304s that complicate
// debugging (have to strip If-None-Match by hand), and stale JSON in a
// browser cache is more confusing than useful for a session-scoped app.
// Disabling here only affects res.json/res.send — express.static keeps its
// own ETag handling so hashed bundle assets still cache properly.
app.disable('etag');

// Middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static assets before install check (CSS/JS/images needed by install page)
app.use('/assets', express.static(path.join(__dirname, 'client', 'dist', 'assets')));
app.use('/favicon.ico', express.static(path.join(__dirname, 'client', 'dist', 'favicon.ico')));

// Installation check middleware
const { checkInstalled } = require('./middleware/installer');
app.use(checkInstalled);

// Serve remaining static files after install check
app.use(express.static(path.join(__dirname, 'client', 'dist'), { index: false }));

// Auth middleware (load user on every request if session cookie exists)
const { loadUser } = require('./middleware/auth');
app.use(loadUser);

// Routes
const installRoutes = require('./routes/install');
const authRoutes = require('./routes/auth');
const registerRoutes = require('./routes/register');
const apiAppRoutes = require('./routes/api/app');
const apiPagesRoutes = require('./routes/api/pages');
const apiAdminRoutes = require('./routes/api/admin');
const apiUploadRoutes = require('./routes/api/upload');
const apiVideoRoutes = require('./routes/api/videos');
const apiWorkerRoutes = require('./routes/api/worker');
const mfaAuthRoutes = require('./routes/mfa-auth');
const passkeyLoginRoutes = require('./routes/passkey-login');
const apiMfaAdminRoutes = require('./routes/api/mfa-admin');
const apiMfaRoutes = require('./routes/api/mfa');
const passwordResetRoutes = require('./routes/password-reset');
const apiMaterialRoutes = require('./routes/api/materials');

app.use(installRoutes);
app.use(authRoutes);
app.use(mfaAuthRoutes);
app.use(passkeyLoginRoutes);
app.use(registerRoutes);
app.use(passwordResetRoutes);

// Belt-and-suspenders: disabling app-level etag stops 304s, but a browser
// that previously cached an /api response (e.g. with a stale Cache-Control
// from before this change) could still reuse it. no-store on every /api
// reply makes the cache miss explicit.
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

app.use('/api', apiAppRoutes);
app.use('/api', apiPagesRoutes);
app.use('/api', apiAdminRoutes);
app.use('/api', apiUploadRoutes);
app.use('/api', apiVideoRoutes);
app.use('/api', apiWorkerRoutes);
app.use('/api', apiMfaAdminRoutes);
app.use('/api', apiMfaRoutes);
app.use('/api', apiMaterialRoutes);

// SPA fallback — serve React app for non-API routes
const spaIndexPath = path.join(__dirname, 'client', 'dist', 'index.html');

app.use((req, res) => {
    // API routes: return JSON 404
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }

    // Non-API routes: serve SPA index.html
    if (fs.existsSync(spaIndexPath)) {
        return res.sendFile(spaIndexPath);
    }

    // No build yet (dev without build)
    res.status(404).json({ error: 'SPA not built. Run: cd client && npm run build' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    const message = process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.';

    if (req.originalUrl.startsWith('/api/')) {
        return res.status(500).json({ error: message });
    }

    if (fs.existsSync(spaIndexPath)) {
        return res.sendFile(spaIndexPath);
    }

    res.status(500).json({ error: message });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000');
const server = app.listen(PORT, async () => {
    console.log(`VideoSite running on http://localhost:${PORT}`);

    // Run database migrations if the app is installed
    if (process.env.DB_HOST && process.env.DB_NAME) {
        try {
            const { runMigrations } = require('./db/migrations');
            await runMigrations();
        } catch (err) {
            console.error('Failed to run migrations:', err.message);
        }
    }

    // Connect Redis (required when installed). Fail loud and exit if unreachable —
    // a half-working cache is harder to debug than a clear startup failure.
    if (process.env.REDIS_HOST) {
        try {
            const redisService = require('./services/redis');
            await redisService.connect();

            // Start the periodic write-coalescing flusher (drains dirty:session:user
            // every 15 min into DB). Phase 5 will plug watch + transcode into the
            // same module.
            const flusher = require('./services/flusher');
            flusher.start();
        } catch (err) {
            console.error(`Redis is required and unreachable at ${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}: ${err.message}`);
            process.exit(1);
        }
    }

    // Clean expired sessions every hour
    setInterval(cleanExpiredSessions, 60 * 60 * 1000);

    // Clean expired registrations, invitation codes, and rate limit records every hour
    const { cleanupExpiredRegistrations } = require('./services/registrationService');
    setInterval(cleanupExpiredRegistrations, 60 * 60 * 1000);

    // Clean expired MFA challenges, bmfa tokens, and OTP rate limits every hour
    const { cleanupExpiredChallenges, cleanupExpiredOtpRateLimits, cleanupExpiredBmfa, cleanupExpiredTotpRateLimits } = require('./services/mfaService');
    setInterval(() => {
        cleanupExpiredChallenges();
        cleanupExpiredOtpRateLimits();
        cleanupExpiredBmfa();
        cleanupExpiredTotpRateLimits();
    }, 60 * 60 * 1000);

    // Clean expired password reset tokens and rate limits every hour
    const { cleanupExpiredResetTokens, cleanupExpiredResetRateLimits } = require('./services/passwordResetService');
    setInterval(() => {
        cleanupExpiredResetTokens();
        cleanupExpiredResetRateLimits();
    }, 60 * 60 * 1000);

    // Clean stale material uploads every hour
    const { cleanupStaleMaterials, deleteR2Object } = require('./services/materialService');
    setInterval(async () => {
        try {
            const staleKeys = await cleanupStaleMaterials();
            for (const key of staleKeys) {
                deleteR2Object(key).catch(err => {
                    console.error(`R2 material cleanup failed for ${key}:`, err.message);
                });
            }
        } catch (err) {
            console.error('Material cleanup error:', err.message);
        }
    }, 60 * 60 * 1000);

    // Clean expired worker sessions every hour
    const { cleanupExpiredWorkerSessions } = require('./services/workerAuthService');
    setInterval(async () => {
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
    setInterval(async () => {
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
        console.error('Failed to reset stale uploads:', err.message);
    }
});

// Graceful shutdown — stop accepting requests, drain Redis cleanly, exit.
// Future phases will add flusher.flushAll() here so coalesced progress lands
// in DB before exit. Wrap in a deadline so we beat orchestrator SIGKILL grace.
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    const deadline = setTimeout(() => {
        console.error('Shutdown deadline (25s) exceeded, forcing exit.');
        process.exit(1);
    }, 25_000);
    deadline.unref();

    try {
        await new Promise((resolve) => server.close(() => resolve()));
    } catch (err) {
        console.error('Error closing HTTP server:', err.message);
    }

    if (process.env.REDIS_HOST) {
        try {
            // Stop the flusher's interval and drain any remaining dirty sets
            // to DB before disconnecting Redis.
            const flusher = require('./services/flusher');
            flusher.stop();
            const drained = await flusher.flushAll();
            if (drained > 0) console.log(`Flusher: drained ${drained} sessions on shutdown`);
        } catch (err) {
            console.error('Error during shutdown flush:', err.message);
        }
        try {
            const redisService = require('./services/redis');
            await redisService.quit();
        } catch (err) {
            console.error('Error during Redis quit:', err.message);
        }
    }

    clearTimeout(deadline);
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
