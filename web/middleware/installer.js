const fs = require('fs');
const path = require('path');

// Tracks whether the app is installed (cached after first check)
let installed = null;

async function checkInstallStatus() {
    // Check if .env has DB_HOST set (basic indicator that install happened)
    if (!process.env.DB_HOST || !process.env.DB_NAME) {
        return false;
    }

    try {
        const { getPool } = require('../config/database');
        const pool = getPool();
        const [rows] = await pool.execute(
            "SELECT setting_value FROM site_settings WHERE setting_key = 'installed'"
        );
        return rows.length > 0 && rows[0].setting_value === 'true';
    } catch (err) {
        return false;
    }
}

function rejectInstallRoute(req, res) {
    // Both branches set Cache-Control explicitly. checkInstalled runs at
    // app-level before the /api no-store middleware in server.js, so a
    // bare res.json here would otherwise go out with no cache header.
    if (req.path === '/api/install') {
        res.set('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Not found' });
    }
    // GET /install after the site is installed: same 404 + standalone
    // 404.html the route allowlist sends for any other unknown path.
    // Cache header matches NOT_FOUND_CACHE in server.js so all 404
    // responses cache identically at the edge.
    const notFoundFile = path.join(__dirname, '..', 'client', 'dist', '404.html');
    if (fs.existsSync(notFoundFile)) {
        res.set('Cache-Control', 'public, max-age=600');
        return res.status(404).sendFile(notFoundFile);
    }
    res.set('Cache-Control', 'no-store');
    res.status(404).json({ error: 'Not found' });
}

function checkInstalled(req, res, next) {
    const isInstallRoute = req.path.startsWith('/install') || req.path === '/api/install';
    const isStaticRoute = req.path.startsWith('/assets') || req.path.startsWith('/css') ||
        req.path.startsWith('/js') || req.path.startsWith('/img') ||
        req.path === '/favicon.ico';

    // Always allow static files
    if (isStaticRoute) return next();

    // If we already know it's installed
    if (installed === true) {
        if (isInstallRoute) return rejectInstallRoute(req, res);
        return next();
    }

    // Not yet confirmed installed — check
    checkInstallStatus().then(isInstalled => {
        installed = isInstalled;
        if (isInstalled) {
            if (isInstallRoute) return rejectInstallRoute(req, res);
            return next();
        }
        // Not installed — allow install routes, redirect everything else
        if (isInstallRoute) return next();
        res.redirect('/install');
    }).catch(() => {
        if (isInstallRoute) return next();
        res.redirect('/install');
    });
}

function markInstalled() {
    installed = true;
}

function resetInstallCache() {
    installed = null;
}

module.exports = { checkInstalled, markInstalled, resetInstallCache };
