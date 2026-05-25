# email-sender Worker

Cloudflare Worker that sends transactional email via Cloudflare's native
`send_email` binding (currently Email Service beta) on behalf of the
videosite origin.

The origin's `services/emailService.js` POSTs HMAC-signed JSON to
`https://stream.dreamxwarden.ca/email-sending`. This Worker verifies the
signature, builds the `From:` header from the worker-owned address plus
the name provided by the origin, calls `env.EMAIL.send(...)`, and returns
a structured response the origin maps to user-visible errors.

## One-time setup

1. **Verify your sender domain** in the Cloudflare dashboard at *Email
   Sending → Senders → Add sender*. Cloudflare auto-provisions MX, SPF,
   and DKIM records in the zone. Until this finishes (usually within a
   minute) `send_email` returns `E_SENDER_NOT_VERIFIED`.

2. **Edit `wrangler.jsonc`** so `EMAIL_FROM_ADDRESS` and
   `send_email[].allowed_sender_addresses[0]` both match the address you
   just verified. They must stay in sync.

3. **Deploy** the Worker:
   ```bash
   npm install
   npm run deploy
   ```

4. **Set the HMAC secret**: generate a fresh secret from the admin
   Settings UI (Cloudflare card → Email Sending → *Initialize Key*),
   then paste it on this Worker:
   ```bash
   npx wrangler secret put EMAIL_HMAC_SECRET
   ```
   The dashboard-side equivalent is *Workers & Pages → email-sender →
   Settings → Variables and Secrets → Add → type "Secret"*. Both the
   site_settings row and this Worker secret must hold the same value.

## Local development

`wrangler dev` simulates `env.EMAIL.send(...)` by default — it logs the
constructed message to the console instead of actually sending. Add
`"remote": true` to the `[[send_email]]` block (or pass
`--remote-bindings`) to send through the real backend during dev.

Create a `.dev.vars` file (gitignored) with the HMAC secret so the local
Worker doesn't 503:

```ini
EMAIL_HMAC_SECRET=<paste-your-dev-secret>
```

## Coordination rules

- **Rotate the secret in both places together.** The admin UI "Generate
  New Key" button updates the DB row immediately, but this Worker keeps
  using the old secret until you re-run `wrangler secret put` and
  redeploy. The window between Generate and re-deploy is a guaranteed
  outage for outbound email — schedule it.

- **Change the From: address in both places together.** Update
  `EMAIL_FROM_ADDRESS` *and* `allowed_sender_addresses` in
  `wrangler.jsonc`, then redeploy. Mismatching them produces
  `E_SENDER_NOT_VERIFIED` on every send.

## Response shape

| Status | Body | Origin maps to |
|---|---|---|
| `202` | `{ messageId }` | `success` |
| `401` | `{ code: 'E_BAD_AUTH', message }` | `unavailable` (generic) |
| `502` | `{ code: 'E_*', message }` | `rejected` (visible code in origin logs) |
| `503` | `{ code, message }` | `unavailable` (retryable later) |
| `404` | `not found` | n/a (unmatched path/method) |
