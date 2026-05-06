// Username-less ("quick sign in") passkey routes.
//
// Two anonymous endpoints — the user is identified from their passkey, not
// from any prior authentication state:
//
//   POST /api/auth/passkey/options   → { challengeHandle, options }
//   POST /api/auth/passkey/verify    → { success, returnTo } | { error: <code>, ... }
//
// On success, /verify mints a regular session cookie equivalent to the
// password+MFA flow. The passkey assertion (with userVerification: 'required')
// is MFA-strength on its own, so this single round trip replaces the entire
// username + password + MFA-challenge sequence.
//
// Rate limiting is delegated to the Cloudflare edge (same as /api/login).

const express = require('express');
const router = express.Router();
const { createSession, getSessionMaxDays } = require('../config/session');
const { SESSION_COOKIE, getClientIp } = require('../middleware/auth');
const mfaService = require('../services/mfaService');
const { verifyTurnstileToken } = require('../services/turnstileService');
const passkeyChallengeCache = require('../services/cache/passkeyChallengeCache');

// Match auth.js: returnTo must be a same-site relative path.
function sanitizeReturnTo(returnTo) {
    if (!returnTo || typeof returnTo !== 'string') return '/';
    if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('://')) return '/';
    return returnTo;
}

// POST /api/auth/passkey/options
//
// Generates a WebAuthn assertion challenge with empty allowCredentials,
// stores the challenge in Redis under a one-shot handle, and returns both
// to the client. The client passes the handle back unchanged in /verify.
//
// Turnstile gate — same shape as /api/login. We gate /options instead of
// /verify because the Redis challenge handle is itself one-shot, so once
// /options has succeeded the bot still needs to produce a real WebAuthn
// assertion to do anything useful. Turnstile-on-/options is sufficient.
router.post('/api/auth/passkey/options', async (req, res) => {
    try {
        // Refuse to overwrite a real session — user is already signed in.
        if (res.locals.user) {
            return res.status(400).json({ error: 'already_signed_in' });
        }

        const { turnstileToken } = req.body || {};
        const ip = getClientIp(req);
        const turnstileResult = await verifyTurnstileToken(turnstileToken, ip);
        if (!turnstileResult.success) {
            // 403 — same status the planned Cloudflare-Worker turnstile gate
            // will use when it short-circuits before the origin sees the
            // request. Stable status across edge/origin keeps the client
            // single-shape.
            return res.status(403).json({
                errors: { turnstile: 'Human verification failed. Please try again.' }
            });
        }

        const { challengeHandle, options } = await mfaService.generatePasskeyLoginOptions();
        // Hand the TTL down so the client can decide whether to reuse the
        // handle on retry (>= half TTL remaining) vs. fetch fresh /options.
        res.json({
            challengeHandle,
            options,
            challengeTtlSeconds: passkeyChallengeCache.TTL_SECONDS,
        });
    } catch (err) {
        console.error('Passkey login options error:', err);
        res.status(500).json({ error: 'options_failed' });
    }
});

// POST /api/auth/passkey/verify
//
// Body: { challengeHandle: string, credential: <PublicKeyCredentialJSON>, returnTo?: string }
//
// Outcomes:
//   200 { success: true, returnTo }                — session cookie set
//   400 { error: 'bad_request' }                   — missing/malformed body
//   400 { error: 'already_signed_in' }             — user already has a session
//   401 { error: 'inactive_user' }                 — credential's owner is deactivated
//   401 { error: 'verification_failed' }           — signature / origin / counter mismatch
//   404 { error: 'unknown_credential', credentialId } — challenge expired or
//        credential not in DB. credentialId is echoed (never trusted server-side
//        beyond this echo) so the client can call signalUnknownCredential
//        without keeping a side reference.
//   410 { error: 'revoked' }                       — credential row exists but is_active=0;
//        no signal cleanup (admin may unrevoke).
router.post('/api/auth/passkey/verify', async (req, res) => {
    try {
        if (res.locals.user) {
            return res.status(400).json({ error: 'already_signed_in' });
        }

        const { challengeHandle, credential, returnTo } = req.body || {};
        if (!challengeHandle || typeof challengeHandle !== 'string' || !credential || typeof credential !== 'object') {
            return res.status(400).json({ error: 'bad_request' });
        }

        const result = await mfaService.verifyPasskeyLoginAssertion(challengeHandle, credential);

        if (!result.valid) {
            switch (result.code) {
                case 'unknown_credential':
                    // Echo the client-provided credential.id (it's already in
                    // their hand) so they can fire signalUnknownCredential
                    // without separately storing it across the round trip.
                    return res.status(404).json({
                        error: 'unknown_credential',
                        credentialId: typeof credential.id === 'string' ? credential.id : null
                    });
                case 'revoked':
                    return res.status(410).json({ error: 'revoked' });
                case 'inactive_user':
                    return res.status(401).json({ error: 'inactive_user' });
                case 'verification_failed':
                default:
                    return res.status(401).json({ error: 'verification_failed' });
            }
        }

        // Mint session — same shape as /api/login + /api/auth/mfa/verify.
        const userAgent = req.headers['user-agent'] || null;
        const ip = getClientIp(req);
        const sessionId = await createSession(result.userId, userAgent, ip);

        const maxDays = await getSessionMaxDays();
        res.cookie(SESSION_COOKIE, sessionId, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: maxDays * 24 * 60 * 60 * 1000
        });

        res.json({ success: true, returnTo: sanitizeReturnTo(returnTo) });
    } catch (err) {
        console.error('Passkey login verify error:', err);
        res.status(500).json({ error: 'verify_failed' });
    }
});

module.exports = router;
