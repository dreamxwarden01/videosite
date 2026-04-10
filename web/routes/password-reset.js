const express = require('express');
const router = express.Router();
const { createSession, getSessionMaxDays, deleteUserSessions } = require('../config/session');
const { SESSION_COOKIE, getClientIp } = require('../middleware/auth');
const { verifyTurnstileToken } = require('../services/turnstileService');
const { validatePassword } = require('../services/registrationService');
const { updateUser, getUserById } = require('../services/userService');
const { requestPasswordReset, validateResetToken, consumeResetToken } = require('../services/passwordResetService');
const mfaService = require('../services/mfaService');

// Simple email format check
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// POST /api/password-reset/request — send reset email
// ---------------------------------------------------------------------------
router.post('/api/password-reset/request', async (req, res) => {
    try {
        if (res.locals.user) {
            return res.status(400).json({ success: false, message: 'Already logged in.' });
        }

        const { email, turnstileToken } = req.body;
        const ip = getClientIp(req);

        // 1. Verify Turnstile
        const turnstileResult = await verifyTurnstileToken(turnstileToken, ip);
        if (!turnstileResult.success) {
            return res.status(422).json({
                success: false,
                errors: { turnstile: 'Human verification failed. Please try again.' }
            });
        }

        // 2. Validate email format
        if (!email || !isValidEmail(email)) {
            return res.status(422).json({
                success: false,
                errors: { email: 'Please enter a valid email address.' }
            });
        }

        const normalizedEmail = email.trim().toLowerCase();

        // 3. Fire-and-forget: look up user + send reset email in background
        //    Response returns immediately to avoid leaking timing differences
        //    between existing and non-existing emails.
        requestPasswordReset(normalizedEmail).catch(err => {
            console.error('Password reset background error:', err);
        });

        res.status(204).end();
    } catch (err) {
        console.error('Password reset request error:', err);
        res.status(500).json({
            success: false,
            message: 'An error occurred. Please try again later.'
        });
    }
});

// ---------------------------------------------------------------------------
// GET /api/password-reset/validate-token — check if token is valid
// ---------------------------------------------------------------------------
router.get('/api/password-reset/validate-token', async (req, res) => {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Missing reset token.'
            });
        }

        const result = await validateResetToken(token);
        if (!result.valid) {
            return res.status(422).json({
                success: false,
                message: 'This password reset link is invalid or has expired. Please request a new one.'
            });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Token validation error:', err);
        res.status(500).json({
            success: false,
            message: 'An error occurred while validating the reset link.'
        });
    }
});

// ---------------------------------------------------------------------------
// POST /api/password-reset/confirm — set new password
// ---------------------------------------------------------------------------
router.post('/api/password-reset/confirm', async (req, res) => {
    try {
        const { token, password, confirmPassword, mfaChallengeId } = req.body;

        // 1. Validate token
        const tokenResult = await validateResetToken(token);
        if (!tokenResult.valid) {
            return res.status(422).json({
                success: false,
                errors: { token: 'This password reset link is invalid or has expired. Please request a new one.' }
            });
        }

        const userId = tokenResult.userId;

        // 2. Validate passwords
        if (password !== confirmPassword) {
            return res.status(422).json({
                success: false,
                errors: { confirmPassword: 'Passwords do not match.' }
            });
        }

        const pwResult = validatePassword(password);
        if (!pwResult.valid) {
            return res.status(422).json({
                success: false,
                errors: { password: pwResult.error }
            });
        }

        // 3. Check if MFA is required
        const loginPolicy = await mfaService.getScenarioPolicy('login');
        const userMfaEnabled = await mfaService.isUserMfaEnabled(userId);

        let requireMfa = false;
        if (loginPolicy.enabled && userMfaEnabled) {
            const methodTypes = await mfaService.getUserMfaMethodTypes(userId);
            const hasLevel1 = methodTypes.includes('authenticator') || methodTypes.includes('passkey');
            if (hasLevel1) {
                requireMfa = true;
            }
        }

        if (requireMfa) {
            const bmfaToken = await mfaService.ensureBmfa(req, res);

            // Check if MFA was already completed (client sends mfaChallengeId on re-submit)
            if (mfaChallengeId) {
                const challenge = await mfaService.getChallenge(mfaChallengeId);
                if (challenge && challenge.status === 'verified' && challenge.user_id === userId && challenge.context_id === bmfaToken) {
                    // MFA completed — consume and proceed
                    await mfaService.consumeChallenge(mfaChallengeId);
                    await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);
                    // Fall through to password reset below
                } else {
                    return res.status(401).json({ error: 'MFA verification required.' });
                }
            } else {
                // Create challenge for MFA
                const challenge = await mfaService.createChallenge({
                    userId,
                    contextType: 'bmfa',
                    contextId: bmfaToken,
                    mfaLevel: 1,
                    messageType: 'password_reset',
                    messageOperation: 'Reset password',
                    canReuse: false
                });

                // Filter allowed methods to what user actually has (Level 1+ only)
                const methodTypes = await mfaService.getUserMfaMethodTypes(userId);
                const allowedMethods = challenge.allowedMethods.filter(m => methodTypes.includes(m));

                const user = await getUserById(userId);
                const maskedEmail = user.email ? mfaService.maskEmail(user.email) : null;

                return res.json({
                    success: false,
                    requireMFA: true,
                    challengeId: challenge.id,
                    allowedMethods,
                    maskedEmail,
                    pendingTtlSeconds: challenge.pendingTtlSeconds
                });
            }
        }

        // 4. Update password
        await updateUser(userId, { password });

        // 5. Consume token
        await consumeResetToken(token);

        // 6. Invalidate all existing sessions
        await deleteUserSessions(userId);

        // 7. Create new session
        const userAgent = req.headers['user-agent'] || null;
        const ip = getClientIp(req);
        const sessionId = await createSession(userId, userAgent, ip);
        const maxDays = await getSessionMaxDays();

        res.cookie(SESSION_COOKIE, sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: maxDays * 24 * 60 * 60 * 1000
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Password reset confirm error:', err);
        res.status(500).json({
            success: false,
            message: 'An error occurred. Please try again later.'
        });
    }
});

