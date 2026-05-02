const crypto = require('crypto');
const otplib = require('otplib');
const QRCode = require('qrcode');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { getPool } = require('../config/database');
const { sendEmail } = require('./emailService');
const mfaEmailTemplates = require('./mfaEmailTemplates');

// otplib v13+ uses top-level functions: generateSecret, generateSync, verifySync, generateURI

// ---------------------------------------------------------------------------
// Site settings helpers
// ---------------------------------------------------------------------------

async function getSetting(key, defaultValue) {
    return require('./cache/settingsCache').getSetting(key, defaultValue);
}

async function getMfaSettings() {
    // Pulled from the cached single-blob — filter mfa_* in memory.
    const all = await require('./cache/settingsCache').getAllSettings();
    const settings = {};
    for (const [k, v] of Object.entries(all)) {
        if (k.startsWith('mfa_')) settings[k] = v;
    }
    return settings;
}

async function getScenarioPolicy(scenario) {
    const raw = await getSetting('mfa_policy_' + scenario, null);
    if (!raw) {
        return { enabled: false, level: 0, scope: 'W', reuse: 'persistent' };
    }
    try {
        const parsed = JSON.parse(raw);
        // Migrate legacy 'session' → 'persistent'
        let reuse = parsed.reuse || 'persistent';
        if (reuse === 'session') reuse = 'persistent';
        return {
            enabled: parsed.enabled !== undefined ? parsed.enabled : false,
            level: parsed.level !== undefined ? parsed.level : 0,
            scope: parsed.scope || 'W',
            reuse
        };
    } catch {
        return { enabled: false, level: 0, scope: 'W', reuse: 'persistent' };
    }
}

function getAllowedMethodsForLevel(level) {
    if (level >= 2) return ['passkey'];
    if (level >= 1) return ['authenticator', 'passkey'];
    return ['email', 'authenticator', 'passkey'];
}

async function getLevelTimeoutSeconds(level) {
    const defaults = { 0: 604800, 1: 3600, 2: 600 };
    const raw = await getSetting(`mfa_level_${level}_timeout_seconds`, null);
    if (raw !== null) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) return parsed;
    }
    return defaults[level] !== undefined ? defaults[level] : 3600;
}

// ---------------------------------------------------------------------------
// Email masking
// ---------------------------------------------------------------------------

function maskEmail(email) {
    const atIdx = email.indexOf('@');
    if (atIdx < 0) return email;

    const local = email.substring(0, atIdx);
    const domain = email.substring(atIdx);

    if (local.length < 3) {
        return local.charAt(0) + '*'.repeat(Math.max(0, local.length - 1)) + domain;
    }

    return local.substring(0, 2) + '*'.repeat(local.length - 2) + domain;
}

// ---------------------------------------------------------------------------
// Challenge lifecycle
// ---------------------------------------------------------------------------

