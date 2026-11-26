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
  Each challenge is bound to the initiating local session, user and original SSO
  session. Logging out or replacing that local session requires a new challenge.
  The callback checks the returned subject, SSO session, factor and authentication
  time within the ten-minute flow lifetime, allowing 30 seconds of issuer clock
  skew. The sudo window starts at the factor's authentication time. Restart any
  in-flight step-up begun before these session bindings were introduced.

Role catalogs use persistent versions and immutable delivery records. Signed role
events, login claims and access-state queries are checked against each subject's
stored version so an older response cannot replace newer authorization. Upgrade
DreamSSO's role-event schema and server before upgrading the relying party, and
preserve synchronization metadata with database backups.

## R2 deletion and read-only inventory

Course removal commits its storage cleanup plan and the course cascade in one
MariaDB transaction. Cache invalidation runs after commit; a cache failure does
not discard the cleanup plan. Unknown source/output layouts fail before deleting
the course rather than expanding a prefix. Read-through metadata caches are also
invalidated after an uncertain commit response; worker liveness and upload
cancellation effects require confirmed commit. Cleanup deadlines are serialized
as Unix timestamps and converted by the database, so app/database timezone
differences do not change the intended buffer.

The serial deletion reaper checks per-object errors even when a batch returns
HTTP 200, and confirms a prefix is empty before settling its task. Explicit
`NoSuchKey` is idempotent success; other failures stay queued. Transient failures
receive up to five row attempts, then retry after 60 seconds. Permanent failures
stop early and retry after five minutes. A failed row stops the current drain;
other due rows can proceed at the next tick. A failed database acknowledgement
does not replay R2 within that turn. SDK retries remain separate from row attempts.

Structured `r2_deletion` logs record List/Delete attempt duration, HTTP status,
R2 request ID, SDK retry spacing and totals, batch size and per-object error-code
counts. `call_id` joins SDK attempts; `row_id` joins queue attempts. Keys, prefixes
and batches are represented by hashes; request bodies, credentials, signed URLs
and raw provider messages are excluded. These hashes are correlatable pseudonyms,
not anonymization; retain normal access controls on operational logs.
`row_complete` follows database settlement; `phase: db_ack` identifies failed
database acknowledgement separately from an R2 failure.
These logs do not cover the separate Go worker's upload traffic.

`node scripts/r2-orphan-audit.js --help` describes a prefix-only inventory tool.
Supply a complete consistent database snapshot, an explicit temporary read-only
S3 credential file and the intended R2 endpoint/bucket. It only issues paginated
`ListObjectsV2` requests with a delimiter; there is no delete/apply mode. Capture
a second database snapshot after scanning and use `--verify-report` to detect
ownership changes without querying R2 again. Reports distinguish referenced,
active-upload, pending-cleanup, unknown and orphan-candidate prefixes. Candidates
are **not** deletion authorization. Course-level attachment/poster checks do not
identify stale individual files inside an otherwise valid course, and video
prefix checks do not establish segment or job completeness.

Run `npm run test:deletion` for request/retry, queue, transaction and inventory
unit tests. `npm run test:deletion:db` creates and removes a disposable local
MariaDB fixture; `VS_TEST_DOCKER_CONTEXT` defaults to `orbstack` (CI uses `default`).

## Fonts

UI text uses self-hosted Inter with automatic optical sizing, while existing
code fields keep Geist Mono. Noto
Sans SC supplies the default CJK fallback; explicit `zh-Hant`, `zh-TW`, `zh-HK`
and `zh-MO` language tags select Noto Sans TC. The upstream unicode ranges keep
CJK downloads limited to the glyph shards a page needs. Uncovered glyphs use
system fallback. Player subtitle settings and icon families retain their own
font choices.

The active kit lives in `client/public/fonts/ui-inter-32b1c1d253ef89d7`;
its `FONT_MANIFEST.json` records the pinned Inter file and license plus reused
Geist Mono/Noto URLs and hashes. Keep `ui-f62459131c009479` and its OFL notices:
the new stylesheet references those immutable font files directly, avoiding
duplicate CJK downloads. The old kit is retained unchanged. The `/fonts` namespace is
available before installation and authentication, allows GET/HEAD only, and
returns real 404s for missing assets. Its content-versioned URLs are immutable;
font or stylesheet changes need a new directory digest and updated HTML links.
Shaka's UI uses the same font tokens, with its remote Roboto face removed at
build time and its transformed asset bytes included in the vendor URL.

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

Role-sync regressions can be run independently of an installed application:

```sh
npm run test:sessions        # Session authority, logout and step-up callback tests
npm run test:sso-roles       # Protocol and HTTP tests; database tests require a fixture
npm run test:sso-roles:db    # Complete suite with disposable MariaDB and Redis
```

The database runner creates generated credentials, publishes loopback-only ports
and removes its containers afterward. It uses the `orbstack` Docker context by
default; set `VS_TEST_DOCKER_CONTEXT=default` for a standard Docker installation.
The web image workflow runs this suite before publishing.

Ships as `ghcr.io/dreamxwarden01/videosite-web` (built from `main`). Secrets, certs, and real user
data are git-ignored and must never be committed. Three crypto keys carried from the original
deployment — `SETTINGS_SECRET_ENCRYPTION_KEY`, `MFA_ENCRYPTION_KEY`, `SESSION_SECRET` — have **no
rotation path yet**; don't regenerate them (they sign existing sessions and decrypt sealed settings /
MFA at rest).