// ---------------------------------------------------------------------------
// MFA sub-endpoints for password reset
// ---------------------------------------------------------------------------

// Helper: validate challenge + bmfa for password reset MFA sub-endpoints
async function validatePwResetChallengeAndBmfa(req, res) {
    const { challengeId } = req.body;
    if (!challengeId) {
        res.status(401).json({ error: 'Session expired' });
        return null;
    }

    const challenge = await mfaService.getChallenge(challengeId);
    if (!challenge) {
        res.status(401).json({ error: 'Session expired' });
        return null;
    }

    const bmfaToken = await mfaService.ensureBmfa(req, res);
    if (challenge.context_id !== bmfaToken) {
        res.status(403).json({ error: 'Browser mismatch' });
        return null;
    }

    return { challenge, bmfaToken };
}

// POST /api/password-reset/mfa/send-otp
router.post('/api/password-reset/mfa/send-otp', async (req, res) => {
    try {
        const ctx = await validatePwResetChallengeAndBmfa(req, res);
        if (!ctx) return;

        const result = await mfaService.sendOtpEmail(ctx.challenge.id, ctx.challenge.user_id);

        if (!result.success) {
            if (result.retryAfter || result.message === 'Daily limit reached') {
                return res.status(429).json({ error: result.message, retryAfter: result.retryAfter || null });
            }
            return res.status(503).json({ error: result.message || 'Failed to send code' });
        }

        const otpTimeoutSeconds = parseInt(await mfaService.getSetting('mfa_otp_timeout_seconds', '300'));
        res.json({ success: true, otpValidityMinutes: Math.ceil(otpTimeoutSeconds / 60) });
    } catch (err) {
        console.error('Password reset MFA send-otp error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/password-reset/mfa/verify
router.post('/api/password-reset/mfa/verify', async (req, res) => {
    try {
        const ctx = await validatePwResetChallengeAndBmfa(req, res);
        if (!ctx) return;

        const { challengeId, method, code } = req.body;
        const userId = ctx.challenge.user_id;

        let result;
        if (method === 'email') {
            result = await mfaService.verifyOtp(challengeId, code);
        } else if (method === 'authenticator') {
            const rateCheck = await mfaService.checkTotpRateLimit(userId);
            if (!rateCheck.allowed) {
                return res.status(429).json({ error: 'Too many attempts', retryAfterSeconds: rateCheck.retryAfterSeconds });
            }
            const valid = await mfaService.verifyTotp(userId, code);
            if (valid) {
                await mfaService.clearTotpRateLimit(userId);
                await mfaService.markChallengeVerified(challengeId, 'authenticator');
                await mfaService.updateMethodLastUsed(userId, 'authenticator');
                result = { valid: true };
            } else {
                await mfaService.recordTotpFailedAttempt(userId);
                result = { valid: false };
            }
        } else if (method === 'passkey') {
            result = await mfaService.verifyPasskeyAuth(userId, challengeId, code);
        } else {
            return res.status(400).json({ error: 'Invalid method' });
        }

        if (result.valid) {
            // Mark verified but do NOT consume — the confirm endpoint will consume it
            // Do NOT create session — that happens in /confirm
            return res.json({ success: true });
        }

        const errorResponse = { valid: false };
        if (result.mustResend !== undefined) errorResponse.mustResend = result.mustResend;
        if (result.attemptsRemaining !== undefined) errorResponse.attemptsRemaining = result.attemptsRemaining;
        if (result.reason) errorResponse.error = result.reason;
        return res.status(422).json(errorResponse);
    } catch (err) {
        console.error('Password reset MFA verify error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/password-reset/mfa/passkey/auth-options
router.post('/api/password-reset/mfa/passkey/auth-options', async (req, res) => {
    try {
        const ctx = await validatePwResetChallengeAndBmfa(req, res);
        if (!ctx) return;

        const options = await mfaService.generatePasskeyAuthOptions(ctx.challenge.user_id, ctx.challenge.id);
        res.json(options);
    } catch (err) {
        console.error('Password reset passkey auth-options error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

module.exports = router;