async function createChallenge({ userId, contextType, contextId, approvedEndpoint, mfaLevel, messageType, messageOperation, canReuse }) {
    const pool = getPool();

    const id = crypto.randomBytes(48).toString('base64url');
    const timeoutSeconds = parseInt(await getSetting('mfa_pending_challenge_timeout_seconds', '900'), 10) || 600;
    const allowedMethods = JSON.stringify(getAllowedMethodsForLevel(mfaLevel));

    const [result] = await pool.execute(
        `INSERT INTO mfa_challenges
         (id, user_id, context_type, context_id, approved_endpoint, mfa_level, allowed_methods,
          message_type, message_operation, can_reuse, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
        [id, userId, contextType, contextId, approvedEndpoint || null, mfaLevel, allowedMethods,
         messageType || null, messageOperation || null, canReuse ? 1 : 0, timeoutSeconds]
    );

    // Fetch the actual expires_at from MySQL
    const [[row]] = await pool.execute(
        'SELECT expires_at FROM mfa_challenges WHERE id = ?',
        [id]
    );

    return {
        id,
        allowedMethods: getAllowedMethodsForLevel(mfaLevel),
        expiresAt: row.expires_at,
        pendingTtlSeconds: timeoutSeconds
    };
}

async function getChallenge(challengeId) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        "SELECT * FROM mfa_challenges WHERE id = ? AND expires_at > NOW() AND status != 'expired'",
        [challengeId]
    );
    return row || null;
}

async function validateChallenge(challengeId, userId, contextId, requiredLevel, currentEndpoint) {
    const challenge = await getChallenge(challengeId);

    if (!challenge) {
        return { valid: false, reason: 'Challenge not found or expired' };
    }
    if (challenge.user_id !== userId) {
        return { valid: false, reason: 'User mismatch' };
    }
    if (challenge.context_id !== contextId) {
        return { valid: false, reason: 'Context mismatch' };
    }
    if (challenge.mfa_level < requiredLevel) {
        return { valid: false, reason: 'Insufficient MFA level' };
    }
    if (challenge.status !== 'verified') {
        return { valid: false, reason: 'Challenge not verified' };
    }
    // One-time challenges must match the exact endpoint they were approved for
    if (currentEndpoint && !challenge.can_reuse && challenge.approved_endpoint !== currentEndpoint) {
        return { valid: false, reason: 'Endpoint mismatch' };
    }

    return { valid: true, challenge };
}

async function markChallengeVerified(challengeId, method) {
    const pool = getPool();
    const challenge = await getChallenge(challengeId);
    if (!challenge) return;

    let timeout;
    if (!challenge.can_reuse) {
        // One-time challenge: use shorter dedicated TTL
        timeout = parseInt(await getSetting('mfa_onetime_challenge_timeout_seconds', '600'), 10) || 600;
    } else {
        // Reusable challenge: use level-based TTL
        timeout = await getLevelTimeoutSeconds(challenge.mfa_level);
    }

    await pool.execute(
        `UPDATE mfa_challenges
         SET status = 'verified', verified_method = ?, verified_at = NOW(),
             expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
         WHERE id = ?`,
        [method, timeout, challengeId]
    );
}

async function consumeChallenge(challengeId) {
    const pool = getPool();
    const challenge = await getChallenge(challengeId);
    if (!challenge) return;

    if (!challenge.can_reuse) {
        await pool.execute(
            "UPDATE mfa_challenges SET status = 'consumed' WHERE id = ?",
            [challengeId]
        );
    } else {
        await pool.execute(
            'UPDATE mfa_challenges SET used_count = used_count + 1 WHERE id = ?',
            [challengeId]
        );
    }
}

async function findValidLongStatus(userId, bmfaToken, requiredLevel) {
    const timeoutSeconds = await getLevelTimeoutSeconds(requiredLevel);
    const pool = getPool();

    const [rows] = await pool.execute(
        `SELECT * FROM mfa_challenges
         WHERE user_id = ? AND context_type = 'bmfa' AND context_id = ?
           AND status = 'verified' AND can_reuse = 1
           AND mfa_level >= ?
           AND verified_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
         LIMIT 1`,
        [userId, bmfaToken, requiredLevel, timeoutSeconds]
    );

    return rows[0] || null;
}

// ---------------------------------------------------------------------------
// OTP (email)
// ---------------------------------------------------------------------------

function generateOtp() {
    const num = crypto.randomInt(1000000);
    return String(num).padStart(6, '0');
}

function encryptOtp(code) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(code, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decryptOtp(encrypted) {
    if (!encrypted) return null;
    const parts = encrypted.split(':');
    if (parts.length !== 3) return null;
    try {
        const key = getEncryptionKey();
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(parts[2], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return null;
    }
}

// Issue an OTP for a challenge: reuse the existing code if it was generated
// recently and still has attempts left, otherwise mint a fresh one.
// Refreshes otp_sent_at on every call (used for verification expiry);
// otp_generated_at only moves forward when a new code is minted.
async function issueOtpForChallenge(challenge, challengeId) {
    const pool = getPool();
    const otpTimeoutSeconds = parseInt(await getSetting('mfa_otp_timeout_seconds', '300'), 10) || 300;

    if (challenge.otp_value && challenge.otp_generated_at && challenge.otp_attempts < 5) {
        const [[timeCheck]] = await pool.execute(
            `SELECT otp_generated_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) AS within_window
             FROM mfa_challenges WHERE id = ?`,
            [otpTimeoutSeconds, challengeId]
        );
        if (timeCheck && timeCheck.within_window) {
            const existing = decryptOtp(challenge.otp_value);
            if (existing !== null) {
                await pool.execute(
                    'UPDATE mfa_challenges SET otp_sent_at = NOW() WHERE id = ?',
                    [challengeId]
                );
                return existing;
            }
        }
    }

    const otp = generateOtp();
    const otpValue = encryptOtp(otp);
    await pool.execute(
        `UPDATE mfa_challenges
         SET otp_value = ?, otp_generated_at = NOW(), otp_sent_at = NOW(), otp_attempts = 0
         WHERE id = ?`,
        [otpValue, challengeId]
    );
    return otp;
}

async function checkOtpRateLimit(userId) {
    const pool = getPool();

    const [[row]] = await pool.execute(
        `SELECT total_sent,
                first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_expired,
                GREATEST(0, TIMESTAMPDIFF(SECOND, last_sent, NOW())) AS seconds_since_last
         FROM mfa_otp_rate_limits WHERE user_id = ?`,
        [userId]
    );

    // No record — allow
    if (!row) {
        return { allowed: true };
    }

    // Window expired — allow (will reset on send)
    if (row.is_expired) {
        return { allowed: true };
    }

    // Daily limit
    if (row.total_sent >= 10) {
        return { allowed: false, message: 'Daily limit reached' };
    }

    // Cooldown check (60 seconds between sends)
    const secondsSinceLast = row.seconds_since_last;
    if (secondsSinceLast < 60) {
        const retryAfter = 60 - secondsSinceLast;
        return {
            allowed: false,
            retryAfter,
            message: `Please wait ${retryAfter} seconds before requesting another code.`
        };
    }

    return { allowed: true };
}

async function sendOtpEmail(challengeId, userId) {
    // Check rate limit first
    const rateCheck = await checkOtpRateLimit(userId);
    if (!rateCheck.allowed) {
        return { success: false, ...rateCheck };
    }

    const pool = getPool();
    const challenge = await getChallenge(challengeId);
    if (!challenge) {
        return { success: false, message: 'Challenge not found or expired' };
    }

    const otp = await issueOtpForChallenge(challenge, challengeId);
    if (!otp) {
        return { success: false, message: 'Failed to issue OTP' };
    }

    // Get user email
    const [[user]] = await pool.execute(
        'SELECT email FROM users WHERE user_id = ?',
        [userId]
    );
    if (!user || !user.email) {
        return { success: false, message: 'User email not found' };
    }

    // Build email from template based on challenge.message_type
    const siteName = await getSetting('site_name', 'VideoSite');
    const otpTimeoutMin = Math.ceil(parseInt(await getSetting('mfa_otp_timeout_seconds', '300')) / 60);
    const templateBuilders = {
        login: () => mfaEmailTemplates.buildLoginOtpEmail(otp, siteName, otpTimeoutMin),
        password_reset: () => mfaEmailTemplates.buildPasswordResetOtpEmail(otp, siteName, otpTimeoutMin),
        mfa_change: () => mfaEmailTemplates.buildMfaChangeOtpEmail(otp, siteName, otpTimeoutMin, challenge.message_operation || 'Security change'),
        admin_operation: () => mfaEmailTemplates.buildAdminOperationOtpEmail(otp, siteName, otpTimeoutMin, challenge.message_operation || 'Admin action'),
        email_verification: () => mfaEmailTemplates.buildEmailVerificationOtpEmail(otp, siteName, otpTimeoutMin)
    };
    const builder = templateBuilders[challenge.message_type] || templateBuilders.login;
    const template = builder();

    const emailResult = await sendEmail({
        to: user.email,
        subject: template.subject,
        html: template.html,
        text: template.text
    });

    if (!emailResult.success) {
        return { success: false, message: 'Failed to send email' };
    }

    // Update rate limit record
    await updateOtpRateLimit(userId);

    return { success: true };
}

async function updateOtpRateLimit(userId) {
    const pool = getPool();

    const [[existing]] = await pool.execute(
        `SELECT total_sent,
                first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_expired
         FROM mfa_otp_rate_limits WHERE user_id = ?`,
        [userId]
    );

    if (!existing) {
        await pool.execute(
            'INSERT INTO mfa_otp_rate_limits (user_id, first_sent, last_sent, total_sent) VALUES (?, NOW(), NOW(), 1)',
            [userId]
        );
    } else if (existing.is_expired) {
        await pool.execute(
            'UPDATE mfa_otp_rate_limits SET first_sent = NOW(), last_sent = NOW(), total_sent = 1 WHERE user_id = ?',
            [userId]
        );
    } else {
        await pool.execute(
            'UPDATE mfa_otp_rate_limits SET last_sent = NOW(), total_sent = total_sent + 1 WHERE user_id = ?',
            [userId]
        );
    }
}

async function verifyOtp(challengeId, code) {
    const pool = getPool();
    const challenge = await getChallenge(challengeId);

    if (!challenge) {
        return { valid: false, reason: 'Challenge not found or expired' };
    }

    // Check if max attempts reached before even trying
    if (challenge.otp_attempts >= 5) {
        return { valid: false, mustResend: true };
    }

    // Increment attempts
    await pool.execute(
        'UPDATE mfa_challenges SET otp_attempts = otp_attempts + 1 WHERE id = ?',
        [challengeId]
    );
    const newAttempts = challenge.otp_attempts + 1;

    // Check OTP timeout
    const otpTimeoutSeconds = parseInt(await getSetting('mfa_otp_timeout_seconds', '300'), 10) || 300;
    const [[timeCheck]] = await pool.execute(
        `SELECT otp_sent_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) AS within_timeout
         FROM mfa_challenges WHERE id = ?`,
        [otpTimeoutSeconds, challengeId]
    );

    if (!timeCheck || !timeCheck.within_timeout) {
        return { valid: false, reason: 'Code expired', mustResend: true };
    }

    if (!challenge.otp_value) {
        return { valid: false, reason: 'No OTP issued' };
    }

    const stored = decryptOtp(challenge.otp_value);
    const isValid = stored !== null && stored === code;

    if (isValid) {
        await markChallengeVerified(challengeId, 'email');
        return { valid: true };
    }

    // Failed verification
    if (newAttempts >= 5) {
        return { valid: false, mustResend: true };
    }

    return { valid: false, attemptsRemaining: 5 - newAttempts };
}

// ---------------------------------------------------------------------------
// TOTP (authenticator) — AES-256-GCM encryption
// ---------------------------------------------------------------------------

function getEncryptionKey() {
    const keyHex = process.env.MFA_ENCRYPTION_KEY;
    if (!keyHex) {
        throw new Error('MFA_ENCRYPTION_KEY environment variable is not set');
    }
    return Buffer.from(keyHex, 'hex');
}

function encryptTotpSecret(secret) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(secret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decryptTotpSecret(encrypted) {
    const key = getEncryptionKey();
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted TOTP secret format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = parts[2];

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const MAX_AUTHENTICATORS = 5;
const MAX_PASSKEYS = 10;

async function generateTotpSetup(userId, label) {
    const pool = getPool();

    // Check authenticator cap
    const [[{ count }]] = await pool.execute(
        "SELECT COUNT(*) AS count FROM user_mfa_methods WHERE user_id = ? AND method_type = 'authenticator' AND is_active = 1",
        [userId]
    );
    if (count >= MAX_AUTHENTICATORS) {
        return { error: `Maximum of ${MAX_AUTHENTICATORS} authenticators allowed` };
    }

    const secret = otplib.generateSecret();
    const siteName = await getSetting('site_name', 'VideoSite');

    // Get username for the otpauth URI
    const [[user]] = await pool.execute(
        'SELECT username FROM users WHERE user_id = ?',
        [userId]
    );
    const accountName = user ? user.username : String(userId);

    const otpauthUri = otplib.generateURI({ label: accountName, issuer: siteName, secret, strategy: 'totp' });
    const qrDataUrl = await QRCode.toDataURL(otpauthUri);

    const encryptedSecret = encryptTotpSecret(secret);

    const [result] = await pool.execute(
        `INSERT INTO user_mfa_methods (user_id, method_type, totp_secret_encrypted, is_active, label)
         VALUES (?, 'authenticator', ?, 0, ?)`,
        [userId, encryptedSecret, label || null]
    );

    return {
        methodId: result.insertId,
        secret,
        otpauthUri,
        qrDataUrl
    };
}

async function confirmTotpSetup(userId, methodId, code) {
    const pool = getPool();

    const [[method]] = await pool.execute(
        "SELECT * FROM user_mfa_methods WHERE id = ? AND user_id = ? AND is_active = 0 AND method_type = 'authenticator'",
        [methodId, userId]
    );

    if (!method) {
        return { valid: false, reason: 'Method not found or already active' };
    }

    const secret = decryptTotpSecret(method.totp_secret_encrypted);
    const isValid = otplib.verifySync({ token: code, secret, epochTolerance: 30 }).valid;

    if (isValid) {
        await pool.execute(
            'UPDATE user_mfa_methods SET is_active = 1 WHERE id = ?',
            [methodId]
        );
        return { valid: true };
    }

    return { valid: false };
}

async function verifyTotp(userId, code) {
    const pool = getPool();

    const [methods] = await pool.execute(
        "SELECT * FROM user_mfa_methods WHERE user_id = ? AND method_type = 'authenticator' AND is_active = 1",
        [userId]
    );

    for (const method of methods) {
        const secret = decryptTotpSecret(method.totp_secret_encrypted);
        const isValid = otplib.verifySync({ token: code, secret, epochTolerance: 30 }).valid;
        if (isValid) {
            return true;
        }
    }

    return false;
}

// ---------------------------------------------------------------------------
// TOTP rate limiting
// ---------------------------------------------------------------------------

async function checkTotpRateLimit(userId) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        `SELECT attempt_count, TIMESTAMPDIFF(SECOND, first_attempt_at, NOW()) AS elapsed
         FROM mfa_totp_rate_limits WHERE user_id = ?`,
        [userId]
    );
    if (!row) return { allowed: true };
    if (row.elapsed >= 120) {
        await pool.execute(
            'UPDATE mfa_totp_rate_limits SET attempt_count = 0, first_attempt_at = NOW() WHERE user_id = ?',
            [userId]
        );
        return { allowed: true };
    }
    if (row.attempt_count >= 5) {
        return { allowed: false, retryAfterSeconds: 120 - row.elapsed };
    }
    return { allowed: true };
}

async function recordTotpFailedAttempt(userId) {
    const pool = getPool();
    await pool.execute(
        `INSERT INTO mfa_totp_rate_limits (user_id, attempt_count, first_attempt_at)
         VALUES (?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           attempt_count = IF(TIMESTAMPDIFF(SECOND, first_attempt_at, NOW()) >= 120, 1, attempt_count + 1),
           first_attempt_at = IF(TIMESTAMPDIFF(SECOND, first_attempt_at, NOW()) >= 120, NOW(), first_attempt_at)`,
        [userId]
    );
}

async function clearTotpRateLimit(userId) {
    const pool = getPool();
    await pool.execute('DELETE FROM mfa_totp_rate_limits WHERE user_id = ?', [userId]);
}

// ---------------------------------------------------------------------------
// Passkey (WebAuthn)
// ---------------------------------------------------------------------------

async function getWebAuthnConfig() {
    const hostname = await getSetting('site_hostname', 'localhost');
    const siteName = await getSetting('site_name', 'VideoSite');
    const protocol = await getSetting('site_protocol', 'https');

    return {
        rpID: hostname,
        rpName: siteName,
        origin: protocol + '://' + hostname
    };
}

async function generatePasskeyRegOptions(userId, challengeId) {
    const pool = getPool();
    const config = await getWebAuthnConfig();

    // Check passkey cap
    const [[{ count }]] = await pool.execute(
        "SELECT COUNT(*) AS count FROM user_mfa_methods WHERE user_id = ? AND method_type = 'passkey' AND is_active = 1",
        [userId]
    );
    if (count >= MAX_PASSKEYS) {
        return { error: `Maximum of ${MAX_PASSKEYS} passkeys allowed` };
    }

    // Get user info
    const [[user]] = await pool.execute(
        'SELECT username FROM users WHERE user_id = ?',
        [userId]
    );
    if (!user) {
        throw new Error('User not found');
    }

    // Get existing passkeys to exclude
    const [existingPasskeys] = await pool.execute(
        "SELECT credential_id, transports FROM user_mfa_methods WHERE user_id = ? AND method_type = 'passkey' AND is_active = 1",
        [userId]
    );

    const excludeCredentials = existingPasskeys.map(pk => ({
        id: pk.credential_id,
        transports: pk.transports ? JSON.parse(pk.transports) : undefined
    }));

    const options = await generateRegistrationOptions({
        rpName: config.rpName,
        rpID: config.rpID,
        userID: new TextEncoder().encode(String(userId)),
        userName: user.username,
        excludeCredentials,
        authenticatorSelection: {
            // 'required' (not 'preferred') so every new passkey is a
            // discoverable credential — needed for the username-less "quick
            // sign in" flow. Authenticators that can't store discoverable
            // creds (mostly old YubiKey 4-series and U2F-only keys) will
            // fail registration; in 2026 this is essentially zero modern
            // devices. Existing 'preferred'-era passkeys are unaffected and
            // most are discoverable in practice.
            residentKey: 'required',
            userVerification: 'required'
        }
    });

    // Store the WebAuthn challenge for server-side verification
    if (challengeId) {
        await pool.execute(
            'UPDATE mfa_challenges SET webauthn_challenge = ? WHERE id = ?',
            [options.challenge, challengeId]
        );
    }

    return options;
}

async function verifyPasskeyRegistration(userId, credential, challengeId) {
    const pool = getPool();
    const config = await getWebAuthnConfig();

    // Retrieve stored challenge from DB
    const challenge = await getChallenge(challengeId);
    if (!challenge || !challenge.webauthn_challenge) {
        return { valid: false, reason: 'Challenge not found or expired' };
    }

    const verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challenge.webauthn_challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID
    });

    if (!verification.verified || !verification.registrationInfo) {
        return { valid: false, reason: 'Verification failed' };
    }

    const cred = verification.registrationInfo.credential;

    const publicKeyBase64 = Buffer.from(cred.publicKey).toString('base64');
    const transports = cred.transports
        ? JSON.stringify(cred.transports)
        : null;

    const [result] = await pool.execute(
        `INSERT INTO user_mfa_methods
         (user_id, method_type, credential_id, public_key, sign_count, transports, is_active)
         VALUES (?, 'passkey', ?, ?, ?, ?, 1)`,
        [userId, cred.id, publicKeyBase64, cred.counter || 0, transports]
    );

    return { valid: true, methodId: result.insertId };
}

async function generatePasskeyAuthOptions(userId, challengeId) {
    const pool = getPool();
    const config = await getWebAuthnConfig();

    // Get user's active passkeys
    const [passkeys] = await pool.execute(
        "SELECT credential_id, transports FROM user_mfa_methods WHERE user_id = ? AND method_type = 'passkey' AND is_active = 1",
        [userId]
    );

    const allowCredentials = passkeys.map(pk => ({
        id: pk.credential_id,
        transports: pk.transports ? JSON.parse(pk.transports) : undefined
    }));

    const options = await generateAuthenticationOptions({
        allowCredentials,
        rpID: config.rpID,
        userVerification: 'required'
    });

    // Store the WebAuthn challenge in the mfa_challenge record
    await pool.execute(
        'UPDATE mfa_challenges SET webauthn_challenge = ? WHERE id = ?',
        [options.challenge, challengeId]
    );

    return options;
}

async function verifyPasskeyAuth(userId, challengeId, credential) {
    const pool = getPool();
    const config = await getWebAuthnConfig();

    // Get the stored WebAuthn challenge
    const challenge = await getChallenge(challengeId);
    if (!challenge) {
        return { valid: false, reason: 'Challenge not found or expired' };
    }

    // Find matching passkey by credential_id
    const [[passkey]] = await pool.execute(
        "SELECT * FROM user_mfa_methods WHERE user_id = ? AND credential_id = ? AND method_type = 'passkey' AND is_active = 1",
        [userId, credential.id]
    );

    if (!passkey) {
        return { valid: false, reason: 'Passkey not found' };
    }

    const publicKeyBuffer = Buffer.from(passkey.public_key, 'base64');

    const verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: challenge.webauthn_challenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: true,
        credential: {
            id: passkey.credential_id,
            publicKey: publicKeyBuffer,
            counter: passkey.sign_count
        }
    });

    if (!verification.verified) {
        return { valid: false, reason: 'Verification failed' };
    }

    // Update sign count and last used
    const newCounter = verification.authenticationInfo.newCounter;
    await pool.execute(
        'UPDATE user_mfa_methods SET sign_count = ?, last_used_at = NOW() WHERE id = ?',
        [newCounter, passkey.id]
    );

    // Mark challenge as verified
    await markChallengeVerified(challengeId, 'passkey');

    return { valid: true };
}

// ---------------------------------------------------------------------------
// Passkey-only ("quick sign in") — discoverable credential flow.
//
// Distinct from verifyPasskeyAuth above (which is the MFA second-factor
// step that already knows the user). Here we don't have a user yet — the
// authenticator returns a credential ID we look up to discover who's signing
// in. The challenge lives in Redis (passkeyChallengeCache), not in
// mfa_challenges, because mfa_challenges.user_id is NOT NULL.
// ---------------------------------------------------------------------------

async function generatePasskeyLoginOptions() {
    const passkeyChallengeCache = require('./cache/passkeyChallengeCache');
    const config = await getWebAuthnConfig();

    // Empty allowCredentials → discoverable flow. The OS / browser shows the
    // user a picker of credentials registered for this rpID and returns the
    // selected credential's ID + assertion. userVerification: 'required'
    // means the authenticator must verify the user (biometric / PIN), so a
    // successful assertion is MFA-strength on its own.
    const options = await generateAuthenticationOptions({
        rpID: config.rpID,
        userVerification: 'required',
        allowCredentials: []
    });

    const challengeHandle = await passkeyChallengeCache.create(options.challenge);
    return { challengeHandle, options };
}

// Returns { valid: true, userId } on success, or:
//   { valid: false, code: 'unknown_credential' }   — challenge expired, or
//                                                    credential not in DB
//   { valid: false, code: 'revoked' }              — credential row exists
//                                                    but is_active = 0
//   { valid: false, code: 'inactive_user' }        — owner's account is
//                                                    deactivated
//   { valid: false, code: 'verification_failed' }  — signature / counter /
//                                                    origin / rpID mismatch
//
// 'unknown_credential' is also returned for a missing/expired Redis handle
// — the client treats both as the same situation: this assertion can't be
// matched to anything, suggest manual passkey cleanup. (We don't leak a
// distinction between "challenge expired" and "credential not found";
// neither is exploitable but both look the same to the user.)
async function verifyPasskeyLoginAssertion(challengeHandle, credential) {
    const passkeyChallengeCache = require('./cache/passkeyChallengeCache');
    const userCache = require('./cache/userCache');
    const config = await getWebAuthnConfig();

    // One-shot consume — second attempt with the same handle gets null.
    const expectedChallenge = await passkeyChallengeCache.take(challengeHandle);
    if (!expectedChallenge) {
        return { valid: false, code: 'unknown_credential' };
    }

    if (!credential || typeof credential.id !== 'string') {
        return { valid: false, code: 'unknown_credential' };
    }

    const pool = getPool();

    // Look up by credential_id alone — uq_credential index gives O(1).
    // Fetch is_active separately so we can distinguish "no such credential"
    // from "credential exists but disabled".
    const [[passkey]] = await pool.execute(
        "SELECT id, user_id, public_key, sign_count, is_active FROM user_mfa_methods WHERE credential_id = ? AND method_type = 'passkey'",
        [credential.id]
    );

    if (!passkey) {
        return { valid: false, code: 'unknown_credential' };
    }
    if (!passkey.is_active) {
        return { valid: false, code: 'revoked' };
    }

    // Owner status: a passkey for a deactivated account must not log in.
    // userCache hits Redis first; cold-start falls back to DB.
    const userMeta = await userCache.getUserMeta(passkey.user_id);
    if (!userMeta || !userMeta.is_active) {
        return { valid: false, code: 'inactive_user' };
    }

    const publicKeyBuffer = Buffer.from(passkey.public_key, 'base64');

    let verification;
    try {
        verification = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpID,
            requireUserVerification: true,
            credential: {
                id: credential.id,
                publicKey: publicKeyBuffer,
                counter: passkey.sign_count
            }
        });
    } catch (err) {
        // verifyAuthenticationResponse throws on any structural / signature
        // problem — treat as a verification failure, not a server error.
        return { valid: false, code: 'verification_failed' };
    }

    if (!verification.verified) {
        return { valid: false, code: 'verification_failed' };
    }

    // Bump sign_count + last_used_at. Counter advancement is required by
    // WebAuthn spec for clone detection (matters for hardware keys; platform
    // authenticators usually report 0 always, which is also fine).
    const newCounter = verification.authenticationInfo.newCounter;
    await pool.execute(
        'UPDATE user_mfa_methods SET sign_count = ?, last_used_at = NOW() WHERE id = ?',
        [newCounter, passkey.id]
    );

    return { valid: true, userId: passkey.user_id };
}

// ---------------------------------------------------------------------------
// User MFA state
// ---------------------------------------------------------------------------

async function getUserMfaMethods(userId, includeInactive) {
    const pool = getPool();
    if (includeInactive) {
        const [rows] = await pool.execute(
            'SELECT id, method_type, label, is_active, created_at, last_used_at FROM user_mfa_methods WHERE user_id = ?',
            [userId]
        );
        return rows;
    }
    const [rows] = await pool.execute(
        'SELECT id, method_type, label, created_at, last_used_at FROM user_mfa_methods WHERE user_id = ? AND is_active = 1',
        [userId]
    );
    return rows;
}

async function updateMethodLastUsed(userId, methodType) {
    if (methodType === 'email') return;
    const pool = getPool();
    await pool.execute(
        'UPDATE user_mfa_methods SET last_used_at = NOW() WHERE user_id = ? AND method_type = ? AND is_active = 1',
        [userId, methodType]
    );
}

async function getUserMfaMethodTypes(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT DISTINCT method_type FROM user_mfa_methods WHERE user_id = ? AND is_active = 1',
        [userId]
    );
    return rows.map(r => r.method_type);
}

async function isUserMfaEnabled(userId) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        'SELECT mfa_enabled FROM users WHERE user_id = ?',
        [userId]
    );
    return !!(row && row.mfa_enabled);
}

async function enableUserMfa(userId) {
    const pool = getPool();

    // Check user has email
    const [[user]] = await pool.execute(
        'SELECT email FROM users WHERE user_id = ?',
        [userId]
    );
    if (!user || !user.email) {
        return { success: false, error: 'User must have an email address to enable MFA' };
    }

    // Email counts as a method — having an email is sufficient to enable MFA
    await pool.execute(
        'UPDATE users SET mfa_enabled = 1 WHERE user_id = ?',
        [userId]
    );

    return { success: true };
}

async function disableUserMfa(userId, hasRequireMfaPermission) {
    if (hasRequireMfaPermission) {
        return { success: false, error: 'Cannot disable MFA while your role requires it' };
    }

    const pool = getPool();
    await pool.execute(
        'UPDATE users SET mfa_enabled = 0 WHERE user_id = ?',
        [userId]
    );

    return { success: true };
}

async function removeMfaMethod(userId, methodId, hasRequireMfaPermission) {
    const pool = getPool();

    // Get active methods count
    const methods = await getUserMfaMethods(userId);

    // If this is the last method and user has require_mfa permission, refuse
    if (methods.length <= 1 && hasRequireMfaPermission) {
        return { success: false, error: 'Cannot remove the last MFA method while your role requires MFA' };
    }

    const [result] = await pool.execute(
        'DELETE FROM user_mfa_methods WHERE id = ? AND user_id = ?',
        [methodId, userId]
    );

    if (result.affectedRows === 0) {
        return { success: false, error: 'Method not found' };
    }

    // If that was the last active method, disable MFA
    const remaining = await getUserMfaMethods(userId);
    if (remaining.length === 0) {
        await pool.execute(
            'UPDATE users SET mfa_enabled = 0 WHERE user_id = ?',
            [userId]
        );
    }

    return { success: true };
}

async function resetUserMfa(userId) {
    const pool = getPool();

    await pool.execute(
        'UPDATE users SET mfa_enabled = 0 WHERE user_id = ?',
        [userId]
    );

    await pool.execute(
        'DELETE FROM user_mfa_methods WHERE user_id = ?',
        [userId]
    );

    await pool.execute(
        "DELETE FROM mfa_challenges WHERE user_id = ? AND status = 'pending'",
        [userId]
    );

    return { success: true };
}

// ---------------------------------------------------------------------------
// Highest method level
// ---------------------------------------------------------------------------

async function getHighestMethodLevel(userId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT DISTINCT method_type FROM user_mfa_methods WHERE user_id = ? AND is_active = 1',
        [userId]
    );
    const types = rows.map(r => r.method_type);
    if (types.includes('passkey')) return 2;
    if (types.includes('authenticator')) return 1;
    return 0;
}

// ---------------------------------------------------------------------------
// Send OTP to arbitrary email (for email verification flow)
// ---------------------------------------------------------------------------

async function sendOtpToEmail(challengeId, userId, targetEmail) {
    // Check rate limit first (still keyed on userId)
    const rateCheck = await checkOtpRateLimit(userId);
    if (!rateCheck.allowed) {
        return { success: false, ...rateCheck };
    }

    const pool = getPool();
    const challenge = await getChallenge(challengeId);
    if (!challenge) {
        return { success: false, message: 'Challenge not found or expired' };
    }

    const otp = await issueOtpForChallenge(challenge, challengeId);
    if (!otp) {
        return { success: false, message: 'Failed to issue OTP' };
    }

    // Build email from template based on challenge.message_type
    const siteName = await getSetting('site_name', 'VideoSite');
    const otpTimeoutMin = Math.ceil(parseInt(await getSetting('mfa_otp_timeout_seconds', '300')) / 60);
    const templateBuilders = {
        login: () => mfaEmailTemplates.buildLoginOtpEmail(otp, siteName, otpTimeoutMin),
        password_reset: () => mfaEmailTemplates.buildPasswordResetOtpEmail(otp, siteName, otpTimeoutMin),
        mfa_change: () => mfaEmailTemplates.buildMfaChangeOtpEmail(otp, siteName, otpTimeoutMin, challenge.message_operation || 'Security change'),
        admin_operation: () => mfaEmailTemplates.buildAdminOperationOtpEmail(otp, siteName, otpTimeoutMin, challenge.message_operation || 'Admin action'),
        email_verification: () => mfaEmailTemplates.buildEmailVerificationOtpEmail(otp, siteName, otpTimeoutMin)
    };
    const builder = templateBuilders[challenge.message_type] || templateBuilders.login;
    const template = builder();

    const emailResult = await sendEmail({
        to: targetEmail,
        subject: template.subject,
        html: template.html,
        text: template.text
    });

    if (!emailResult.success) {
        return { success: false, message: 'Failed to send email' };
    }

    // Update rate limit record
    await updateOtpRateLimit(userId);

    return { success: true };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupExpiredChallenges() {
    try {
        const pool = getPool();
        const pendingTimeout = parseInt(await getSetting('mfa_pending_challenge_timeout_seconds', '900'), 10);
        const level0Timeout = parseInt(await getSetting('mfa_level_0_timeout_seconds', '604800'), 10);
        const level1Timeout = parseInt(await getSetting('mfa_level_1_timeout_seconds', '3600'), 10);
        const level2Timeout = parseInt(await getSetting('mfa_level_2_timeout_seconds', '600'), 10);

        // Pending challenges: created_at + pending timeout
        await pool.execute(
            "DELETE FROM mfa_challenges WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)",
            [pendingTimeout]
        );

        // Verified/consumed challenges: verified_at + level timeout
        await pool.execute(
            `DELETE FROM mfa_challenges
             WHERE status IN ('verified', 'consumed')
               AND verified_at IS NOT NULL
               AND CASE mfa_level
                   WHEN 0 THEN verified_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
                   WHEN 1 THEN verified_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
                   ELSE verified_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
               END`,
            [level0Timeout, level1Timeout, level2Timeout]
        );
    } catch (err) {
        console.error('MFA challenge cleanup error:', err.message);
    }
}

async function cleanupExpiredOtpRateLimits() {
    try {
        const pool = getPool();
        await pool.execute(
            'DELETE FROM mfa_otp_rate_limits WHERE first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR)'
        );
    } catch (err) {
        console.error('MFA OTP rate limit cleanup error:', err.message);
    }
}

async function cleanupExpiredBmfa() {
    try {
        const pool = getPool();
        await pool.execute('DELETE FROM bmfa_tokens WHERE expires_at < NOW()');
    } catch (err) {
        console.error('BMFA cleanup error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// BMFA (Browser MFA identity) helpers
// ---------------------------------------------------------------------------

const BMFA_MAX_AGE_DAYS = 90;
const BMFA_ROTATION_THRESHOLD_DAYS = 45;

function getClientIpFromReq(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp;
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return req.socket.remoteAddress || null;
}

function setBmfaCookie(res, token) {
    res.cookie('bmfa', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: BMFA_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    });
}

async function ensureBmfa(req, res) {
    const pool = getPool();
    const existing = req.cookies['bmfa'];
    if (existing) {
        const [[row]] = await pool.execute(
            'SELECT token FROM bmfa_tokens WHERE token = ? AND expires_at > NOW()',
            [existing]
        );
        if (row) {
            // Refresh browser cookie maxAge to keep it alive
            setBmfaCookie(res, existing);
            return existing;
        }
    }
    const token = crypto.randomBytes(48).toString('hex');
    await pool.execute(
        'INSERT INTO bmfa_tokens (token, ip_address, user_agent, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
        [token, getClientIpFromReq(req), req.headers['user-agent'] || null, BMFA_MAX_AGE_DAYS]
    );
    setBmfaCookie(res, token);
    return token;
}

async function rotateBmfaIfNeeded(req, res, currentToken) {
    const pool = getPool();

    const [[row]] = await pool.execute(
        'SELECT created_at FROM bmfa_tokens WHERE token = ?',
        [currentToken]
    );
    if (!row) return currentToken;

    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs < BMFA_ROTATION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000) return currentToken;

    const newToken = crypto.randomBytes(48).toString('hex');
    await pool.execute(
        'INSERT INTO bmfa_tokens (token, ip_address, user_agent, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
        [newToken, getClientIpFromReq(req), req.headers['user-agent'] || null, BMFA_MAX_AGE_DAYS]
    );
    await pool.execute(
        "UPDATE mfa_challenges SET context_id = ? WHERE context_type = 'bmfa' AND context_id = ?",
        [newToken, currentToken]
    );
    await pool.execute('DELETE FROM bmfa_tokens WHERE token = ?', [currentToken]);
    setBmfaCookie(res, newToken);
    return newToken;
}

async function extendBmfaIfNeeded(bmfaToken, challengeExpiresAt) {
    const pool = getPool();
    await pool.execute(
        'UPDATE bmfa_tokens SET expires_at = ? WHERE token = ? AND expires_at < ?',
        [challengeExpiresAt, bmfaToken, challengeExpiresAt]
    );
}

async function cleanupExpiredTotpRateLimits() {
    try {
        const pool = getPool();
        await pool.execute(
            'DELETE FROM mfa_totp_rate_limits WHERE first_attempt_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)'
        );
    } catch (err) {
        console.error('TOTP rate limit cleanup error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    // Settings helpers
    getSetting,
    getMfaSettings,
    getScenarioPolicy,
    getAllowedMethodsForLevel,
    getLevelTimeoutSeconds,

    // Email masking
    maskEmail,

    // Challenge lifecycle
    createChallenge,
    getChallenge,
    validateChallenge,
    markChallengeVerified,
    consumeChallenge,
    findValidLongStatus,

    // OTP (email)
    generateOtp,
    checkOtpRateLimit,
    sendOtpEmail,
    sendOtpToEmail,
    verifyOtp,

    // TOTP (authenticator)
    getEncryptionKey,
    encryptTotpSecret,
    decryptTotpSecret,
    generateTotpSetup,
    confirmTotpSetup,
    verifyTotp,
    checkTotpRateLimit,
    recordTotpFailedAttempt,
    clearTotpRateLimit,

    // Passkey (WebAuthn) — MFA second-factor flow (user already known)
    getWebAuthnConfig,
    generatePasskeyRegOptions,
    verifyPasskeyRegistration,
    generatePasskeyAuthOptions,
    verifyPasskeyAuth,

    // Passkey (WebAuthn) — discoverable / username-less login
    generatePasskeyLoginOptions,
    verifyPasskeyLoginAssertion,

    // User MFA state
    getHighestMethodLevel,
    getUserMfaMethods,
    getUserMfaMethodTypes,
    updateMethodLastUsed,
    isUserMfaEnabled,
    enableUserMfa,
    disableUserMfa,
    removeMfaMethod,
    resetUserMfa,

    // BMFA helpers
    ensureBmfa,
    rotateBmfaIfNeeded,
    extendBmfaIfNeeded,

    // Cleanup
    cleanupExpiredChallenges,
    cleanupExpiredOtpRateLimits,
    cleanupExpiredBmfa,
    cleanupExpiredTotpRateLimits
};
