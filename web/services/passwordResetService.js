const crypto = require('crypto');
const { getPool } = require('../config/database');
const { sendEmail } = require('./emailService');
const { getTokenValidityMinutes } = require('./registrationService');

// ---------------------------------------------------------------------------
// Rate limit constants
// ---------------------------------------------------------------------------
const BACKOFF_SECONDS = [0, 60, 120]; // 1st: immediate, 2nd: 60s, 3rd: 120s
const MAX_EMAILS_PER_DAY = 3;

function getBackoffSeconds(totalSent) {
    if (totalSent <= 0) return 0;
    return BACKOFF_SECONDS[Math.min(totalSent, BACKOFF_SECONDS.length - 1)];
}

// ---------------------------------------------------------------------------
// Helper — read a site setting
// ---------------------------------------------------------------------------
async function getSetting(key, defaultValue) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        'SELECT setting_value FROM site_settings WHERE setting_key = ?',
        [key]
    );
    return (row && row.setting_value) || defaultValue;
}

// ---------------------------------------------------------------------------
// Email rate limiting
// ---------------------------------------------------------------------------

async function checkEmailRateLimit(email) {
    const pool = getPool();

    const [[row]] = await pool.execute(
        `SELECT total_sent,
                first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_expired,
                GREATEST(0, TIMESTAMPDIFF(SECOND, last_sent, NOW())) AS seconds_since_last
         FROM password_reset_email_limits WHERE email = ?`,
        [email]
    );

    // No record — allow immediately
    if (!row || row.total_sent === 0) {
        return { allowed: true };
    }

    // 24h window expired — allow and will reset on success
    if (row.is_expired) {
        return { allowed: true };
    }

    // Daily limit reached — silent reject
    if (row.total_sent >= MAX_EMAILS_PER_DAY) {
        return { allowed: false, silent: true };
    }

    // Backoff check
    const backoffSeconds = getBackoffSeconds(row.total_sent);
    const secondsSinceLast = row.seconds_since_last;
    if (secondsSinceLast < backoffSeconds) {
        // Still in backoff — silent reject
        return { allowed: false, silent: true };
    }

    return { allowed: true };
}

async function updateRateLimitOnSuccess(email) {
    const pool = getPool();

    const [[existing]] = await pool.execute(
        'SELECT total_sent, first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_expired FROM password_reset_email_limits WHERE email = ?',
        [email]
    );

    if (!existing) {
        await pool.execute(
            'INSERT INTO password_reset_email_limits (email, first_sent, last_sent, total_sent) VALUES (?, NOW(), NOW(), 1)',
            [email]
        );
    } else if (existing.is_expired || existing.total_sent === 0) {
        await pool.execute(
            'UPDATE password_reset_email_limits SET first_sent = NOW(), last_sent = NOW(), total_sent = 1 WHERE email = ?',
            [email]
        );
    } else {
        await pool.execute(
            'UPDATE password_reset_email_limits SET last_sent = NOW(), total_sent = total_sent + 1 WHERE email = ?',
            [email]
        );
    }
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

async function generateResetToken(userId) {
    const pool = getPool();
    const token = crypto.randomBytes(48).toString('hex');

    // Remove any existing unused tokens for this user
    await pool.execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);

    await pool.execute(
        'INSERT INTO password_reset_tokens (token, user_id) VALUES (?, ?)',
        [token, userId]
    );

    return token;
}

async function validateResetToken(token) {
    if (!token || typeof token !== 'string') {
        return { valid: false };
    }

    const pool = getPool();
    const validityMinutes = await getTokenValidityMinutes();

    const [[row]] = await pool.execute(
        `SELECT token, user_id FROM password_reset_tokens
         WHERE token = ? AND used = 0
         AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
        [token, validityMinutes]
    );

    if (!row) {
        return { valid: false };
    }

    return { valid: true, userId: row.user_id };
}

async function consumeResetToken(token) {
    const pool = getPool();
    await pool.execute('UPDATE password_reset_tokens SET used = 1 WHERE token = ?', [token]);
}

// ---------------------------------------------------------------------------
// Email sending
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendPasswordResetEmail(email, token, siteName, validityMinutes, protocol, hostname) {
    const baseUrl = `${protocol}://${hostname}`;
    const link = `${baseUrl}/reset-password/confirm?token=${token}`;

    const subject = `Reset your password on ${siteName}`;

    const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
            <h2 style="color: #333; margin-bottom: 24px;">Reset Your Password</h2>
            <p style="color: #555; line-height: 1.6;">
                You are receiving this email because a password reset was requested for your account on <strong>${escapeHtml(siteName)}</strong>.
            </p>
            <p style="margin: 28px 0;">
                <a href="${link}" style="display: inline-block; padding: 12px 28px; background: #1a73e8; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
                    Reset Password
                </a>
            </p>
            <p style="color: #555; line-height: 1.6;">
                This link will expire in ${validityMinutes} minutes.
            </p>
            <p style="color: #888; font-size: 13px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 16px;">
                If you did not request this, no further action is required. Your password has not been changed.
            </p>
        </div>
    `;

    const text = [
        `Reset Your Password`,
        '',
        `You are receiving this email because a password reset was requested for your account on ${siteName}.`,
        '',
        `Click the link below to reset your password:`,
        link,
        '',
        `This link will expire in ${validityMinutes} minutes.`,
        '',
        `If you did not request this, no further action is required. Your password has not been changed.`
    ].join('\n');

    return sendEmail({ to: email, subject, html, text });
}

// ---------------------------------------------------------------------------
// Request flow (orchestrates lookup + rate limit + token + email)
// ---------------------------------------------------------------------------

async function requestPasswordReset(email) {
    const pool = getPool();

    // Look up user by email
    const [[user]] = await pool.execute(
        'SELECT user_id, email FROM users WHERE email = ? AND is_active = 1',
        [email]
    );

    if (!user) {
        // User not found — silently succeed
        return { sent: false, reason: 'no_user' };
    }

    // Check rate limit
    const rateResult = await checkEmailRateLimit(email);
    if (!rateResult.allowed) {
        return { sent: false, reason: 'rate_limited' };
    }

    // Generate token
    const token = await generateResetToken(user.user_id);

    // Send email
    const siteName = await getSetting('site_name', 'VideoSite');
    const validityMinutes = await getTokenValidityMinutes();
    const protocol = await getSetting('site_protocol', 'https');
    const hostname = await getSetting('site_hostname', 'localhost');

    const emailResult = await sendPasswordResetEmail(email, token, siteName, validityMinutes, protocol, hostname);

    if (!emailResult.success) {
        return { sent: false, reason: 'email_failed' };
    }

    // Update rate limit on successful send
    await updateRateLimitOnSuccess(email);

    return { sent: true };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupExpiredResetTokens() {
    try {
        const pool = getPool();
        const validityMinutes = await getTokenValidityMinutes();
        await pool.execute(
            'DELETE FROM password_reset_tokens WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)',
            [validityMinutes]
        );
    } catch (err) {
        console.error('Password reset token cleanup error:', err.message);
    }
}

async function cleanupExpiredResetRateLimits() {
    try {
        const pool = getPool();
        await pool.execute(
            'DELETE FROM password_reset_email_limits WHERE first_sent < DATE_SUB(NOW(), INTERVAL 48 HOUR)'
        );
    } catch (err) {
        console.error('Password reset rate limit cleanup error:', err.message);
    }
}

module.exports = {
    requestPasswordReset,
    validateResetToken,
    consumeResetToken,
    cleanupExpiredResetTokens,
    cleanupExpiredResetRateLimits
};
