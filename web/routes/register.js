const express = require('express');
const router = express.Router();
const { verifyTurnstileToken } = require('../services/turnstileService');
const {
    checkRegistrationEnabled,
    checkInvitationRequired,
    validateInvitationCode,
    checkEmailRateLimit,
    emailExists,
    startRegistration,
    validateRegistrationToken,
    completeRegistration
} = require('../services/registrationService');
const { createSession, getSessionMaxDays } = require('../config/session');
const { SESSION_COOKIE, getClientIp } = require('../middleware/auth');

// Simple email format check
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /api/register/start — step 1 submit
router.post('/api/register/start', async (req, res) => {
    try {
        if (res.locals.user) {
            return res.status(400).json({ success: false, message: 'Already logged in.' });
        }

        const { email, invitationCode, turnstileToken } = req.body;
        const ip = getClientIp(req);

        // 1. Verify Turnstile
        const turnstileResult = await verifyTurnstileToken(turnstileToken, ip);
        if (!turnstileResult.success) {
            return res.status(422).json({
                success: false,
                errors: { turnstile: 'Human verification failed. Please try again.' }
            });
        }

        // 2. Check registration enabled
        if (!(await checkRegistrationEnabled())) {
            return res.status(403).json({
                success: false,
                message: 'Registration is currently closed.'
            });
        }

        // 3. Reject spaces
        if (email && /\s/.test(email)) {
            return res.status(422).json({ success: false, errors: { email: 'Spaces are not allowed.' } });
        }
        if (invitationCode && /\s/.test(invitationCode)) {
            return res.status(422).json({ success: false, errors: { invitationCode: 'Spaces are not allowed.' } });
        }

        // 4. Validate email format
        if (!email || !isValidEmail(email)) {
            return res.status(422).json({
                success: false,
                errors: { email: 'Please enter a valid email address.' }
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // 4. Validate invitation code (if required) — before email check to avoid leaking registration status
        const invitationRequired = await checkInvitationRequired();
        if (invitationRequired) {
            if (!invitationCode) {
                return res.status(422).json({
                    success: false,
                    errors: { invitationCode: 'Invitation code is required.' }
                });
            }
            const codeResult = await validateInvitationCode(invitationCode.toUpperCase());
            if (!codeResult.valid) {
                return res.status(422).json({
                    success: false,
                    errors: { invitationCode: codeResult.error }
                });
            }
        }

        // 5. Check if email already registered
        if (await emailExists(normalizedEmail)) {
            return res.status(422).json({
                success: false,
                errors: { email: 'This email address is already registered.' }
            });
        }

        // 6. Check email rate limit
        const rateResult = await checkEmailRateLimit(normalizedEmail);
        if (!rateResult.allowed) {
            return res.status(429).json({
                success: false,
                canRetry: rateResult.canRetry,
                retryAfter: rateResult.retryAfter || null,
                message: rateResult.message
            });
        }

        // 7. Start registration (generate token + send email)
        const result = await startRegistration(
            normalizedEmail,
            invitationRequired ? (invitationCode || '').toUpperCase() : null
        );

        if (!result.success) {
            return res.status(503).json({
                success: false,
                message: result.message || 'Failed to send verification email. Please try again later.'
            });
        }

        res.json({
            success: true,
            resend_backoff: result.resendBackoff
        });
    } catch (err) {
        console.error('Registration start error:', err);
        res.status(500).json({
            success: false,
            message: 'An error occurred. Please try again later.'
        });
    }
});

// GET /api/register/validate-token — check if token is valid (for SPA)
router.get('/api/register/validate-token', async (req, res) => {
    const { email, token } = req.query;

    if (!email || !token) {
        return res.status(400).json({
            success: false,
            message: 'Missing email or verification token.'
        });
    }

    try {
        if (!(await checkRegistrationEnabled())) {
            return res.status(403).json({
                success: false,
                message: 'Registration is currently closed.'
            });
        }

        const tokenResult = await validateRegistrationToken(email, token);
        if (!tokenResult.valid) {
            return res.status(422).json({
                success: false,
                message: 'This registration link is invalid or has expired. Please start the registration process again.'
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Token validation error:', err);
        res.status(500).json({
            success: false,
            message: 'An error occurred while validating the registration link.'
        });
    }
});

// POST /api/register/complete — step 2 submit
router.post('/api/register/complete', async (req, res) => {
    try {
        const { email, token, username, displayName, password, confirmPassword, turnstileToken } = req.body;
        const ip = getClientIp(req);

        // 1. Verify Turnstile
        const turnstileResult = await verifyTurnstileToken(turnstileToken, ip);
        if (!turnstileResult.success) {
            return res.status(422).json({
                success: false,
                errors: { turnstile: 'Human verification failed. Please try again.' }
            });
        }

        // 2. Check registration enabled
        if (!(await checkRegistrationEnabled())) {
            return res.status(403).json({
                success: false,
                message: 'Registration is currently closed.'
            });
        }

        // 3. Basic field checks
        if (!email || !token) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields.'
            });
        }
        if ((username && /\s/.test(username)) || (password && /\s/.test(password))) {
            return res.status(422).json({ success: false, errors: { username: 'Spaces are not allowed.' } });
        }

        // 4. Password confirmation
        if (password !== confirmPassword) {
            return res.status(422).json({
                success: false,
                errors: { confirmPassword: 'Passwords do not match.' }
            });
        }

        // 5. Complete registration (validates token, fields, creates user)
        const result = await completeRegistration(
            email.trim().toLowerCase(),
            token,
            username,
            displayName,
            password
        );

        if (!result.success) {
            return res.status(422).json({
                success: false,
                errors: result.errors
            });
        }

        // 6. Create session and set cookie (same as login)
        const userAgent = req.headers['user-agent'] || null;
        const sessionId = await createSession(result.userId, userAgent, ip);
        const maxDays = await getSessionMaxDays();

        res.cookie(SESSION_COOKIE, sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: maxDays * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            redirectTo: '/profile'
        });
    } catch (err) {
        console.error('Registration complete error:', err);
        res.status(500).json({
            success: false,
            message: 'An error occurred. Please try again later.'
        });
    }
});

module.exports = router;
