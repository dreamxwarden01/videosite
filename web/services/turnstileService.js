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
 * Verify a Turnstile token with Cloudflare's siteverify endpoint.
 *
 * @param {string} token          – The cf-turnstile-response from the client widget.
 * @param {string} [remoteIp]     – Visitor's IP address (optional but recommended).
 * @param {string} [idempotencyKey] – UUID for safe retries (optional).
 * @returns {Promise<{ success: boolean, errorCodes?: string[] }>}
 */
async function verifyTurnstileToken(token, remoteIp, idempotencyKey) {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
        console.error('Turnstile: TURNSTILE_SECRET_KEY is not configured');
        return { success: false, errorCodes: ['missing-secret-key'] };
    }

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

module.exports = { verifyTurnstileToken };
