const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middleware/auth');
const { getPool } = require('../../config/database');
const mfaService = require('../../services/mfaService');

// All routes require authentication
router.use('/mfa', requireAuth);

// GET /api/mfa/methods — list user's active and inactive MFA methods
router.get('/mfa/methods', async (req, res) => {
    try {
        const user = res.locals.user;
        const methods = await mfaService.getUserMfaMethods(user.user_id, true);
        const mfaEnabled = await mfaService.isUserMfaEnabled(user.user_id);

        res.json({
            methods: methods.map(m => ({
                id: m.id,
                method_type: m.method_type,
                label: m.label,
                is_active: m.is_active,
                created_at: m.created_at,
                last_used_at: m.last_used_at || null,
            })),
            mfaEnabled,
        });
    } catch (err) {
        console.error('GET /mfa/methods error:', err);
        res.status(500).json({ error: 'Failed to load MFA methods' });
    }
});

// Helper: create a 403 challenge response for endpoints that need MFA
async function mfaChallengeResponse(req, res, user, operation) {
    const pool = getPool();
    const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);
    const bmfaToken = await mfaService.ensureBmfa(req, res);

    const [[userRow]] = await pool.execute(
        'SELECT email FROM users WHERE user_id = ?',
        [user.user_id]
    );

    const challenge = await mfaService.createChallenge({
        userId: user.user_id,
        contextType: 'bmfa',
        contextId: bmfaToken,
        mfaLevel: requiredLevel,
        messageType: 'mfa_change',
        messageOperation: operation,
        canReuse: false,
    });

    const maskedEmail = userRow && userRow.email ? mfaService.maskEmail(userRow.email) : null;
    const methodTypes = await mfaService.getUserMfaMethodTypes(user.user_id);
    const allowedMethods = challenge.allowedMethods.filter(m => {
        if (m === 'email') return !!(userRow && userRow.email);
        return methodTypes.includes(m);
    });

    return res.status(403).json({
        requireMFA: true,
        challengeId: challenge.id,
        allowedMethods,
        maskedEmail,
    });
}

// POST /api/mfa/methods/authenticator/setup — begin TOTP setup
router.post('/mfa/methods/authenticator/setup', async (req, res) => {
    try {
        const user = res.locals.user;
        const mfaEnabled = await mfaService.isUserMfaEnabled(user.user_id);

        if (mfaEnabled) {
            const challengeId = req.headers['x-mfa-challenge'];
            if (!challengeId) {
                return mfaChallengeResponse(req, res, user, 'Add authenticator');
            }
            const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);
            const bmfaToken = await mfaService.ensureBmfa(req, res);
            const validation = await mfaService.validateChallenge(challengeId, user.user_id, bmfaToken, requiredLevel);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge', requireMFA: true });
            }
            // Do NOT consume — will be consumed on confirm
        }

        // Delete all inactive methods for this user
        const pool = getPool();
        await pool.execute(
            'DELETE FROM user_mfa_methods WHERE user_id = ? AND is_active = 0',
            [user.user_id]
        );

        const label = req.body.label || 'Authenticator';
        const result = await mfaService.generateTotpSetup(user.user_id, label);

        if (result.error) {
            return res.status(422).json({ error: result.error });
        }

        res.json({
            methodId: result.methodId,
            secret: result.secret,
            otpauthUri: result.otpauthUri,
            qrDataUrl: result.qrDataUrl,
        });
    } catch (err) {
        console.error('POST /mfa/methods/authenticator/setup error:', err);
        res.status(500).json({ error: 'Failed to start authenticator setup' });
    }
});

// POST /api/mfa/methods/authenticator/confirm — confirm TOTP with 6-digit code
router.post('/mfa/methods/authenticator/confirm', async (req, res) => {
    try {
        const user = res.locals.user;
        const { methodId, code, label, challengeId } = req.body;

        if (!methodId || !code) {
            return res.status(422).json({ error: 'Method ID and code are required' });
        }

        const result = await mfaService.confirmTotpSetup(user.user_id, methodId, code);
        if (!result.valid) {
            return res.status(422).json({ error: result.reason || 'Invalid code. Please try again.' });
        }

        // Update label if provided
        if (label) {
            const pool = getPool();
            await pool.execute(
                'UPDATE user_mfa_methods SET label = ? WHERE id = ? AND user_id = ?',
                [label, methodId, user.user_id]
            );
        }

        // Consume the MFA challenge if one was provided
        if (challengeId) {
            await mfaService.consumeChallenge(challengeId);
        }

        res.status(204).end();
    } catch (err) {
        console.error('POST /mfa/methods/authenticator/confirm error:', err);
        res.status(500).json({ error: 'Failed to confirm authenticator' });
    }
});

