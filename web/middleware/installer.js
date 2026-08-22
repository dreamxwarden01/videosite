const fs = require('fs');
const path = require('path');
const { verifyInstallToken } = require('../lib/installToken');

// First-run install state — a monotonic RAM latch (false -> true, never back),
// resolved once at boot and flipped in-process when the installer finishes. No
// per-request DB hit.
let installed = null;

// Thrown when the app is clearly configured but the database cannot be reached,
// so the caller can fail loudly instead of mistaking an outage for a fresh box.
class InstallStateUnknownError extends Error {
    constructor(cause) {
        super(`database unreachable while resolving install state: ${cause.message}`);
        this.name = 'InstallStateUnknownError';
        this.cause = cause;
    }
}

async function checkInstallStatus() {
    // No DB configured at all — genuinely a fresh box, not a failure.
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
        // DB_HOST and DB_NAME ARE set, so this box was configured — the query
        // failing means the database is down, not that we need an installer.
        // Swallowing this into `false` made a transient DB outage at boot look
        // exactly like a fresh install: every path served the neutral 503 and
        // the installer surface came back, with a log line reading
        // "FIRST-RUN INSTALL" instead of naming the real fault. The latch is
        // resolved once at boot and never re-checked, so that state persisted
        // for the life of the process.
        throw new InstallStateUnknownError(err);
    }
}

// Resolve the latch once, at boot, before the server listens.
async function resolveInstallState() {
    installed = await checkInstallStatus();
    return installed;
}

function isInstalled() {
    return installed === true;
}

function rejectInstallRoute(req, res) {
    // Both branches set Cache-Control explicitly. checkInstalled runs at
    // app-level before the /api no-store middleware in server.js, so a
    // bare res.json here would otherwise go out with no cache header.
    if (req.path.startsWith('/api/install')) {
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

// The neutral pre-install response for anything not explicitly allowed — the
// SAME page an attacker sees at /install without a token, so the installer is
// never advertised. (The old gate redirected every path to /install, which told
// the whole internet exactly where to take the box over.)
function serveUnavailable(req, res) {
    res.set('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/')) {
        return res.status(503).json({ error: 'unavailable' });
    }
    res.status(503).type('html').send(
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Service unavailable</title><style>' +
        "*{box-sizing:border-box}html,body{margin:0}" +
        "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;" +
        'background:#f0f2f5;color:#333;font-size:14px;line-height:1.5;min-height:100vh;' +
        'display:flex;align-items:center;justify-content:center;padding:24px}' +
        '.card{background:#fff;border:1px solid #eef0f2;border-radius:12px;padding:28px 26px;' +
        'max-width:400px;width:100%;text-align:center}' +
        'h1{font-size:18px;font-weight:500;color:#1f2937;margin:0 0 6px}' +
        'p{font-size:13.5px;color:#6b7280;margin:0;line-height:1.55}' +
        '</style></head><body><div class="card"><h1>Service unavailable</h1>' +
        '<p>This service is temporarily unavailable. Please try again in a little while.</p>' +
        '</div></body></html>'
    );
}

// A valid token in the query string drops a cookie so the installer's own fetches
// (which live under a different path prefix) don't have to carry it in the URL.
function tokenOk(req, res) {
    const fromQuery = typeof req.query.token === 'string' ? req.query.token : undefined;
    const tok = fromQuery || (req.cookies && req.cookies.install_token);
    if (!verifyInstallToken(tok)) return false;
    if (fromQuery) {
        res.cookie('install_token', fromQuery, { httpOnly: true, sameSite: 'strict', path: '/' });
    }
    return true;
}

function checkInstalled(req, res, next) {
    // '/install.html' as well as '/install': the built installer page is a real
    // file in client/dist, so without this it falls through to the dist-root
    // static mount and is served 200 on a live site. Every endpoint it calls
    // already 404s, so this is not an exploitable surface — but the gate exists
    // to avoid ADVERTISING an installer at all, and a 200 here hands a scanner
    // exactly the fingerprint the neutral-503 design is meant to withhold.
    const isInstallRoute = req.path === '/install' || req.path === '/install.html' ||
        req.path.startsWith('/api/install');
    const isStaticRoute = req.path.startsWith('/assets') || req.path.startsWith('/css') ||
        req.path.startsWith('/js') || req.path.startsWith('/img') ||
        req.path === '/favicon.ico';

    // Always allow static files (the install page's own bundle lives here).
    if (isStaticRoute) return next();

    if (installed === true) {
        if (isInstallRoute) return rejectInstallRoute(req, res);
        return next();
    }

    // Not installed. Only the installer answers, and only with the token —
    // everything else, including a token-less /install, gets the neutral 503.
    if (isInstallRoute && tokenOk(req, res)) return next();
    return serveUnavailable(req, res);
}

function markInstalled() {
    installed = true;
}

function resetInstallCache() {
    installed = null;
}

module.exports = {
    InstallStateUnknownError,
    checkInstalled,
    markInstalled,
    resetInstallCache,
    resolveInstallState,
    isInstalled,
};
