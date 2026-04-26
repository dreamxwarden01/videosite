const crypto = require('crypto');
const { getPool } = require('../config/database');
const { sendEmail } = require('./emailService');
const { createUser, usernameExists } = require('./userService');

// Backoff seconds by total_sent index: [0]=first send (no wait), [1]=60s, [2]=120s, [3]=180s, [4+]=240s
const BACKOFF_SECONDS = [0, 60, 120, 180, 240];
const MAX_EMAILS_PER_DAY = 5;
const TOKEN_REUSE_MINUTES = 5; // Resend same token within this window

// ---------------------------------------------------------------------------
// Site settings helpers
// ---------------------------------------------------------------------------

async function getSetting(key, defaultValue) {
    return require('./cache/settingsCache').getSetting(key, defaultValue);
}

async function checkRegistrationEnabled() {
    return (await getSetting('enable_registration', 'false')) === 'true';
}

async function checkInvitationRequired() {
    return (await getSetting('require_invitation_code', 'true')) === 'true';
}

async function getTokenValidityMinutes() {
    return parseInt(await getSetting('emailed_link_validity_minutes', '30')) || 30;
}

// ---------------------------------------------------------------------------
// Invitation code validation
// ---------------------------------------------------------------------------

async function validateInvitationCode(code) {
    // Generated codes are exactly 12 uppercase alphanumeric chars
    // (see generateInvitationCode below). Reject anything outside that
    // shape up front so we don't waste a DB roundtrip on garbage input.
    if (!code || !/^[A-Z0-9]{12}$/.test(code)) {
        return { valid: false, error: 'Invalid invitation code' };
    }

    const pool = getPool();
    const [[row]] = await pool.execute(
        'SELECT code FROM invitation_codes WHERE code = ? AND expires_at > NOW()',
        [code]
    );

    if (!row) {
        return { valid: false, error: 'Invalid or expired invitation code' };
    }

    return { valid: true };
}

// ---------------------------------------------------------------------------
// Email rate limiting
// ---------------------------------------------------------------------------

function getBackoffSeconds(totalSent) {
    if (totalSent >= BACKOFF_SECONDS.length) return BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
    return BACKOFF_SECONDS[totalSent];
}

async function checkEmailRateLimit(email) {
    const pool = getPool();

    // Use MySQL for all time comparisons to avoid timezone mismatch
    const [[row]] = await pool.execute(
        `SELECT total_sent,
                first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_expired,
                GREATEST(0, TIMESTAMPDIFF(SECOND, last_sent, NOW())) AS seconds_since_last
         FROM registration_email_limits WHERE email = ?`,
        [email]
    );

    // No record or zero sends — allow immediately
    if (!row || row.total_sent === 0) {
        return { allowed: true, backoff: 0 };
    }

    const totalSent = row.total_sent;

    // If first_sent > 24h ago, the window has expired — will reset on send
    if (row.is_expired) {
        return { allowed: true, backoff: 0 };
    }

    // Daily limit reached
    if (totalSent >= MAX_EMAILS_PER_DAY) {
        return {
            allowed: false,
            canRetry: false,
            message: 'You have reached the daily email limit. Please try again tomorrow.'
        };
    }

    // Backoff check
    const backoffSeconds = getBackoffSeconds(totalSent);
    const secondsSinceLast = row.seconds_since_last;
    if (secondsSinceLast < backoffSeconds) {
        const retryAfter = backoffSeconds - secondsSinceLast;
        return {
            allowed: false,
            canRetry: true,
            retryAfter,
            message: `Please wait ${retryAfter} seconds before requesting another email.`
        };
    }

    return { allowed: true, backoff: getBackoffSeconds(totalSent + 1) };
}

// ---------------------------------------------------------------------------
// Email uniqueness check
// ---------------------------------------------------------------------------

async function emailExists(email) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        'SELECT 1 FROM users WHERE email = ?',
        [email]
    );
    return !!row;
}

// ---------------------------------------------------------------------------
// Start registration (step 1)
// ---------------------------------------------------------------------------

