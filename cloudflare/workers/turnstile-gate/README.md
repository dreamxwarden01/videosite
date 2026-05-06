# turnstile-gate

Cloudflare Worker that verifies Cloudflare Turnstile tokens at the edge for
the five sign-in / registration POST endpoints. On success it strips the
token and forwards the request to origin; on failure it returns `403`
without ever waking the origin.

## What it gates

| Method | Path                              |
| ------ | --------------------------------- |
| POST   | `/api/login`                      |
| POST   | `/api/register/start`             |
| POST   | `/api/register/complete`          |
| POST   | `/api/password-reset/request`     |
| POST   | `/api/auth/passkey/options`       |

The Worker is bound to those exact paths via `wrangler.jsonc → routes`.
Other paths are not intercepted.

## Setup

1. Edit `wrangler.jsonc` and replace `REPLACE_ME_HOSTNAME` (e.g.
   `videosite.example.com`) and `REPLACE_ME_ZONE` (e.g. `example.com`) with
   your real values across all five route entries.

2. Install Wrangler locally:
   ```bash
   npm install
   ```

3. Authenticate with Cloudflare:
   ```bash
   npx wrangler login
   ```

4. Set the Turnstile secret. Either of these is fine; the dashboard option
   leaves no trace on disk:
   - **CLI:** `npx wrangler secret put TURNSTILE_SECRET_KEY` (paste secret
     when prompted).
   - **Dashboard:** Workers & Pages → turnstile-gate → Settings →
     Variables and Secrets → "Add" → type `Secret` →
     name `TURNSTILE_SECRET_KEY` → paste value → Save.

   The placeholder `TURNSTILE_SECRET_KEY` value in `wrangler.jsonc` is
   shadowed by the dashboard secret at runtime.

5. Deploy:
   ```bash
   npm run deploy
   ```

## Coordination with the origin toggle

The admin Settings page has a "Turnstile Verification at Worker" toggle
(under the **Cloudflare** card). Treat it as a "the Worker is in front of
me, please skip my own verification" signal:

- **Toggle ON:** origin trusts that this Worker has already verified the
  token. Origin skips its own siteverify call.
- **Toggle OFF:** origin verifies the token itself, expecting it to be
  present in the request body.

This Worker always verifies and strips when deployed. The forbidden state is
**(toggle off + Worker deployed)** — the Worker strips the token but origin
still expects one, so every gated request 403s. To avoid that state:

- **Turn the admin toggle ON _before_ deploying this Worker.**
- **Turn the admin toggle OFF _after_ undeploying this Worker.**

The brief intermediate state in either transition (toggle on + Worker not
yet in front) just means Turnstile isn't actually checked during that
window — functionally fine, only a small security gap until the second
step lands.

The toggle has no effect when the origin doesn't have `TURNSTILE_SITE_KEY`
and `TURNSTILE_SECRET_KEY` configured (Turnstile is off site-wide).

## Local development

```bash
npm run dev
```

By default this binds to `localhost:8787`. Set the secret in `.dev.vars`
(gitignored) so the local Worker can talk to siteverify:

```
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

(That sample is one of Cloudflare's [test secret keys][1] — always passes
verification, useful for end-to-end checks against a live origin.)

[1]: https://developers.cloudflare.com/turnstile/troubleshooting/testing/

## Logs

```bash
npm run tail
```
