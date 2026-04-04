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
    if (req.path === '/api/install') {
        return res.status(404).json({ error: 'Not found' });
    }
    // GET /install — serve SPA index so React router shows 404 page
    const spaIndex = path.join(__dirname, '..', 'client', 'dist', 'index.html');
    if (fs.existsSync(spaIndex)) {
        return res.status(404).sendFile(spaIndex);
    }
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