async function startRegistration(email, invitationCode) {
    const pool = getPool();

    // Check if pending registration exists for this email
    const [[existing]] = await pool.execute(
        'SELECT token, invitation_code, last_sent_at FROM pending_registrations WHERE email = ?',
        [email]
    );

    let token;
    let withinResendWindow = false;

    if (existing) {
        // Check resend window using MySQL to avoid timezone mismatch
        const [[resendCheck]] = await pool.execute(
            'SELECT last_sent_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE) AS within_window FROM pending_registrations WHERE email = ?',
            [TOKEN_REUSE_MINUTES, email]
        );
        withinResendWindow = resendCheck && resendCheck.within_window === 1;

        if (withinResendWindow) {
            // Reuse same token (protect against delivery delays)
            token = existing.token;
        } else {
            // Generate new token
            token = crypto.randomBytes(48).toString('hex');
            await pool.execute(
                'UPDATE pending_registrations SET token = ?, invitation_code = ?, created_at = NOW(), last_sent_at = NOW() WHERE email = ?',
                [token, invitationCode || null, email]
            );
        }
    } else {
        token = crypto.randomBytes(48).toString('hex');
    }

    // If the same invitation code is being used for a different email, invalidate the old one
    if (invitationCode) {
        await pool.execute(
            'DELETE FROM pending_registrations WHERE invitation_code = ? AND email != ?',
            [invitationCode, email]
        );
    }

    // Upsert pending registration
    if (!existing) {
        await pool.execute(
            `INSERT INTO pending_registrations (email, token, invitation_code, created_at, last_sent_at)
             VALUES (?, ?, ?, NOW(), NOW())`,
            [email, token, invitationCode || null]
        );
    } else if (!withinResendWindow) {
        // Token + created_at already updated above
    } else {
        // Resend window — update last_sent_at only
        await pool.execute(
            'UPDATE pending_registrations SET last_sent_at = NOW() WHERE email = ?',
            [email]
        );
    }

    // Send the email
    const siteName = await getSetting('site_name', 'VideoSite');
    const validityMinutes = await getTokenValidityMinutes();
    const protocol = await getSetting('site_protocol', 'https');
    const hostname = await getSetting('site_hostname', 'localhost');
    const emailResult = await sendRegistrationEmail(email, token, siteName, validityMinutes, protocol, hostname);

    if (!emailResult.success) {
        // If we just reset the rate limit counter, leave total_sent at 0
        return { success: false, message: emailResult.message };
    }

    // Update rate limit record on successful send
    await updateRateLimitOnSuccess(email);

    // Calculate next backoff for the response
    const [[rlRow]] = await pool.execute(
        'SELECT total_sent FROM registration_email_limits WHERE email = ?',
        [email]
    );
    const nextBackoff = getBackoffSeconds(rlRow ? rlRow.total_sent : 1);

    return { success: true, resendBackoff: nextBackoff };
}

async function updateRateLimitOnSuccess(email) {
    const pool = getPool();

    // Use MySQL NOW() for all timestamps to avoid timezone mismatch
    const [[existing]] = await pool.execute(
        'SELECT total_sent, first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR) AS is_expired FROM registration_email_limits WHERE email = ?',
        [email]
    );

    if (!existing) {
        await pool.execute(
            'INSERT INTO registration_email_limits (email, first_sent, last_sent, total_sent) VALUES (?, NOW(), NOW(), 1)',
            [email]
        );
    } else if (existing.is_expired || existing.total_sent === 0) {
        // Reset window
        await pool.execute(
            'UPDATE registration_email_limits SET first_sent = NOW(), last_sent = NOW(), total_sent = 1 WHERE email = ?',
            [email]
        );
    } else {
        await pool.execute(
            'UPDATE registration_email_limits SET last_sent = NOW(), total_sent = total_sent + 1 WHERE email = ?',
            [email]
        );
    }
}

