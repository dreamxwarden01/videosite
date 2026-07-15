# VideoSite

A private video course platform with hardware-accelerated distributed transcoding, built with Express and Go. Identity is delegated to **[DreamSSO](https://github.com/dreamxwarden01/dreamsso)** — videosite is an OpenID Connect **relying party** and holds no passwords of its own.

## Features

**Web Server**
- **OpenID Connect relying party** of DreamSSO — sign-in, registration, MFA, and password reset all live in the SSO. A user's global identity is the SSO-minted `sub` (UUIDv7), used directly as videosite's own `user_id`. videosite keeps its own **roles, permissions, and content** (courses, videos, materials, playback, transcoding), re-checked on every request. Step-up for sensitive admin actions is delegated to the SSO (redirect takeover).
- Course and video management with role-based access control and per-user permission overrides
- Chunked resumable uploads with presigned URLs (Cloudflare R2)
- Adaptive bitrate streaming via Shaka Player — HLS for Apple devices (native Safari), MPEG-DASH elsewhere, both served from a single CMAF (fMP4) segment set

**Transcoding Worker**
- Unified Go binary for macOS (arm64), Windows (amd64), and Linux (amd64) via build tags
- Hardware-accelerated encoding: VideoToolbox (macOS), NVENC / QSV (Windows + Linux)
- Multi-GPU support on Windows / Linux with per-encoder concurrent job scheduling
- Automatic encoder detection and load-balanced job distribution
- EBU R128 two-pass audio loudness normalization
- Smart profile filtering: skips upscaling, remuxes when re-encoding is unnecessary
- Source GOP probed up-front (first 60s of packets); when the source has a constant GOP ≤ 2s, every rendition adopts the source frame cadence so all segments line up — remuxed top-resolution profiles inherit source IDRs and transcoded lower-resolution profiles force-key-frame to the same time grid. DASH manifest collapses from `<SegmentTimeline>` (one entry per segment per rendition) to per-Representation `<SegmentTemplate duration="…">` when segments are uniform, scaling O(profiles) instead of O(segments × profiles); μs-precision timescale eliminates declared-vs-actual drift on multi-hour content. Video and audio AdaptationSets decide uniformity independently — video usually compacts, audio falls back to `<SegmentTimeline>` only when the AAC encoder's per-segment drift exceeds tolerance.

## Architecture

```
Browser (React SPA)
    |
    |  OpenID Connect (authorization-code)  ──►  DreamSSO (identity provider)
    v
Express Server ---- MySQL/MariaDB
    |             \
    |              `--- Redis (cache, sessions, write coalescing)
    v
Cloudflare R2 (S3-compatible storage)
    ^
    |
Go Worker(s) --- FFmpeg
```

1. Sign-in is the OIDC authorization-code flow to DreamSSO; videosite issues its own session cookie after the callback and maps the SSO `sub` to its `user_id`
2. User uploads a video through the browser in chunks (presigned PUT to R2)
3. Server creates a processing job; worker picks it up via polling
4. Worker downloads the source from R2, transcodes to multi-bitrate CMAF (fMP4) with HLS and DASH manifests, uploads segments back to R2
5. Browser streams the video using Shaka Player with HMAC-authenticated URLs — the player picks HLS or DASH based on client capabilities

Redis sits between the server and DB to absorb hot reads and high-frequency writes. Sessions, permissions, settings, and video / course / user / enrollment metadata are read-cached with explicit invalidation. Watch progress (`/api/watch-progress`) and worker transcoding heartbeats land in Redis only and a background flusher drains them to DB every 15 minutes — eliminating per-tick DB writes during active playback and transcoding. An anti-cheat rate limiter on `/api/watch-progress` rejects claimed watch time exceeding wall-clock elapsed.

**Authentication.** The Express layer is the OIDC relying party (`web/lib/oidc.js`). videosite self-mints an Ed25519 **client key** and serves the public half at `/.well-known/jwks.json`; the SSO fetches it (no key handoff). The SSO federates *who you are*; *what you can do* is videosite's own role/permission engine, re-evaluated on every request. Sensitive admin actions require a fresh step-up window, which redirects to the SSO and back. Sensitive `site_settings` rows — the HMAC playback secret and the Cloudflare Access service-token secret — are encrypted at rest with `SETTINGS_SECRET_ENCRYPTION_KEY` (AES-256-GCM, `enc:v1:iv:tag:ct`).

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Express 5, Node.js |
| Database | MySQL / MariaDB |
| Cache | Redis 6+ (ioredis) |
| Frontend | React 19, Vite 8 |
| Video Player | Shaka Player (HLS + DASH, CMAF) |
| Storage | Cloudflare R2 |
| Worker | Go 1.25, FFmpeg |
| Identity | OpenID Connect — DreamSSO (login-first; `sub` = `user_id`) |
| Sessions | Signed cookie sessions (issued after the OIDC callback) |
| Worker auth | Bearer API keys, Argon2id-hashed at rest |

## Prerequisites

- A running **[DreamSSO](https://github.com/dreamxwarden01/dreamsso)** instance — the identity provider videosite authenticates against (registered as an OIDC client at first-run)
- **Node.js** (v20.19+ or v22.12+) and npm
- **Go** 1.25+
- **MySQL** or **MariaDB**
- **Redis** 6+ — see [Redis configuration](#redis-configuration) below
- **FFmpeg** and **FFprobe** (in PATH)
- **Cloudflare R2** bucket with API credentials

## Setup

### Redis configuration

Redis is required (sessions, cache, write coalescing). The server PINGs Redis on boot and exits with a clear error if unreachable. Configure these in `redis.conf` before starting Redis:

```
maxmemory 8gb                      # cap memory; adjust to taste
maxmemory-policy volatile-lru      # only evict TTL'd keys — protects dirty progress
appendonly yes                     # AOF persistence
appendfsync everysec               # ~1s worst-case loss on crash
```

`volatile-lru` is important: dirty progress hashes (`progress:watch:*`, `progress:transcode:*`) and the `dirty:*` sets carry **no TTL** so they're never evicted, even under memory pressure. Cache entries (sessions, perms, settings, video / course / user / enrollment metadata — all with TTLs) age out normally. The boot path warns if either setting differs from the recommended values but doesn't block.

Quick install:

```bash
# macOS
brew install redis && brew services start redis

# Debian / Ubuntu
sudo apt install redis-server && sudo systemctl enable --now redis-server
```

### Web Server

```bash
cd web
cp .env.example .env    # fill in your credentials
npm install
npm run dev             # development (auto-restart on changes)
npm start               # production
```

The server runs database migrations automatically on startup. The React client is served from `client/dist/` — rebuild it after frontend changes:

```bash
cd web/client
npx vite build
```

For frontend development with hot reload:

```bash
cd web/client
npx vite                # dev server on :5173, proxies API to :3000
```

**First run.** videosite boots unconfigured behind a token-locked `/install` wizard: infrastructure → site → SSO connection (issuer, client id, portal URL) → optional mTLS → the **connect** hard-gate that registers videosite at the SSO and publishes its role catalogue. No account is created at install — whoever holds the SSO's root org role signs in and lands as videosite's superadmin (the SSO's `roles.sync` re-points the top org role at videosite's top role).

### Worker

The worker uses an interactive first-run setup to configure server connection, API keys, and mTLS.

```bash
cd worker

# macOS (native arm64)
go build -o videosite-worker-darwin-arm64 .
./videosite-worker-darwin-arm64

# Windows (cross-compile from macOS)
GOOS=windows GOARCH=amd64 go build -o videosite-worker-windows-amd64.exe .

# Linux (cross-compile from macOS)
GOOS=linux GOARCH=amd64 go build -o videosite-worker-linux-amd64 .
```

On Linux the FFmpeg build must include `--enable-libmfx` / OneVPL for QSV and `--enable-nvenc --enable-cuda-llvm` for NVENC. The `jellyfin/ffmpeg` packages and `BtbN/FFmpeg-Builds` static binaries both ship with the required codecs. (Dockerizing the Linux worker is a separate follow-up — pick a base image that already bundles a hardware-accelerated FFmpeg, mount `config.json` / `capabilities.json` as volumes, pass `--gpus all` for NVENC and `--device /dev/dri` for QSV.)

On first run, the worker will:
1. Prompt for the server hostname and API key credentials
2. Optionally set up mTLS with Cloudflare client certificates
3. Detect available hardware encoders and generate `capabilities.json`

Edit `capabilities.json` to enable/disable encoders or adjust per-encoder concurrent job limits.

## Environment Variables

Copy `web/.env.example` to `web/.env` and fill in. OIDC/SSO connection details (issuer, client id, portal URL) are **not** environment variables — they're set through the `/install` wizard and stored in `site_settings`; the OIDC client key is a file (`OIDC_CLIENT_KEY_FILE`).

| Variable | Description |
|----------|-------------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | Redis connection (password optional, DB defaults to 0) |
| `REDIS_KEY_PREFIX` | Project-level key prefix (defaults to `videosite:`) so one Redis instance can host multiple apps |
| `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 storage |
| `R2_PUBLIC_DOMAIN` | Custom domain for video delivery |
| `SESSION_SECRET` | Secret for session cookie signing |
| `PORT` | Server port (default: 3000) |
| `MFA_ENCRYPTION_KEY` | 32-byte hex key for MFA secrets at rest (preserved from the original deployment) |
| `SETTINGS_SECRET_ENCRYPTION_KEY` | 32-byte hex key for encrypting sensitive `site_settings` rows (HMAC playback secret, CF Access service-token secret). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

> `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, and `SETTINGS_SECRET_ENCRYPTION_KEY` are carried from the original deployment — they sign existing sessions and decrypt MFA secrets / sealed settings at rest. **Key rotation isn't wired up yet** (there's no re-encryption path), so don't regenerate them — e.g. by re-running install — or you'll drop every session and orphan the data encrypted under the old keys.

## Project Structure

```
web/
  server.js              # Express entry point + graceful shutdown
  api-schema.json        # OpenAPI 3.0 schema (Cloudflare API Shield-compatible)
  config/                # Database, R2, session config
  db/                    # Schema and migrations
  lib/                   # OIDC relying-party client (lib/oidc.js) + helpers
  middleware/            # Auth, permissions, step-up, installer
  routes/                # API + the OIDC RP flow (/auth/*) + admin + worker API
  services/              # Business logic
    cache/               # Per-resource Redis caches (read-through + invalidation)
  client/                # React SPA (Vite)
    src/
      components/        # Shared UI components
      context/           # Auth, site, toast, step-up contexts
      pages/             # Page components
      hooks/             # Custom React hooks
      styles/            # CSS

worker/
  main.go                # Entry point (shared)
  main_darwin.go         # macOS startup banner
  main_windows.go        # Windows startup banner
  main_linux.go          # Linux startup banner
  internal/
    api/                 # Server communication, uploads, retries
    auth/                # Bearer session handling with the server
    config/              # config.json and capabilities.json
    hardware/            # Encoder detection (per-platform)
    mtls/                # Client certificate setup
    slot/                # Job scheduling and slot management
    transcoder/          # FFmpeg, ffprobe, profiles, HLS + DASH/CMAF manifests
    ui/                  # Terminal UI — per-job progress bars with scroll-above log
    util/                # Helpers
    worker/              # Main loop, console commands, progress
```

## Deployment

Ships as `ghcr.io/dreamxwarden01/videosite-web` (built from `main`). Secrets, certs, and real user data are git-ignored and must never be committed. The three carried crypto keys above have no rotation path yet — don't regenerate them (see the note under Environment Variables).
