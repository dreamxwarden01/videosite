const express = require('express');
const router = express.Router();
const { getUserByUsername, getUserByEmail, verifyPassword } = require('../services/userService');
const { createSession, deleteSession, getSessionMaxDays } = require('../config/session');
const { SESSION_COOKIE, getClientIp } = require('../middleware/auth');
const mfaService = require('../services/mfaService');
const { resolvePermissions } = require('../services/permissionService');
const { verifyTurnstileToken } = require('../services/turnstileService');

// Validate returnTo: must be a same-site relative path
function sanitizeReturnTo(returnTo) {
    if (!returnTo || typeof returnTo !== 'string') return '/';
    // Must start with / and must not contain protocol or double slash (open redirect)
    if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('://')) return '/';
    return returnTo;
}

// POST /api/login
router.post('/api/login', async (req, res) => {
    try {
        if (res.locals.user) {
            return res.status(400).json({ success: false, message: 'Already logged in.' });
        }

        const { username, password, returnTo, turnstileToken } = req.body;
        const safeReturnTo = sanitizeReturnTo(returnTo);

        // Turnstile first — token is consumed by Cloudflare even if later
        // validations (username/password mismatch, deactivated account,
        // etc.) fail. When TURNSTILE_*_KEY env vars are unset, the helper
        // short-circuits with success, leaving the rest of the path
        // unchanged for self-hosted / dev deploys without a CAPTCHA.
        const ip = getClientIp(req);
        const turnstileResult = await verifyTurnstileToken(turnstileToken, ip);
        if (!turnstileResult.success) {
            return res.status(422).json({
                success: false,
                errors: { turnstile: 'Human verification failed. Please try again.' }
            });
        }

        if (!username || !password) {
            return res.status(401).json({
                success: false,
                returnTo: null,
                message: 'Username or email and password are required'
            });
        }
        if (/\s/.test(username) || /\s/.test(password)) {
            return res.status(422).json({ success: false, returnTo: null, message: 'Spaces are not allowed in credentials' });
        }

        // Try username first, then email
        let user = await getUserByUsername(username);
        if (!user && username.includes('@')) {
            user = await getUserByEmail(username);
        }
        if (!user) {
            return res.status(401).json({
                success: false,
                returnTo: null,
                message: 'Invalid username or password'
            });
        }

        if (!user.is_active) {
            return res.status(401).json({
                success: false,
                returnTo: null,
                message: 'Account is deactivated'
            });
        }

        const valid = await verifyPassword(user.password_hash, password);
        if (!valid) {
            return res.status(401).json({
                success: false,
                returnTo: null,
                message: 'Invalid username or password'
            });
        }

        // --- MFA check ---
        const userAgent = req.headers['user-agent'] || null;
        const mfaLoginPolicy = await mfaService.getScenarioPolicy('login');
        const userMfaEnabled = await mfaService.isUserMfaEnabled(user.user_id);
        const userPermissions = await resolvePermissions(user.user_id, user.role_id);

        if (mfaLoginPolicy.enabled && userMfaEnabled) {
            const bmfaToken = await mfaService.ensureBmfa(req, res);
            const canReuse = mfaLoginPolicy.reuse === 'persistent';

            // Check for existing reusable challenge on this browser
            if (canReuse) {
                const existing = await mfaService.findValidLongStatus(user.user_id, bmfaToken, mfaLoginPolicy.level);
                if (existing) {
                    // Reusable challenge found — skip MFA, create session directly
                    await mfaService.rotateBmfaIfNeeded(req, res, bmfaToken);
                    const sessionId = await createSession(user.user_id, userAgent, ip);
                    const maxDays = await getSessionMaxDays();
                    res.cookie(SESSION_COOKIE, sessionId, {
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: 'lax',
                        maxAge: maxDays * 24 * 60 * 60 * 1000
                    });
                    return res.json({
                        success: true,
                        returnTo: safeReturnTo,
                        message: 'Login successful'
                    });
                }
            }

            // No reusable challenge — create a new one
            const challenge = await mfaService.createChallenge({
                userId: user.user_id,
                contextType: 'bmfa',
                contextId: bmfaToken,
                approvedEndpoint: '/api/login',
                mfaLevel: mfaLoginPolicy.level,
                messageType: 'login',
                messageOperation: 'Sign in',
                canReuse
            });

            // Filter allowed methods to what the user actually has
            const methodTypes = await mfaService.getUserMfaMethodTypes(user.user_id);
            const allowedMethods = challenge.allowedMethods.filter(m => {
                if (m === 'email') return !!user.email;
                return methodTypes.includes(m);
            });

            const maskedEmail = mfaService.maskEmail(user.email);

            return res.json({
                success: true,
                requireMFA: true,
                challengeId: challenge.id,
                allowedMethods,
                maskedEmail,
                returnTo: safeReturnTo
            });
        }

        if (mfaLoginPolicy.enabled && !userMfaEnabled && userPermissions.requireMFA) {
            // User needs to set up MFA — create bmfa + enrollment challenge
            const bmfaToken = await mfaService.ensureBmfa(req, res);

            const challenge = await mfaService.createChallenge({
                userId: user.user_id,
                contextType: 'bmfa',
                contextId: bmfaToken,
                mfaLevel: 0,
                messageType: 'login',
                messageOperation: 'MFA enrollment',
                canReuse: false
            });

            return res.json({
                success: true,
                requireMFASetup: true,
                challengeId: challenge.id,
                returnTo: safeReturnTo
            });
        }

        // No MFA required -- proceed with normal session creation
        const sessionId = await createSession(user.user_id, userAgent, ip);

        // Set session cookie with maxAge from site settings
        const maxDays = await getSessionMaxDays();
        res.cookie(SESSION_COOKIE, sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: maxDays * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            returnTo: safeReturnTo,
            message: 'Login successful'
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({
            success: false,
            returnTo: null,
            message: 'An error occurred during sign in'
        });
    }
});

// POST /api/auth/logout
router.post('/api/auth/logout', async (req, res) => {
    try {
        const sessionId = req.cookies[SESSION_COOKIE];
        if (sessionId) {
            await deleteSession(sessionId);
        }
        res.clearCookie(SESSION_COOKIE);
        res.json({ success: true });
    } catch (err) {
        console.error('Logout error:', err);
        res.clearCookie(SESSION_COOKIE);
        res.json({ success: true });
    }
});

module.exports = router;
