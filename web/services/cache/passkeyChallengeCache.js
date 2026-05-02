// Pre-auth WebAuthn challenge store for username-less passkey sign-in.
//
// The standard /api/auth/mfa flow stores its WebAuthn challenge inside the
// mfa_challenges row keyed on (user_id, bmfa). That doesn't fit the
// passkey-only login: at the time we generate the challenge, we don't know
// who's signing in yet, and mfa_challenges.user_id is NOT NULL. Adding a
// nullable column for one rare path bloats a hot table and changes existing
// queries.
//
// Redis is the right tool here — challenges are short-lived (5 min), single-
// use, and anonymous. One key per outstanding challenge:
//   passkey_login_chal:<handle>  →  <webauthn challenge string (base64url)>
//
// The handle is a 32-byte random base64url string we hand to the client.
// Client posts it back along with the assertion; we GET+DEL atomically so a
// challenge can only be redeemed once even under concurrent attempts.
// Replay is also prevented at the WebAuthn layer (the assertion signature
// covers the challenge, which is one-shot), but DEL-on-take saves a wasted
// signature verification on the second try.

const crypto = require('crypto');
const { getClient } = require('../redis');

const KEY_PREFIX = 'passkey_login_chal:';
const TTL_SECONDS = 300;        // 5 min — long enough for OS picker + biometric prompt
const HANDLE_BYTES = 32;        // 256 bits → ~43 base64url chars

// Generate + persist a new challenge. Returns the handle the client will
// echo back in the verify call.
async function create(webauthnChallenge) {
    const handle = crypto.randomBytes(HANDLE_BYTES).toString('base64url');
    await getClient().set(KEY_PREFIX + handle, webauthnChallenge, 'EX', TTL_SECONDS);
    return handle;
}

// Atomic GET + DEL. Returns the stored challenge or null (expired / unknown
// / already consumed). The DEL guarantees one-shot semantics: a second
// verify with the same handle gets null and rejects cleanly.
async function take(handle) {
    if (!handle || typeof handle !== 'string') return null;
    const redis = getClient();
    const multi = redis.multi();
    multi.get(KEY_PREFIX + handle);
    multi.del(KEY_PREFIX + handle);
    const results = await multi.exec();
    if (!results || !results[0]) return null;
    return results[0][1] || null;
}

module.exports = { create, take };