// POST /api/mfa/methods/passkey/register-options — get WebAuthn registration options
router.post('/mfa/methods/passkey/register-options', async (req, res) => {
    try {
        const user = res.locals.user;
        const mfaEnabled = await mfaService.isUserMfaEnabled(user.user_id);

        let mfaChallengeId = null;
        const bmfaToken = await mfaService.ensureBmfa(req, res);
        if (mfaEnabled) {
            mfaChallengeId = req.headers['x-mfa-challenge'];
            if (!mfaChallengeId) {
                return mfaChallengeResponse(req, res, user, 'Add passkey');
            }
            const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);
            const validation = await mfaService.validateChallenge(mfaChallengeId, user.user_id, bmfaToken, requiredLevel);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge', requireMFA: true });
            }
            // Do NOT consume — will be consumed on register
        }

        // Delete all inactive methods for this user
        const pool = getPool();
        await pool.execute(
            'DELETE FROM user_mfa_methods WHERE user_id = ? AND is_active = 0',
            [user.user_id]
        );

        // Create a temporary challenge record to store the WebAuthn challenge server-side
        const regChallenge = await mfaService.createChallenge({
            userId: user.user_id,
            contextType: 'bmfa',
            contextId: bmfaToken,
            mfaLevel: 0,
            messageType: 'mfa_change',
            messageOperation: 'Register passkey',
            canReuse: false
        });

        const options = await mfaService.generatePasskeyRegOptions(user.user_id, regChallenge.id);
        if (options.error) {
            return res.status(422).json({ error: options.error });
        }
        res.json({ ...options, regChallengeId: regChallenge.id, mfaChallengeId });
    } catch (err) {
        console.error('POST /mfa/methods/passkey/register-options error:', err);
        res.status(500).json({ error: 'Failed to generate registration options' });
    }
});

// POST /api/mfa/methods/passkey/register — complete passkey registration
router.post('/mfa/methods/passkey/register', async (req, res) => {
    try {
        const user = res.locals.user;
        const { credential, label, challengeId, regChallengeId } = req.body;

        if (!credential) {
            return res.status(422).json({ error: 'Credential is required' });
        }
        if (!regChallengeId) {
            return res.status(422).json({ error: 'Registration challenge ID is required' });
        }

        const result = await mfaService.verifyPasskeyRegistration(user.user_id, credential, regChallengeId);
        if (!result.valid) {
            return res.status(422).json({ error: result.reason || 'Registration failed' });
        }

        // Consume the registration challenge
        await mfaService.consumeChallenge(regChallengeId);

        // Update label if provided
        if (label && result.methodId) {
            const pool = getPool();
            await pool.execute(
                'UPDATE user_mfa_methods SET label = ? WHERE id = ? AND user_id = ?',
                [label, result.methodId, user.user_id]
            );
        }

        // Consume the MFA challenge if one was provided
        if (challengeId) {
            await mfaService.consumeChallenge(challengeId);
        }

        res.status(204).end();
    } catch (err) {
        console.error('POST /mfa/methods/passkey/register error:', err);
        res.status(500).json({ error: 'Failed to register passkey' });
    }
});

