// Email-sender Worker.
//
// Single endpoint `POST /email-sending` on stream.dreamxwarden.ca. Receives
// HMAC-signed JSON from the origin backend, calls Cloudflare's `send_email`
// binding (currently Email Service beta), and returns a structured
// success/failure shape the backend can map back to user-visible errors.
//
// Auth: HMAC-SHA256 over `${ts}.${body}` with a shared secret. The backend
// stores the same secret in site_settings and rotates it via the admin UI;
// rotating updates the DB row and requires `wrangler secret put
// EMAIL_HMAC_SECRET` on this Worker to keep them in sync. A 60 s timestamp
// window is enforced — no nonce / replay store (per design decision).
//
// Failure classification (mirrors what emailService.js expects):
//   401  → bad HMAC / stale timestamp                 → backend sees "unavailable"
//   502  → send_email rejected (sender/recipient/MIME) → backend sees "rejected"
//   503  → daily/rate cap, misconfig, network         → backend sees "unavailable"
//   202  → success, body { messageId }
//
// EMAIL_FROM_ADDRESS comes from `vars` in wrangler.jsonc — keep it aligned
// with `allowed_sender_addresses` on the send_email binding. The From: name
// comes from the request body (origin pulls it from site_settings.site_name)
// so admins can change the brand name without redeploying this Worker.

const JSON_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// Hex string → Uint8Array. Used to decode the HMAC signature header.
function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        const b = parseInt(hex.substr(i * 2, 2), 16);
        if (Number.isNaN(b)) return null;
        out[i] = b;
    }
    return out;
}

async function verifyHmac(secret, payload, sigHex) {
    const sig = hexToBytes(sigHex);
    if (!sig) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['verify']
    );
    // crypto.subtle.verify is constant-time and rejects mismatched lengths.
    return crypto.subtle.verify('HMAC', key, sig, enc.encode(payload));
}

// send_email error codes that mean "the recipient or sender was rejected /
// the message was malformed" — surface these to the admin so they know to
// fix domain setup or recipient input.
const REJECTED_CODES = new Set([
    'E_SENDER_NOT_VERIFIED',
    'E_RECIPIENT_NOT_VERIFIED',
    'E_INVALID_MIME',
    'E_MALFORMED_MESSAGE',
    'E_DOMAIN_NOT_ALLOWED',
]);

// Codes that mean "try again later" — daily cap, rate limit, transient.
const RETRYABLE_CODES = new Set([
    'E_RATE_LIMIT_EXCEEDED',
    'E_DAILY_LIMIT_EXCEEDED',
]);

export default {
    async fetch(request, env, _ctx) {
        // Misconfig guard: missing secret = 503 so the admin's first failed
        // send-attempt surfaces a real error in the origin logs instead of
        // silently 401-ing every request as a "bad signature".
        if (!env.EMAIL_HMAC_SECRET) {
            return jsonResponse(503, { code: 'E_WORKER_MISCONFIGURED', message: 'EMAIL_HMAC_SECRET not set' });
        }
        if (!env.EMAIL_FROM_ADDRESS) {
            return jsonResponse(503, { code: 'E_WORKER_MISCONFIGURED', message: 'EMAIL_FROM_ADDRESS not set' });
        }

        // Scope check: this Worker only handles POST /email-sending. Anything
        // else returns 404 — including GETs, which keeps drive-by scanners
        // from distinguishing a real endpoint from a non-existent path.
        const url = new URL(request.url);
        if (request.method !== 'POST' || url.pathname !== '/email-sending') {
            return new Response('not found', { status: 404 });
        }

        // Read the raw body before parsing — we need byte-exact text to
        // recompute the HMAC. (Body is read once; reading req.text() then
        // calling req.json() doesn't work in the Workers runtime.)
        const body = await request.text();
        const tsHeader = request.headers.get('x-timestamp') || '';
        const sigHex = request.headers.get('x-signature') || '';
        const ts = parseInt(tsHeader, 10);
        if (!Number.isFinite(ts)) return jsonResponse(401, { code: 'E_BAD_AUTH', message: 'invalid timestamp' });

        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - ts) > 60) {
            return jsonResponse(401, { code: 'E_BAD_AUTH', message: 'stale timestamp' });
        }

        const ok = await verifyHmac(env.EMAIL_HMAC_SECRET, `${ts}.${body}`, sigHex);
        if (!ok) return jsonResponse(401, { code: 'E_BAD_AUTH', message: 'bad signature' });

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return jsonResponse(502, { code: 'E_INVALID_PAYLOAD', message: 'body is not valid JSON' });
        }

        const { to, from_name, subject, html, text, replyTo } = payload || {};
        if (!to || !subject || (!html && !text)) {
            return jsonResponse(502, { code: 'E_INVALID_PAYLOAD', message: 'missing required fields' });
        }

        // Construct RFC 5322 From with the worker-owned address. We don't
        // accept a From: from the backend — the address is locked here so
        // a backend compromise can't send mail from arbitrary identities.
        const fromDisplay = (typeof from_name === 'string' && from_name.trim())
            ? `${from_name.trim()} <${env.EMAIL_FROM_ADDRESS}>`
            : env.EMAIL_FROM_ADDRESS;

        try {
            const message = { to, from: fromDisplay, subject };
            if (html) message.html = html;
            if (text) message.text = text;
            if (replyTo) message.replyTo = replyTo;

            const result = await env.EMAIL.send(message);
            return jsonResponse(202, { messageId: result?.messageId || null });
        } catch (err) {
            const code = err?.code || 'E_UNKNOWN';
            const message = err?.message || 'send_email threw without a message';
            if (REJECTED_CODES.has(code)) {
                return jsonResponse(502, { code, message });
            }
            if (RETRYABLE_CODES.has(code)) {
                return jsonResponse(503, { code, message });
            }
            // Unknown error — bias toward "rejected" so the admin sees the
            // actual code in the origin logs instead of a generic 503 they
            // can't act on.
            return jsonResponse(502, { code, message });
        }
    },
};
