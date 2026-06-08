const crypto = require('crypto');
const { getPool } = require('../config/database');

/**
 * HMAC Token Manager — Cloudflare WAF compatible (is_timed_hmac_valid_v0).
 *
 * Token format:
 *   verify={issuedAt}-{base64_mac}
 *
 *   issuedAt   — Unix timestamp (seconds) when the token was issued
 *   base64_mac — HMAC-SHA256 of "{path}{issuedAt}", standard Base64
 *
 * HMAC message construction (must match WAF rule):
 *   message = path + issuedAt          e.g. "/abc.../def.../123456/1484063787"
 *   (path first, timestamp appended — no separator between them)
 *
 * Validity enforcement:
 *   Cloudflare WAF rule calls is_timed_hmac_valid_v0(..., lifetime_seconds, now, 8)
 *   which blocks if now > issuedAt + lifetime_seconds.
 *   The lifetime_seconds is hardcoded in the WAF rule itself.
 *
 * The server stores a configurable "hmac_token_validity" setting (default 10800s / 3 hours)
 * that is passed to the player client so it can proactively refresh before Cloudflare
 * rejects the token. This value does NOT affect token generation — only client-side
 * refresh timing.
 */

// Default token validity hint for client-side refresh (seconds).
// Stored in site_settings as "hmac_token_validity"; changeable from admin UI.
const DEFAULT_TOKEN_VALIDITY_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Internal DB helpers
// ---------------------------------------------------------------------------

// Delegates to the cached layer — hot path: token generation runs on every
// playback start and every refresh-token call.
async function getSetting(key, defaultValue = null) {
    return require('./cache/settingsCache').getSetting(key, defaultValue);
}

async function setSetting(key, value) {
    const pool = getPool();
    await pool.execute(
        'INSERT INTO site_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, value]
    );
    await require('./cache/settingsCache').invalidate();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new HMAC secret key and persist it to site_settings.
 * @returns {string} 64-char hex secret key
 */
async function generateSecretKey() {
    const { setSecretSetting } = require('./settingsEncryption');
    const secret = crypto.randomBytes(32).toString('hex');
    await setSecretSetting('hmac_secret_key', secret);
    return secret;
}

/**
 * Generate a Cloudflare-compatible HMAC token for the given path prefix.
 *
 * Pass the /video/job/ prefix, e.g.:
 *   "/{hashedVideoId}/{jobId}/"
 * Not a specific filename — one token covers every file under that prefix.
 *
 * @param {string} path - Resource path prefix (79 chars for standard IDs)
 * @returns {string|null} Token "{issuedAt}-{base64_mac}", or null if not configured
 */
/**
 * Check if HMAC validation is enabled (master toggle).
 * @returns {boolean}
 */
async function isHmacEnabled() {
    const val = await getSetting('video_hmac_enabled');
    if (val === null) {
        // Legacy: setting doesn't exist yet — fall back to key existence
        return !!(await getSetting('hmac_secret_key'));
    }
    return val === 'true';
}

// Shared signing body. Caller supplies the full message string to MAC; we
// don't append the timestamp here so prefix-scope and file-scope tokens can
// each construct their own message format. Returns null when HMAC is
// disabled or the secret is missing — every signing path collapses to "no
// token" identically, which keeps the un-configured branch a no-op.
async function _sign(message) {
    const enabled = await isHmacEnabled();
    if (!enabled) return null;

    // Decrypts transparently if the row was encrypted by migration 035.
    // Untagged plaintext rows still work (back-compat for first-deploy).
    const { getSecretSetting } = require('./settingsEncryption');
    const secret = await getSecretSetting('hmac_secret_key');
    if (!secret) return null;

    return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

async function generateToken(path) {
    const issuedAt = Math.floor(Date.now() / 1000);
    // Cloudflare message format: path concatenated with timestamp (no separator)
    const mac = await _sign(`${path}${issuedAt}`);
    if (mac === null) return null;
    return `${issuedAt}-${mac}`;
}

/**
 * Generate a Cloudflare-compatible HMAC token for a specific file path.
 *
 * Unlike generateToken (which signs a prefix and grants access to every
 * file under it), this signs the full file path — the resulting token
 * validates against exactly one URL.
 *
 *   "/{hashedVideoId}/{jobId}/poster.jpg"
 *
 * The WAF rule extension for this scope is a second is_timed_hmac_valid_v0
 * call inside the existing rule, joined by `or`, using http.request.uri.path
 * directly (no substring). One secret, one validity setting, two MAC scopes.
 *
 * @param {string} fullPath - Complete resource path (no prefix scope)
 * @returns {string|null} Token "{issuedAt}-{base64_mac}", or null if not configured
 */
async function generateFileToken(fullPath) {
    const issuedAt = Math.floor(Date.now() / 1000);
    const mac = await _sign(`${fullPath}${issuedAt}`);
    if (mac === null) return null;
    return `${issuedAt}-${mac}`;
}

/**
 * Check if HMAC is configured (secret key exists in site_settings).
 * @returns {boolean}
 */
async function isHmacConfigured() {
    const secret = await getSetting('hmac_secret_key');
    return !!secret;
}

/**
 * Get the token validity hint (seconds) for the player client.
 * Falls back to DEFAULT_TOKEN_VALIDITY_SECONDS if not set.
 * @returns {number}
 */
async function getTokenValiditySeconds() {
    const val = await getSetting('video_hmac_token_validity');
    const parsed = parseInt(val, 10);
    return parsed > 0 ? parsed : DEFAULT_TOKEN_VALIDITY_SECONDS;
}

module.exports = {
    generateToken,
    generateFileToken,
    generateSecretKey,
    isHmacConfigured,
    isHmacEnabled,
    getTokenValiditySeconds,
    getSetting,
    setSetting,
    DEFAULT_TOKEN_VALIDITY_SECONDS
};