// PUT /api/mfa/methods/:methodId/rename — rename an MFA method
router.put('/mfa/methods/:methodId/rename', async (req, res) => {
    try {
        const user = res.locals.user;
        const methodId = parseInt(req.params.methodId, 10);
        const { label } = req.body;
        const pool = getPool();

        if (!label || typeof label !== 'string' || !label.trim()) {
            return res.status(422).json({ error: 'Label is required' });
        }
        const trimmedLabel = label.trim().slice(0, 100);

        // Verify method belongs to user
        const [[method]] = await pool.execute(
            'SELECT id, is_active FROM user_mfa_methods WHERE id = ? AND user_id = ?',
            [methodId, user.user_id]
        );
        if (!method) {
            return res.status(404).json({ error: 'Method not found' });
        }

        // Level 0 challenge: check header first, then session-reuse, then create new
        const bmfaToken = await mfaService.ensureBmfa(req, res);
        const challengeId = req.headers['x-mfa-challenge'];
        if (challengeId) {
            const validation = await mfaService.validateChallenge(challengeId, user.user_id, bmfaToken, 0);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge', requireMFA: true });
            }
            await mfaService.consumeChallenge(challengeId);
            await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);
        } else {
            // Check for reusable bmfa challenge
            const reusable = await mfaService.findValidLongStatus(user.user_id, bmfaToken, 0);
            if (!reusable) {
                // No valid challenge — create one and return 403
                const [[userRow]] = await pool.execute(
                    'SELECT email FROM users WHERE user_id = ?',
                    [user.user_id]
                );
                const challenge = await mfaService.createChallenge({
                    userId: user.user_id,
                    contextType: 'bmfa',
                    contextId: bmfaToken,
                    mfaLevel: 0,
                    messageType: 'mfa_change',
                    messageOperation: 'Rename MFA method',
                    canReuse: false,
                });
                const maskedEmail = userRow && userRow.email ? mfaService.maskEmail(userRow.email) : null;
                const methodTypes = await mfaService.getUserMfaMethodTypes(user.user_id);
                const allowedMethods = challenge.allowedMethods.filter(m => {
                    if (m === 'email') return !!(userRow && userRow.email);
                    return methodTypes.includes(m);
                });
                return res.status(403).json({
                    requireMFA: true,
                    challengeId: challenge.id,
                    allowedMethods,
                    maskedEmail,
                });
            }
            // Reusable challenge found — proceed (don't consume reusable)
        }

        await pool.execute(
            'UPDATE user_mfa_methods SET label = ? WHERE id = ? AND user_id = ?',
            [trimmedLabel, methodId, user.user_id]
        );

        res.status(204).end();
    } catch (err) {
        console.error('PUT /mfa/methods/:methodId/rename error:', err);
        res.status(500).json({ error: 'Failed to rename method' });
    }
});

// DELETE /api/mfa/methods/:methodId — remove an MFA method
router.delete('/mfa/methods/:methodId', async (req, res) => {
    try {
        const user = res.locals.user;
        const methodId = parseInt(req.params.methodId, 10);
        const pool = getPool();

        // Check if the method is inactive — allow deletion without challenge
        const [[method]] = await pool.execute(
            'SELECT is_active FROM user_mfa_methods WHERE id = ? AND user_id = ?',
            [methodId, user.user_id]
        );

        if (!method) {
            return res.status(404).json({ error: 'Method not found' });
        }

        if (method.is_active === 1) {
            const mfaEnabled = await mfaService.isUserMfaEnabled(user.user_id);
            if (mfaEnabled) {
                // Require MFA challenge
                const challengeId = req.headers['x-mfa-challenge'];
                if (!challengeId) {
                    return mfaChallengeResponse(req, res, user, 'Remove MFA method');
                }
                const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);
                const bmfaToken = await mfaService.ensureBmfa(req, res);
                const validation = await mfaService.validateChallenge(challengeId, user.user_id, bmfaToken, requiredLevel);
                if (!validation.valid) {
                    return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge', requireMFA: true });
                }
                await mfaService.consumeChallenge(challengeId);
                await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);
            }

            const result = await mfaService.removeMfaMethod(user.user_id, methodId, !!user.permissions.requireMFA);
            if (!result.success) {
                return res.status(400).json({ error: result.error });
            }
        } else {
            // Inactive method — just delete it directly
            await pool.execute(
                'DELETE FROM user_mfa_methods WHERE id = ? AND user_id = ?',
                [methodId, user.user_id]
            );
        }

        res.status(204).end();
    } catch (err) {
        console.error('DELETE /mfa/methods/:methodId error:', err);
        res.status(500).json({ error: 'Failed to remove MFA method' });
    }
});

