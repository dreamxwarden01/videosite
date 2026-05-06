# VideoSite

A private video course platform with hardware-accelerated distributed transcoding, built with Express and Go.

## Features

**Web Server**
- Course and video management with role-based access control and per-user permission overrides
- Chunked resumable uploads with presigned URLs (Cloudflare R2)
- Adaptive bitrate streaming via Shaka Player — HLS for Apple devices (native Safari), MPEG-DASH elsewhere, both served from a single CMAF (fMP4) segment set
- Multi-factor authentication (TOTP, OTP, WebAuthn/passkeys), including username-less passkey "quick sign in" (single round trip)
- Invitation-based registration with Cloudflare Turnstile CAPTCHA — verification runs at the origin by default, or can be moved to the edge via the optional `turnstile-gate` Cloudflare Worker

**Transcoding Worker**
- Unified Go binary for macOS (arm64) and Windows (amd64) via build tags
- Hardware-accelerated encoding: VideoToolbox (macOS), NVENC / AMF / QSV (Windows)
- Multi-GPU support on Windows with per-encoder concurrent job scheduling
- Automatic encoder detection and load-balanced job distribution
- EBU R128 two-pass audio loudness normalization
- Smart profile filtering: skips upscaling, remuxes when re-encoding is unnecessary

## Architecture

```
Browser (React SPA)
    |
    v
Cloudflare Edge (optional turnstile-gate Worker — gates 5 sign-in/registration POSTs)
    |
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

1. User uploads a video through the browser in chunks (presigned PUT to R2)
2. Server creates a processing job; worker picks it up via polling
3. Worker downloads the source from R2, transcodes to multi-bitrate CMAF (fMP4) with HLS and DASH manifests, uploads segments back to R2
4. Browser streams the video using Shaka Player with HMAC-authenticated URLs — the player picks HLS or DASH based on client capabilities

Redis sits between the server and DB to absorb hot reads and high-frequency writes. Sessions, permissions, settings, and video / course / user / enrollment metadata are read-cached with explicit invalidation. Watch progress (`/api/updatewatch`) and worker transcoding heartbeats land in Redis only and a background flusher drains them to DB every 15 minutes — eliminating per-tick DB writes during active playback and transcoding. An anti-cheat rate limiter on `/api/updatewatch` rejects claimed watch time exceeding wall-clock elapsed.

The optional `cloudflare/workers/turnstile-gate` Worker, when deployed, sits in front of the five Turnstile-gated POST endpoints (`/api/login`, `/api/register/start`, `/api/register/complete`, `/api/password-reset/request`, `/api/auth/passkey/options`). It verifies the token via Cloudflare's siteverify, strips it from the body, and forwards to origin. The origin admin toggle ("Cloudflare → Turnstile Verification at Worker") tells the Express layer to skip its own siteverify call when the Worker is in front. Off by default — opt in from the admin Settings page.

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
| Edge (optional) | Cloudflare Workers (Wrangler 3+) |
| Auth | Cookie sessions, Argon2, WebAuthn |
| Email | Nodemailer (SMTP) |

## Prerequisites

- **Node.js** (v20.19+ or v22.12+) and npm
- **Go** 1.25+
- **MySQL** or **MariaDB**
- **Redis** 6+ — see [Redis configuration](#redis-configuration) below
- **FFmpeg** and **FFprobe** (in PATH)
- **Cloudflare R2** bucket with API credentials
- (Optional) **Cloudflare Turnstile** site key for CAPTCHA

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

### Worker

The worker uses an interactive first-run setup to configure server connection, API keys, and mTLS.

```bash
cd worker

# macOS (native)
go build -o videosite-worker .
./videosite-worker

# Windows (cross-compile from macOS)
GOOS=windows GOARCH=amd64 go build -o videosite-worker.exe .
```

On first run, the worker will:
1. Prompt for the server hostname and API key credentials
2. Optionally set up mTLS with Cloudflare client certificates
3. Detect available hardware encoders and generate `capabilities.json`

Edit `capabilities.json` to enable/disable encoders or adjust per-encoder concurrent job limits.

### Cloudflare Worker (optional)

Deploy `cloudflare/workers/turnstile-gate/` to verify Turnstile tokens at the edge instead of the origin. Full setup steps (route patterns, secret, coordination order with the admin toggle) live in [`cloudflare/workers/turnstile-gate/README.md`](cloudflare/workers/turnstile-gate/README.md). Skip if you don't need edge verification — origin-side verification is the default and works without any Worker.

## Environment Variables

Copy `web/.env.example` to `web/.env` and fill in:

| Variable | Description |
|----------|-------------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | Redis connection (password optional, DB defaults to 0) |
| `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare R2 storage |
| `R2_PUBLIC_DOMAIN` | Custom domain for video delivery |
| `SESSION_SECRET` | Secret for session encryption |
| `PORT` | Server port (default: 3000) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | SMTP email |
| `SMTP_FROM_NAME`, `SMTP_FROM_ADDRESS`, `SMTP_REPLY_TO` | Email sender info |
| `MFA_ENCRYPTION_KEY` | 32-byte hex key for encrypting MFA secrets |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile CAPTCHA |

## Project Structure

```
web/
  server.js              # Express entry point + graceful shutdown
  api-schema.json        # OpenAPI 3.0 schema (Cloudflare API Shield-compatible)
  config/                # Database, R2, session, email config
  db/                    # Schema and migrations
  middleware/            # Auth, permissions, MFA, installer
  routes/                # API and auth route handlers
  services/              # Business logic
    cache/               # Per-resource Redis caches (read-through + invalidation)
    redis.js             # ioredis client + boot connect / sanity warnings
    flusher.js           # Periodic write-coalescing (sessions, watch, transcode)
  client/                # React SPA (Vite)
    src/
      components/        # Shared UI components
      context/           # Auth, site, toast contexts
      pages/             # Page components
      hooks/             # Custom React hooks
      styles/            # CSS

worker/
  main.go                # Entry point (shared)
  main_darwin.go         # macOS startup banner
  main_windows.go        # Windows startup banner
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

cloudflare/
  workers/
    turnstile-gate/      # Optional edge Turnstile verification Worker
      src/index.js       # Fetch handler — siteverify + strip + forward
      wrangler.jsonc     # Routes + compat date (secret set via dashboard)
      README.md          # Deploy steps + admin-toggle coordination rules
```
