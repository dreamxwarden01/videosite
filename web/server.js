require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const { cleanExpiredSessions } = require('./config/session');

const app = express();

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
const apiMfaAdminRoutes = require('./routes/api/mfa-admin');
const apiMfaRoutes = require('./routes/api/mfa');
const passwordResetRoutes = require('./routes/password-reset');
const apiMaterialRoutes = require('./routes/api/materials');

app.use(installRoutes);
app.use(authRoutes);
app.use(mfaAuthRoutes);
app.use(registerRoutes);
app.use(passwordResetRoutes);
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
app.listen(PORT, async () => {
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

    // Sweep stale upload sessions on startup and restart their timers
    try {
        const { resetStaleUploads } = require('./services/uploadSessionService');
        await resetStaleUploads();
    } catch (err) {
        console.error('Failed to reset stale uploads:', err.message);
    }
});