// POST /api/mfa/enable — enable MFA for the user
router.post('/mfa/enable', async (req, res) => {
    try {
        const user = res.locals.user;
        const pool = getPool();

        const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);

        // Check X-MFA-Challenge header
        const bmfaToken = await mfaService.ensureBmfa(req, res);
        const challengeId = req.headers['x-mfa-challenge'];
        if (challengeId) {
            const validation = await mfaService.validateChallenge(challengeId, user.user_id, bmfaToken, requiredLevel);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge' });
            }
            await mfaService.consumeChallenge(challengeId);
            await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);

            // Proceed to enable
            const result = await mfaService.enableUserMfa(user.user_id);
            if (!result.success) {
                return res.status(400).json({ error: result.error });
            }
            return res.status(204).end();
        }

        // No header — create challenge and return 403
        const [[userRow]] = await pool.execute(
            'SELECT email FROM users WHERE user_id = ?',
            [user.user_id]
        );

        const challenge = await mfaService.createChallenge({
            userId: user.user_id,
            contextType: 'bmfa',
            contextId: bmfaToken,
            mfaLevel: requiredLevel,
            messageType: 'mfa_change',
            messageOperation: 'Enable MFA',
            canReuse: false,
        });

        const maskedEmail = userRow && userRow.email ? mfaService.maskEmail(userRow.email) : null;
        const methodTypes = await mfaService.getUserMfaMethodTypes(user.user_id);
        const allowedMethods = challenge.allowedMethods.filter(m => {
            if (m === 'email') return !!(userRow && userRow.email);
            return methodTypes.includes(m);
        });

        return res.status(403).json({
            requireMFA: true,
            challengeId: challenge.id,
            allowedMethods,
            maskedEmail,
        });
    } catch (err) {
        console.error('POST /mfa/enable error:', err);
        res.status(500).json({ error: 'Failed to enable MFA' });
    }
});

// POST /api/mfa/disable — disable MFA for the user
router.post('/mfa/disable', async (req, res) => {
    try {
        const user = res.locals.user;
        const pool = getPool();

        // Check X-MFA-Challenge header
        const bmfaToken = await mfaService.ensureBmfa(req, res);
        const challengeId = req.headers['x-mfa-challenge'];
        if (challengeId) {
            const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);
            const validation = await mfaService.validateChallenge(challengeId, user.user_id, bmfaToken, requiredLevel);
            if (!validation.valid) {
                return res.status(403).json({ error: validation.reason || 'Invalid MFA challenge' });
            }
            await mfaService.consumeChallenge(challengeId);
            await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);

            const result = await mfaService.disableUserMfa(user.user_id, !!user.permissions.requireMFA);
            if (!result.success) {
                return res.status(400).json({ error: result.error });
            }
            return res.status(204).end();
        }

        // No header — create challenge and return 403
        const requiredLevel = await mfaService.getHighestMethodLevel(user.user_id);
        const [[userRow]] = await pool.execute(
            'SELECT email FROM users WHERE user_id = ?',
            [user.user_id]
        );

        const challenge = await mfaService.createChallenge({
            userId: user.user_id,
            contextType: 'bmfa',
            contextId: bmfaToken,
            mfaLevel: requiredLevel,
            messageType: 'mfa_change',
            messageOperation: 'Disable MFA',
            canReuse: false,
        });

        const maskedEmail = userRow && userRow.email ? mfaService.maskEmail(userRow.email) : null;
        const methodTypes = await mfaService.getUserMfaMethodTypes(user.user_id);
        const allowedMethods = challenge.allowedMethods.filter(m => {
            if (m === 'email') return !!(userRow && userRow.email);
            return methodTypes.includes(m);
        });

        return res.status(403).json({
            requireMFA: true,
            challengeId: challenge.id,
            allowedMethods,
            maskedEmail,
        });
    } catch (err) {
        console.error('POST /mfa/disable error:', err);
        res.status(500).json({ error: 'Failed to disable MFA' });
    }
});

// POST /api/mfa/challenge/create — create an MFA challenge for authenticated user
router.post('/mfa/challenge/create', async (req, res) => {
    try {
        const user = res.locals.user;
        const { messageType, messageOperation } = req.body;

        const pool = getPool();
        const [[userRow]] = await pool.execute(
            'SELECT email FROM users WHERE user_id = ?',
            [user.user_id]
        );

        const bmfaToken = await mfaService.ensureBmfa(req, res);
        const challenge = await mfaService.createChallenge({
            userId: user.user_id,
            contextType: 'bmfa',
            contextId: bmfaToken,
            approvedEndpoint: null,
            mfaLevel: 0,
            messageType: messageType || 'mfa_change',
            messageOperation: messageOperation || 'Security change',
            canReuse: false,
        });

        const maskedEmail = userRow && userRow.email ? mfaService.maskEmail(userRow.email) : null;

        // Get user's available method types to determine allowed methods
        const methodTypes = await mfaService.getUserMfaMethodTypes(user.user_id);
        const allowedMethods = challenge.allowedMethods.filter(m => {
            if (m === 'email') return !!(userRow && userRow.email);
            return methodTypes.includes(m);
        });

        res.json({
            challengeId: challenge.id,
            allowedMethods,
            maskedEmail,
        });
    } catch (err) {
        console.error('POST /mfa/challenge/create error:', err);
        res.status(500).json({ error: 'Failed to create challenge' });
    }
});