async function sendRegistrationEmail(email, token, siteName, validityMinutes, protocol, hostname) {
    const baseUrl = `${protocol}://${hostname}`;
    const link = `${baseUrl}/register/continue?email=${encodeURIComponent(email)}&token=${token}`;

    const subject = `Continue to register on ${siteName}`;

    const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
            <h2 style="color: #333; margin-bottom: 24px;">Welcome to ${escapeHtml(siteName)}</h2>
            <p style="color: #555; line-height: 1.6;">
                You are receiving this email because an account registration was initiated with this email address on <strong>${escapeHtml(siteName)}</strong>.
            </p>
            <p style="margin: 28px 0;">
                <a href="${link}" style="display: inline-block; padding: 12px 28px; background: #1a73e8; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
                    Continue Registration
                </a>
            </p>
            <p style="color: #555; line-height: 1.6;">
                This link will expire in ${validityMinutes} minutes.
            </p>
            <p style="color: #888; font-size: 13px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 16px;">
                If you did not request this, no further action is required. You can safely ignore this email.
            </p>
        </div>
    `;

    const text = [
        `Welcome to ${siteName}`,
        '',
        `You are receiving this email because an account registration was initiated with this email address on ${siteName}.`,
        '',
        `Click the link below to continue your registration:`,
        link,
        '',
        `This link will expire in ${validityMinutes} minutes.`,
        '',
        `If you did not request this, no further action is required.`
    ].join('\n');

    return sendEmail({ to: email, subject, html, text });
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Validate registration token (for /register/continue)
// ---------------------------------------------------------------------------

async function validateRegistrationToken(email, token) {
    const pool = getPool();
    const validityMinutes = await getTokenValidityMinutes();

    // Let MySQL handle the time comparison to avoid timezone mismatch between Node.js and MySQL
    const [[row]] = await pool.execute(
        `SELECT email, token, invitation_code FROM pending_registrations
         WHERE email = ? AND token = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
        [email, token, validityMinutes]
    );

    if (!row) {
        return { valid: false };
    }

    return { valid: true, invitationCode: row.invitation_code };
}

// ---------------------------------------------------------------------------
// Password validation
// ---------------------------------------------------------------------------

function validatePassword(password) {
    if (!password || password.length < 8) {
        return { valid: false, error: 'Password must be at least 8 characters long' };
    }

    if (password.includes(' ')) {
        return { valid: false, error: 'Password cannot contain spaces' };
    }

    let categories = 0;
    if (/[A-Z]/.test(password)) categories++;
    if (/[a-z]/.test(password)) categories++;
    if (/[0-9]/.test(password)) categories++;
    if (/[^A-Za-z0-9]/.test(password)) categories++;

    if (categories < 3) {
        return { valid: false, error: 'Password must include at least 3 of: uppercase letters, lowercase letters, digits, special characters' };
    }

    return { valid: true };
}

// ---------------------------------------------------------------------------
// Complete registration (step 2)
// ---------------------------------------------------------------------------

async function completeRegistration(email, token, username, displayName, password) {
    const pool = getPool();

    // Re-validate token (race condition protection)
    const tokenResult = await validateRegistrationToken(email, token);
    if (!tokenResult.valid) {
        return { success: false, errors: { _general: 'Registration link is invalid or has expired' } };
    }

    // Validate fields
    const errors = {};

    // Username: 3-20 chars, letters/digits/dashes/underscores only
    if (!username || !username.trim()) {
        errors.username = 'Username is required';
    } else if (username.trim().length < 3 || username.trim().length > 20) {
        errors.username = 'Username must be between 3 and 20 characters';
    } else if (!/^[A-Za-z0-9_-]+$/.test(username.trim())) {
        errors.username = 'Username can only contain letters, digits, dashes, and underscores';
    } else if (await usernameExists(username.trim())) {
        errors.username = 'This username is already taken';
    }

    // Display name: 1-30 chars, letters/digits/spaces only
    if (!displayName || !displayName.trim()) {
        errors.displayName = 'Display name is required';
    } else if (displayName.trim().length > 30) {
        errors.displayName = 'Display name must be 30 characters or fewer';
    } else if (!/^[A-Za-z0-9 ]+$/.test(displayName.trim())) {
        errors.displayName = 'Display name can only contain letters, digits, and spaces';
    }

    // Email uniqueness
    if (await emailExists(email)) {
        errors.email = 'This email address is already registered';
    }

    // Password
    const passwordResult = validatePassword(password);
    if (!passwordResult.valid) {
        errors.password = passwordResult.error;
    }

    if (Object.keys(errors).length > 0) {
        return { success: false, errors };
    }

    // Create user with configurable default role
    const defaultRole = parseInt(await getSetting('registration_default_role', '2')) || 2;
    const userId = await createUser(username.trim(), displayName.trim(), password, defaultRole, email);

    // Cleanup: pending registration, rate limit, invitation code
    await pool.execute('DELETE FROM pending_registrations WHERE email = ?', [email]);
    await pool.execute('DELETE FROM registration_email_limits WHERE email = ?', [email]);

    if (tokenResult.invitationCode) {
        await pool.execute('DELETE FROM invitation_codes WHERE code = ?', [tokenResult.invitationCode]);
    }

    return { success: true, userId };
}

