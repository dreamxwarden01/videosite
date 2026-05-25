// Transactional-email service.
//
// All outbound mail is delegated to the email-sender Cloudflare Worker at
// stream.dreamxwarden.ca/email-sending. This module is the thin signed-RPC
// client — it HMAC-signs the request, awaits the worker's response, and
// returns a structured shape callers map to user-visible errors:
//
//   { success: true,  messageId }
//   { success: false, error: 'not_configured', message }   ← surface to user
//   { success: false, error: 'rejected',       message, code? }  ← surface to user
//   { success: false, error: 'unavailable',    message }   ← surface as generic
//
// Failure-class semantics (matches the worker's HTTP status):
//   - not_configured: secret missing in site_settings (admin hasn't generated)
//   - rejected:       worker returned 502 — send_email gave a typed reason
//                     (E_SENDER_NOT_VERIFIED, E_RECIPIENT_NOT_VERIFIED, etc.)
//   - unavailable:    everything else — bad HMAC, network, 503 daily-cap
//
// The email_secret_key reads ride the existing settings cache (L1 memo + L2
// Redis blob). `setSetting('email_secret_key', ...)` purges both layers, so
// admin Generate → next send picks up the new secret on the same request.
//
// Replay protection: 60s timestamp window enforced by the worker; no nonce
// store — accepted trade-off given the HMAC-gated, CT-log-invisible Worker
// Route. See cloudflare/workers/email-sender/.

const crypto = require('crypto');
const { getSetting } = require('./cache/settingsCache');
const { getSecretSetting } = require('./settingsEncryption');

const WORKER_URL = 'https://stream.dreamxwarden.ca/email-sending';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Send an email via the email-sender Worker.
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.html]
 * @param {string} [opts.text]
 * @param {string} [opts.replyTo]
 * @returns {Promise<{success: boolean, error?: 'not_configured'|'rejected'|'unavailable', message?: string, code?: string, messageId?: string}>}
 */
async function sendEmail({ to, subject, html, text, replyTo }) {
    // Decrypts transparently if the row was encrypted by migration 035.
    const secret = await getSecretSetting('email_secret_key');
    if (!secret) {
        return {
            success: false,
            error: 'not_configured',
            message: 'Email sending is not configured',
        };
    }

    // From-name comes from site settings — admin changes the brand name in
    // the same Settings page that holds the secret, no worker redeploy.
    const fromName = (await getSetting('site_name')) || 'VideoSite';

    const body = JSON.stringify({
        to,
        from_name: fromName,
        subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
        ...(replyTo ? { replyTo } : {}),
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

    const headers = {
        'content-type': 'application/json',
        'x-timestamp': String(ts),
        'x-signature': sig,
    };

    // Optional Cloudflare Access service-token layer. Admin toggles this
    // on after configuring a CF Access policy + service token; it lets
    // backend → worker requests bypass Cloudflare's Super Bot Fight Mode
    // via the cf.access.authenticated WAF predicate. The HMAC signature
    // above is independent app-level integrity — both layers run.
    const useAccess = (await getSetting('email_with_service_credentials')) === 'true';
    if (useAccess) {
        const clientId = await getSetting('cf_access_client_id');
        const clientSecret = await getSecretSetting('cf_access_client_secret');
        if (clientId && clientSecret) {
            headers['cf-access-client-id'] = clientId;
            headers['cf-access-client-secret'] = clientSecret;
        } else {
            // Toggle on but credentials missing — log and proceed without.
            // The worker route is likely gated by Access at this point so
            // the request will fail with 403 from Cloudflare; the next
            // log line tells the admin where to look.
            console.error('[Email] Service-credentials toggle is on but cf_access_client_id/secret is missing.');
        }
    }

    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
            res = await fetch(WORKER_URL, {
                method: 'POST',
                headers,
                body,
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        console.error('[Email] Worker fetch failed:', err.message);
        return {
            success: false,
            error: 'unavailable',
            message: 'Email sending unavailable',
        };
    }

    if (res.status === 202) {
        const data = await res.json().catch(() => ({}));
        return { success: true, messageId: data.messageId || null };
    }

    // Parse JSON body once so the error logging stays informative.
    const errBody = await res.json().catch(() => ({}));

    if (res.status === 502) {
        // Rejected by send_email (or by the worker's payload validator).
        // The code is shown to admins via server logs; user gets a generic
        // "Email rejected" message.
        console.error(`[Email] Worker rejected: ${errBody.code || 'E_UNKNOWN'} ${errBody.message || ''}`);
        return {
            success: false,
            error: 'rejected',
            message: 'Email rejected',
            code: errBody.code,
        };
    }

    // 401 (HMAC fail), 503 (rate/daily/misconfig), 5xx (Cloudflare edge) →
    // all map to the generic "unavailable" class. The specifics live in
    // server logs only.
    console.error(`[Email] Worker error (status=${res.status}, code=${errBody.code || ''}): ${errBody.message || ''}`);
    return {
        success: false,
        error: 'unavailable',
        message: 'Email sending unavailable',
    };
}

/**
 * Map a sendEmail (or wrapped-service) failure result to an HTTP response
 * shape, or null if the result represents success or should be silently
 * swallowed. Used by route handlers to translate the structured error
 * classes into status + message without each route reinventing the table.
 *
 * Options:
 *   silent: array of error classes to suppress (return null instead of an
 *           HTTP error). The password-reset route uses { silent: ['rejected'] }
 *           to preserve anti-enumeration — a per-recipient worker rejection
 *           must NOT distinguish "user exists but rejected" from "no user".
 *
 * Returns: null | { status, body: { error } }
 */
function mapEmailErrorHttp(result, opts = {}) {
    if (!result || result.success) return null;
    const silent = opts.silent || [];

    if (result.error === 'not_configured') {
        return silent.includes('not_configured')
            ? null
            : { status: 503, body: { error: 'Email sending is not configured' } };
    }
    if (result.error === 'rejected') {
        return silent.includes('rejected')
            ? null
            : { status: 502, body: { error: 'Email rejected' } };
    }
    if (result.error === 'unavailable') {
        return silent.includes('unavailable')
            ? null
            : { status: 503, body: { error: 'Email sending unavailable' } };
    }
    // No structured error class — the failure came from a non-email layer
    // (rate limiter, missing challenge, etc.); the route is responsible for
    // its own handling. Return null so the route's existing branch runs.
    return null;
}

module.exports = { sendEmail, mapEmailErrorHttp };
