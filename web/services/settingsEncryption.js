// At-rest encryption for sensitive site_settings rows.
//
// AES-256-GCM. Format:  enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
//
// The leading `enc:v1:` tag lets readers detect whether a row is encrypted
// without having to parse the rest, and reserves space for format / algo
// changes. Anything without the tag is treated as plaintext (back-compat
// during the migration window, and for not-yet-set secrets).
//
// Why a separate key from MFA_ENCRYPTION_KEY: different blast radius. The
// MFA key protects OTPs and TOTP shared secrets; this key protects HMAC
// playback secrets, the email-sender HMAC, and CF Access service token
// secrets. Rotating one shouldn't force rotating the other.
//
// The key must be set in process.env (loaded from .env at startup) before
// migrations run. Migration 035 throws with a generate-command in the
// error message if it's missing.

const crypto = require('crypto');
const { getSetting } = require('./cache/settingsCache');
// setSetting is required lazily inside setSecretSetting because
// tokenService.js depends on this module for getSecretSetting/
// setSecretSetting — a top-level require here would form a load-time
// circular dependency that resolves to an empty exports object.

const TAG = 'enc:v1:';

function getEncryptionKey() {
    const keyHex = process.env.SETTINGS_SECRET_ENCRYPTION_KEY;
    if (!keyHex) {
        throw new Error(
            'SETTINGS_SECRET_ENCRYPTION_KEY is not set. ' +
            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
            'and add it to .env.'
        );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
        throw new Error('SETTINGS_SECRET_ENCRYPTION_KEY must be a 64-char hex string (32 raw bytes).');
    }
    return Buffer.from(keyHex, 'hex');
}

// True if a value matches the tagged-ciphertext shape we write. Used by
// readers to decide whether to decrypt, and by the migration to skip rows
// that were already encrypted on a prior partial run.
function isEncrypted(value) {
    if (typeof value !== 'string') return false;
    if (!value.startsWith(TAG)) return false;
    const rest = value.slice(TAG.length);
    // iv_hex:tag_hex:ct_hex — each part lowercase hex, iv must be 32 chars
    // (16 bytes), tag must be 32 chars (16 bytes), ct must be non-empty.
    const m = rest.match(/^([0-9a-f]{32}):([0-9a-f]{32}):([0-9a-f]+)$/);
    return !!m;
}

function encryptSettingValue(plaintext) {
    if (typeof plaintext !== 'string') {
        throw new TypeError('encryptSettingValue expects a string');
    }
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let ct = cipher.update(plaintext, 'utf8', 'hex');
    ct += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${TAG}${iv.toString('hex')}:${tag}:${ct}`;
}

function decryptSettingValue(stored) {
    if (!isEncrypted(stored)) {
        // Back-compat: treat untagged values as plaintext. This makes the
        // wrappers safe during the migration window and for keys whose
        // rows pre-date encryption.
        return stored;
    }
    const rest = stored.slice(TAG.length);
    const [ivHex, tagHex, ctHex] = rest.split(':');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let pt = decipher.update(ctHex, 'hex', 'utf8');
    pt += decipher.final('utf8');
    return pt;
}

// Transparent getter: reads the cached site_settings blob (L1 memo + L2
// Redis + DB fallback), decrypts if tagged, otherwise returns as-is.
// Returns defaultValue when the key is absent.
async function getSecretSetting(key, defaultValue = null) {
    const stored = await getSetting(key, null);
    if (stored === null || stored === undefined) return defaultValue;
    return decryptSettingValue(stored);
}

// Transparent setter: encrypts then writes via setSetting, which purges
// the L1 memo + L2 Redis cache. Next read picks up the new value.
async function setSecretSetting(key, plaintext) {
    const { setSetting } = require('./tokenService');
    const stored = encryptSettingValue(plaintext);
    await setSetting(key, stored);
}

module.exports = {
    encryptSettingValue,
    decryptSettingValue,
    isEncrypted,
    getSecretSetting,
    setSecretSetting,
};
