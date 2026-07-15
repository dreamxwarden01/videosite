// The installer is an unauthenticated takeover surface — it points the app at a
// database, an object store and an SSO. So it is gated by a token written to a
// file only someone with host access can read, exactly like the SSO's and the
// account portal's /setup. Generated on first boot when the app isn't installed;
// the path is logged for the operator and the token is burned on finish.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE =
    process.env.INSTALL_TOKEN_FILE || path.join(__dirname, '..', '.install-token');

let cached = null;

function ensureInstallToken() {
    if (cached) return cached;
    try {
        const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (existing) {
            cached = existing;
            return existing;
        }
    } catch {
        /* not present yet */
    }
    const tok = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, tok + '\n', { mode: 0o600 });
    cached = tok;
    return tok;
}

// Constant-time compare against the live token.
function verifyInstallToken(candidate) {
    if (typeof candidate !== 'string' || !candidate || !cached) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(cached);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clearInstallToken() {
    try {
        fs.unlinkSync(TOKEN_FILE);
    } catch {
        /* already gone */
    }
    cached = null;
}

module.exports = { ensureInstallToken, verifyInstallToken, clearInstallToken, TOKEN_FILE };
