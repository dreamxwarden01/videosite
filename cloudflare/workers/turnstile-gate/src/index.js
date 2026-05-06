// Turnstile-gate Worker.
//
// Sits in front of the five POST endpoints that use Cloudflare Turnstile:
//   /api/login
//   /api/register/start
//   /api/register/complete
//   /api/password-reset/request
//   /api/auth/passkey/options
//
// On every matched request:
//   1. Parse JSON body, pull out `turnstileToken`.
//   2. Verify with Cloudflare's siteverify endpoint, including CF-Connecting-IP.
//   3. On success → strip `turnstileToken` from the body and forward the
//      reconstructed request to origin. Return origin's response unchanged.
//   4. On failure (missing, expired, duplicated, invalid, network error) →
//      respond 403 with the same JSON shape the origin used to return, so
//      the client only has to know one error contract.
//
// This Worker is "always on" — the admin UI in the origin has a toggle that
// only controls whether origin re-verifies. The Worker itself doesn't read
// that toggle. Coordination rule: turn the admin toggle ON *before* deploying
// this Worker, and turn it OFF *after* undeploying. The forbidden state is
// (toggle off + Worker deployed) — the Worker strips the token but origin
// still expects to see one, so every gated endpoint 403s. The transition
// state (toggle on + Worker not yet deployed) is fine functionally; it
// just means Turnstile isn't actually checked during that brief window.
//
// The TURNSTILE_SECRET_KEY env var is set as a Wrangler secret on the
// Cloudflare dashboard — never committed. Without it the Worker can't call
// siteverify; it falls back to 503 in that case to make the misconfig loud.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Mirror the origin's exact 403 body so the client's existing error handler
// (which keys off status === 403 + errors.turnstile) doesn't need to learn a
// second shape.
const TURNSTILE_FAILURE_BODY = JSON.stringify({
    success: false,
    errors: { turnstile: 'Human verification failed. Please try again.' },
});
const TURNSTILE_FAILURE_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
};

function failure() {
    return new Response(TURNSTILE_FAILURE_BODY, {
        status: 403,
        headers: TURNSTILE_FAILURE_HEADERS,
    });
}

async function verifyToken(token, ip, secret) {
    if (!token || typeof token !== 'string') return false;

    // siteverify accepts both form-encoded and JSON; FormData mirrors the
    // shape used by Cloudflare's own demo (cloudflare/turnstile-demo-workers).
    const form = new FormData();
    form.append('secret', secret);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);

    let result;
    try {
        const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
        if (!res.ok) return false;
        result = await res.json();
    } catch {
        // Network / parse error talking to siteverify — treat as failure
        // rather than letting the request through. On the rare flap this
        // surfaces as a 403 to the user; better than letting a bot in.
        return false;
    }
    return result?.success === true;
}

export default {
    async fetch(request, env, _ctx) {
        // Misconfig guard: explicit 503 makes a missing secret loud at the
        // edge instead of silently 403-ing every login.
        if (!env.TURNSTILE_SECRET_KEY) {
            return new Response(
                JSON.stringify({ error: 'turnstile_gate_misconfigured' }),
                { status: 503, headers: TURNSTILE_FAILURE_HEADERS }
            );
        }

        // The Worker is bound to POST endpoints only, but Cloudflare routes
        // are method-agnostic. Anything else is forwarded straight through —
        // we don't want to block a hypothetical OPTIONS preflight or a GET
        // that shares the path.
        if (request.method !== 'POST') {
            return fetch(request);
        }

        // Body must be JSON for the gated endpoints. If parsing fails we
        // still 403 — these endpoints don't accept anything else, and a
        // non-JSON body on a Turnstile-protected route is suspicious.
        let body;
        try {
            body = await request.json();
        } catch {
            return failure();
        }

        const token = body?.turnstileToken;
        const ip = request.headers.get('CF-Connecting-IP') || '';

        const ok = await verifyToken(token, ip, env.TURNSTILE_SECRET_KEY);
        if (!ok) return failure();

        // Strip the token before forwarding so the origin never sees it. The
        // origin's verifyTurnstileToken short-circuits when its admin toggle
        // is on, so a stripped body is expected. (If the toggle is off the
        // origin will reject with "missing token" — that's the coordination
        // rule documented in the README.)
        delete body.turnstileToken;

        // Rebuild the request with the trimmed body. Drop Content-Length so
        // the Workers runtime recomputes it from the new body length.
        const headers = new Headers(request.headers);
        headers.delete('content-length');

        const forwarded = new Request(request.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'manual',
        });

        return fetch(forwarded);
    },
};