// POST /api/mfa/challenge/send-otp — send OTP email for a challenge
// MfaChallengeUI sends challengeId in body, not URL
router.post('/mfa/challenge/send-otp', async (req, res) => {
    try {
        const user = res.locals.user;
        const { challengeId } = req.body;

        // Validate challenge belongs to user
        const challenge = await mfaService.getChallenge(challengeId);
        if (!challenge || challenge.user_id !== user.user_id) {
            return res.status(403).json({ error: 'Invalid challenge' });
        }

        const result = await mfaService.sendOtpEmail(challengeId, user.user_id);
        if (!result.success) {
            if (result.retryAfter || result.message === 'Daily limit reached') {
                return res.status(429).json({
                    error: result.message,
                    retryAfter: result.retryAfter || null,
                });
            }
            return res.status(503).json({ error: result.message || 'Failed to send code' });
        }

        const otpTimeoutSeconds = parseInt(await mfaService.getSetting('mfa_otp_timeout_seconds', '300'));
        res.json({ success: true, otpValidityMinutes: Math.ceil(otpTimeoutSeconds / 60) });
    } catch (err) {
        console.error('POST /mfa/challenge/send-otp error:', err);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

// POST /api/mfa/challenge/verify — verify a challenge
// MfaChallengeUI sends challengeId in body
router.post('/mfa/challenge/verify', async (req, res) => {
    try {
        const user = res.locals.user;
        const { challengeId, method, code } = req.body;

        // Validate challenge belongs to user
        const challenge = await mfaService.getChallenge(challengeId);
        if (!challenge || challenge.user_id !== user.user_id) {
            return res.status(403).json({ error: 'Invalid challenge' });
        }

        let result;

        if (method === 'email') {
            result = await mfaService.verifyOtp(challengeId, code);
        } else if (method === 'authenticator') {
            const rateCheck = await mfaService.checkTotpRateLimit(user.user_id);
            if (!rateCheck.allowed) {
                return res.status(429).json({ error: 'Too many attempts', retryAfterSeconds: rateCheck.retryAfterSeconds });
            }
            const valid = await mfaService.verifyTotp(user.user_id, code);
            if (valid) {
                await mfaService.clearTotpRateLimit(user.user_id);
                await mfaService.markChallengeVerified(challengeId, 'authenticator');
                await mfaService.updateMethodLastUsed(user.user_id, 'authenticator');
                result = { valid: true };
            } else {
                await mfaService.recordTotpFailedAttempt(user.user_id);
                result = { valid: false };
            }
        } else if (method === 'passkey') {
            result = await mfaService.verifyPasskeyAuth(user.user_id, challengeId, code);
        } else {
            return res.status(400).json({ error: 'Invalid method' });
        }

        if (result.valid) {
            return res.json({ success: true });
        }

        const errorResponse = { valid: false };
        if (result.mustResend !== undefined) errorResponse.mustResend = result.mustResend;
        if (result.attemptsRemaining !== undefined) errorResponse.attemptsRemaining = result.attemptsRemaining;
        if (result.reason) errorResponse.message = result.reason;
        return res.status(422).json(errorResponse);
    } catch (err) {
        console.error('POST /mfa/challenge/verify error:', err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// POST /api/mfa/challenge/passkey/auth-options — get WebAuthn auth options for a challenge
// MfaChallengeUI sends challengeId in body
router.post('/mfa/challenge/passkey/auth-options', async (req, res) => {
    try {
        const user = res.locals.user;
        const { challengeId } = req.body;

        // Validate challenge belongs to user
        const challenge = await mfaService.getChallenge(challengeId);
        if (!challenge || challenge.user_id !== user.user_id) {
            return res.status(403).json({ error: 'Invalid challenge' });
        }

        const options = await mfaService.generatePasskeyAuthOptions(user.user_id, challengeId);
        res.json(options);
    } catch (err) {
        console.error('POST /mfa/challenge/passkey/auth-options error:', err);
        res.status(500).json({ error: 'Failed to generate auth options' });
    }
});

module.exports = router;
