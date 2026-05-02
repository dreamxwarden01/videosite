/**
 * Cloudflare Turnstile server-side token verification.
 * Standalone service — reusable for registration, login MFA, etc.
 *
 * Turnstile facts (from official docs):
 *  - Tokens are single-use: each can only be validated once server-side.
 *  - Tokens expire after 300 seconds (5 minutes).
 *  - Reusing a token returns the "timeout-or-duplicate" error code.
 *  - idempotency_key (UUID) allows safe retries without double-consuming.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Turnstile is "enabled" only when BOTH the public site key and the secret
 * key are configured. If either is missing, we treat Turnstile as off
 * site-wide — verifyTurnstileToken short-circuits with success, the public
 * settings endpoint returns turnstileSiteKey: null, and the client doesn't
 * render the widget.
 */
function isTurnstileEnabled() {
    return !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

/**
 * Verify a Turnstile token with Cloudflare's siteverify endpoint.
 *
 * @param {string} token          – The cf-turnstile-response from the client widget.
 * @param {string} [remoteIp]     – Visitor's IP address (optional but recommended).
 * @param {string} [idempotencyKey] – UUID for safe retries (optional).
 * @returns {Promise<{ success: boolean, errorCodes?: string[], skipped?: boolean }>}
 */
async function verifyTurnstileToken(token, remoteIp, idempotencyKey) {
    // Symmetric with the client: when the admin hasn't configured Turnstile,
    // skip the check entirely. This lets the same code paths work in dev
    // environments and in production with or without Turnstile enabled.
    if (!isTurnstileEnabled()) {
        return { success: true, skipped: true };
    }

    const secret = process.env.TURNSTILE_SECRET_KEY;

    if (!token) {
        return { success: false, errorCodes: ['missing-input-response'] };
    }

    try {
        const body = { secret, response: token };
        if (remoteIp) body.remoteip = remoteIp;
        if (idempotencyKey) body.idempotency_key = idempotencyKey;

        const res = await fetch(SITEVERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            console.error(`Turnstile: siteverify returned HTTP ${res.status}`);
            return { success: false, errorCodes: ['siteverify-http-error'] };
        }

        const data = await res.json();
        return {
            success: data.success === true,
            errorCodes: data['error-codes'] || []
        };
    } catch (err) {
        console.error('Turnstile: network error during verification:', err.message);
        return { success: false, errorCodes: ['network-error'] };
    }
}

module.exports = { verifyTurnstileToken, isTurnstileEnabled };
