const express = require('express');
const router = express.Router();
const { createSession, getSessionMaxDays } = require('../config/session');
const { SESSION_COOKIE, getClientIp } = require('../middleware/auth');
const { getPool } = require('../config/database');
const mfaService = require('../services/mfaService');

// Validate returnTo: must be a same-site relative path
function sanitizeReturnTo(returnTo) {
    if (!returnTo || typeof returnTo !== 'string') return '/';
    if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('://')) return '/';
    return returnTo;
}

// Validate challenge + bmfa match. Returns { challenge, bmfaToken } or sends error response.
async function validateChallengeAndBmfa(req, res) {
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

// Helper: create session and return success
async function finishEnrollment(req, res, userId) {
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

    return res.json({ success: true, returnTo: sanitizeReturnTo(req.body.returnTo) });
}

// POST /api/auth/mfa/send-otp
router.post('/api/auth/mfa/send-otp', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const result = await mfaService.sendOtpEmail(ctx.challenge.id, ctx.challenge.user_id);

        if (!result.success) {
            if (result.retryAfter || result.message === 'Daily limit reached') {
                return res.status(429).json({
                    error: result.message,
                    retryAfter: result.retryAfter || null
                });
            }
            return res.status(503).json({ error: result.message || 'Failed to send code' });
        }

        const otpTimeoutSeconds = parseInt(await mfaService.getSetting('mfa_otp_timeout_seconds', '300'));
        res.json({ success: true, otpValidityMinutes: Math.ceil(otpTimeoutSeconds / 60) });
    } catch (err) {
        console.error('MFA send-otp error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/verify
router.post('/api/auth/mfa/verify', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
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
            // Create full session
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

            await mfaService.consumeChallenge(challengeId);
            await mfaService.rotateBmfaIfNeeded(req, res, ctx.bmfaToken);

            return res.json({
                success: true,
                returnTo: sanitizeReturnTo(req.body.returnTo)
            });
        }

        // Failure — use 422 not 401 to avoid triggering auth redirect
        const errorResponse = { valid: false };
        if (result.mustResend !== undefined) errorResponse.mustResend = result.mustResend;
        if (result.attemptsRemaining !== undefined) errorResponse.attemptsRemaining = result.attemptsRemaining;
        if (result.reason) errorResponse.error = result.reason;
        return res.status(422).json(errorResponse);
    } catch (err) {
        console.error('MFA verify error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/passkey/auth-options
router.post('/api/auth/mfa/passkey/auth-options', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const options = await mfaService.generatePasskeyAuthOptions(ctx.challenge.user_id, ctx.challenge.id);
        res.json(options);
    } catch (err) {
        console.error('MFA passkey auth-options error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// ---- Enrollment flow (forced MFA setup at login) ----

// POST /api/auth/mfa/enrollment/start — determine what the user needs to do
router.post('/api/auth/mfa/enrollment/start', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const userId = ctx.challenge.user_id;
        const pool = getPool();
        const [[userRow]] = await pool.execute(
            'SELECT email FROM users WHERE user_id = ?',
            [userId]
        );

        if (!userRow || !userRow.email) {
            // No email — user must add one first
            return res.json({ phase: 'set-email' });
        }

        // Has email — create challenge with highest available method
        const highestLevel = await mfaService.getHighestMethodLevel(userId);

        const challenge = await mfaService.createChallenge({
            userId,
            contextType: 'bmfa',
            contextId: ctx.bmfaToken,
            mfaLevel: highestLevel,
            messageType: 'mfa_change',
            messageOperation: 'Enable MFA',
            canReuse: false
        });

        // Filter allowed methods to what the user actually has
        const methodTypes = await mfaService.getUserMfaMethodTypes(userId);
        const allowedMethods = challenge.allowedMethods.filter(m => {
            if (m === 'email') return true; // email is always available if user has email
            return methodTypes.includes(m);
        });

        const maskedEmail = mfaService.maskEmail(userRow.email);

        return res.json({
            phase: 'verify',
            challengeId: challenge.id,
            allowedMethods,
            maskedEmail
        });
    } catch (err) {
        console.error('MFA enrollment/start error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/enrollment/send-otp — send OTP for enrollment challenge
router.post('/api/auth/mfa/enrollment/send-otp', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
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
        console.error('MFA enrollment/send-otp error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/enrollment/verify — verify challenge, enable MFA, create session
router.post('/api/auth/mfa/enrollment/verify', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
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
            await mfaService.consumeChallenge(challengeId);
            await mfaService.enableUserMfa(userId);
            await mfaService.rotateBmfaIfNeeded(req, res, ctx.bmfaToken);
            return finishEnrollment(req, res, userId);
        }

        const errorResponse = { valid: false };
        if (result.mustResend !== undefined) errorResponse.mustResend = result.mustResend;
        if (result.attemptsRemaining !== undefined) errorResponse.attemptsRemaining = result.attemptsRemaining;
        if (result.reason) errorResponse.error = result.reason;
        return res.status(422).json(errorResponse);
    } catch (err) {
        console.error('MFA enrollment/verify error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/enrollment/passkey/auth-options — passkey auth options for enrollment
router.post('/api/auth/mfa/enrollment/passkey/auth-options', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const options = await mfaService.generatePasskeyAuthOptions(ctx.challenge.user_id, ctx.challenge.id);
        res.json(options);
    } catch (err) {
        console.error('MFA enrollment passkey auth-options error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/enrollment/email/start — add email during enrollment
router.post('/api/auth/mfa/enrollment/email/start', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const userId = ctx.challenge.user_id;
        const { email } = req.body;
        if (!email || typeof email !== 'string') {
            return res.status(422).json({ error: 'Email is required' });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(422).json({ error: 'Invalid email format' });
        }

        const normalizedEmail = email.toLowerCase();
        const pool = getPool();

        // Check email not already used
        const [[existing]] = await pool.execute(
            'SELECT user_id FROM users WHERE email = ? AND user_id != ?',
            [normalizedEmail, userId]
        );
        if (existing) {
            return res.status(422).json({ error: 'Email is already in use' });
        }

        // Check pending registrations
        const [[pendingReg]] = await pool.execute(
            `SELECT email FROM pending_registrations WHERE email = ?
             AND created_at >= DATE_SUB(NOW(), INTERVAL CAST(COALESCE(
                 (SELECT setting_value FROM site_settings WHERE setting_key = 'emailed_link_validity_minutes'), '30'
             ) AS UNSIGNED) MINUTE)`,
            [normalizedEmail]
        );
        if (pendingReg) {
            return res.status(422).json({ error: 'Email is already in use' });
        }

        // Create email verification challenge
        const challenge = await mfaService.createChallenge({
            userId,
            contextType: 'bmfa',
            contextId: ctx.bmfaToken,
            mfaLevel: 0,
            messageType: 'email_verification',
            messageOperation: normalizedEmail,
            canReuse: false
        });

        // Send OTP to the new email
        const result = await mfaService.sendOtpToEmail(challenge.id, userId, normalizedEmail);
        if (!result.success) {
            return res.status(503).json({ error: result.message || 'Failed to send verification code' });
        }

        const otpTimeoutSeconds = parseInt(await mfaService.getSetting('mfa_otp_timeout_seconds', '300'));
        const maskedEmail = mfaService.maskEmail(normalizedEmail);

        res.json({
            success: true,
            challengeId: challenge.id,
            maskedNewEmail: maskedEmail,
            otpValidityMinutes: Math.ceil(otpTimeoutSeconds / 60)
        });
    } catch (err) {
        console.error('MFA enrollment/email/start error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/enrollment/email/resend — resend email verification OTP
router.post('/api/auth/mfa/enrollment/email/resend', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const challenge = ctx.challenge;

        const result = await mfaService.sendOtpToEmail(challenge.id, challenge.user_id, challenge.message_operation);
        if (!result.success) {
            if (result.retryAfter || result.message === 'Daily limit reached') {
                return res.status(429).json({ error: result.message, retryAfter: result.retryAfter || null });
            }
            return res.status(503).json({ error: result.message || 'Failed to send code' });
        }

        const otpTimeoutSeconds = parseInt(await mfaService.getSetting('mfa_otp_timeout_seconds', '300'));
        res.json({ success: true, otpValidityMinutes: Math.ceil(otpTimeoutSeconds / 60) });
    } catch (err) {
        console.error('MFA enrollment/email/resend error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

// POST /api/auth/mfa/enrollment/email/confirm — verify OTP, set email, enable MFA, create session
router.post('/api/auth/mfa/enrollment/email/confirm', async (req, res) => {
    try {
        const ctx = await validateChallengeAndBmfa(req, res);
        if (!ctx) return;

        const { challengeId, code } = req.body;
        if (!code) {
            return res.status(422).json({ error: 'Code is required' });
        }

        const userId = ctx.challenge.user_id;

        const result = await mfaService.verifyOtp(challengeId, code);
        if (!result.valid) {
            const errorResponse = { error: result.reason || 'Invalid code' };
            if (result.mustResend !== undefined) errorResponse.mustResend = result.mustResend;
            if (result.attemptsRemaining !== undefined) errorResponse.attemptsRemaining = result.attemptsRemaining;
            return res.status(422).json(errorResponse);
        }

        // Read the new email from the challenge
        const challenge = await mfaService.getChallenge(challengeId);
        if (!challenge) {
            return res.status(400).json({ error: 'Challenge not found' });
        }
        const newEmail = challenge.message_operation;
        if (!newEmail) {
            return res.status(400).json({ error: 'No email found in challenge' });
        }

        // Re-check email uniqueness (race condition guard)
        const pool = getPool();
        const [[emailTaken]] = await pool.execute(
            'SELECT user_id FROM users WHERE email = ? AND user_id != ?',
            [newEmail, userId]
        );
        if (emailTaken) {
            return res.status(422).json({ error: 'Email is already in use. Please go back and try a different address.' });
        }

        // Set email on user
        await pool.execute('UPDATE users SET email = ? WHERE user_id = ?', [newEmail, userId]);
        await require('../services/cache/userCache').invalidate(userId);

        // Consume challenge and enable MFA
        await mfaService.consumeChallenge(challengeId);
        await mfaService.enableUserMfa(userId);
        await mfaService.rotateBmfaIfNeeded(req, res, ctx.bmfaToken);

        return finishEnrollment(req, res, userId);
    } catch (err) {
        console.error('MFA enrollment/email/confirm error:', err);
        res.status(500).json({ error: 'An error occurred' });
    }
});

module.exports = router;