// ---------------------------------------------------------------------------
// Hourly cleanup
// ---------------------------------------------------------------------------

async function cleanupExpiredRegistrations() {
    try {
        const pool = getPool();
        const validityMinutes = await getTokenValidityMinutes();

        // Delete expired pending registrations
        await pool.execute(
            `DELETE FROM pending_registrations WHERE created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
            [validityMinutes]
        );

        // Delete expired invitation codes
        await pool.execute(
            'DELETE FROM invitation_codes WHERE expires_at < NOW()'
        );

        // Delete stale rate limit records (>24h old)
        await pool.execute(
            'DELETE FROM registration_email_limits WHERE first_sent < DATE_SUB(NOW(), INTERVAL 24 HOUR)'
        );
    } catch (err) {
        console.error('Registration cleanup error:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Invitation code generation (for admin)
// ---------------------------------------------------------------------------

const CODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

async function generateInvitationCode(createdBy, validityHours = 72) {
    const pool = getPool();
    const maxRetries = 5;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const bytes = crypto.randomBytes(12);
        let code = '';
        for (let i = 0; i < 12; i++) {
            code += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
        }

        try {
            await pool.execute(
                'INSERT INTO invitation_codes (code, created_by, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
                [code, createdBy, validityHours]
            );
            // Fetch the actual expires_at from MySQL for the response
            const [[inserted]] = await pool.execute('SELECT expires_at FROM invitation_codes WHERE code = ?', [code]);
            return { code, expiresAt: inserted.expires_at };
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY' && attempt < maxRetries - 1) {
                continue; // Collision — retry
            }
            throw err;
        }
    }

    throw new Error('Failed to generate unique invitation code after multiple attempts');
}

async function listInvitationCodes(actingUserLevel) {
    const pool = getPool();
    const [rows] = await pool.execute(
        `SELECT ic.code, ic.created_at, ic.expires_at, ic.created_by,
                u.display_name AS creator_name, r.permission_level AS creator_level
         FROM invitation_codes ic
         LEFT JOIN users u ON ic.created_by = u.user_id
         LEFT JOIN roles r ON u.role_id = r.role_id
         WHERE r.permission_level >= ? OR ic.created_by IS NULL
         ORDER BY ic.created_at DESC`,
        [actingUserLevel]
    );
    return rows;
}

async function removeInvitationCode(code, actingUserId, actingUserLevel) {
    const pool = getPool();

    const [[row]] = await pool.execute(
        `SELECT ic.created_by, r.permission_level AS creator_level
         FROM invitation_codes ic
         LEFT JOIN users u ON ic.created_by = u.user_id
         LEFT JOIN roles r ON u.role_id = r.role_id
         WHERE ic.code = ?`,
        [code]
    );

    if (!row) {
        return { success: false, error: 'Invitation code not found or already used' };
    }

    // Can remove if: created by self, or creator has strictly higher permission_level (lower authority)
    const isOwnCode = row.created_by === actingUserId;
    const isLowerAuthority = row.creator_level !== null && row.creator_level > actingUserLevel;

    if (!isOwnCode && !isLowerAuthority) {
        return { success: false, error: 'You do not have permission to remove this code' };
    }

    const [result] = await pool.execute('DELETE FROM invitation_codes WHERE code = ?', [code]);
    if (result.affectedRows === 0) {
        return { success: false, error: 'Invitation code not found or already used' };
    }

    return { success: true };
}

module.exports = {
    checkRegistrationEnabled,
    checkInvitationRequired,
    getTokenValidityMinutes,
    validateInvitationCode,
    checkEmailRateLimit,
    emailExists,
    startRegistration,
    validateRegistrationToken,
    validatePassword,
    completeRegistration,
    cleanupExpiredRegistrations,
    generateInvitationCode,
    listInvitationCodes,
    removeInvitationCode
};
