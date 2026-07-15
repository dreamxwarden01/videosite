# videosite

A self-hosted video / course streaming platform — a Node/Express backend and React SPA that
authenticates users as an OpenID Connect **relying party** of
[DreamSSO](https://github.com/dreamxwarden01/dreamsso). Identity (sign-in, registration, MFA,
password reset) lives in the SSO; videosite keeps its own **roles, permissions, and content**
(courses, videos, materials, playback, transcoding).

## Auth model

- Sign-in is the OIDC authorization-code flow to DreamSSO — videosite holds no passwords. A user's
  global identity is the SSO-minted `sub` (UUIDv7), which videosite uses as its own `user_id`.
- videosite self-mints an Ed25519 **client key** and serves the public half at
  `/.well-known/jwks.json`; the SSO fetches it (no key handoff). Roles are re-checked here on every
  request — the SSO federates *who you are*, not *what you can do* in the app.
- Step-up for sensitive admin actions is delegated to the SSO (redirect takeover).

## Layout

| Path | What |
|---|---|
| `routes/`, `services/`, `middleware/` | Express backend — app API, the OIDC RP flow (`lib/oidc.js`), admin, and the transcode-worker API |
| `client/` | React SPA |
| `db/` | schema + migrations (`db/migrations.js`, guarded by `npm run check:db`) |
| `api-schema.json` | OpenAPI for the `/api/*` surface (Cloudflare API Shield); validated by `npm run check:schema` |

## First run

Boots unconfigured behind a token-locked `/install` wizard: infrastructure → site → SSO config →
mTLS (optional) → the **connect** hard-gate that registers videosite at the SSO and publishes its
role catalogue. No account is created at install — the operator who holds the SSO's root org role
signs in and lands as videosite's superadmin.

## Deploy

Ships as `ghcr.io/dreamxwarden01/videosite-web` (built from `main`). Secrets, certs, and real user
data are git-ignored and must never be committed. Three crypto keys carried from the original
deployment — `SETTINGS_SECRET_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `SESSION_SECRET` — **must never
be rotated** (they decrypt existing sealed settings / MFA at rest).
