# VideoSite

A private video course platform with hardware-accelerated distributed transcoding, built with Express and Go.

## Features

**Web Server**
- Course and video management with role-based access control and per-user permission overrides
- Chunked resumable uploads with presigned URLs (Cloudflare R2)
- Adaptive bitrate streaming via Shaka Player — HLS for Apple devices (native Safari), MPEG-DASH elsewhere, both served from a single CMAF (fMP4) segment set
- Multi-factor authentication (TOTP, OTP, WebAuthn/passkeys)
- Invitation-based registration with Cloudflare Turnstile CAPTCHA

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
Express Server ---- MySQL/MariaDB
    |
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

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Express 5, Node.js |
| Database | MySQL / MariaDB |
| Frontend | React 19, Vite 8 |
| Video Player | Shaka Player (HLS + DASH, CMAF) |
| Storage | Cloudflare R2 |
| Worker | Go 1.22, FFmpeg |
| Auth | Cookie sessions, Argon2, WebAuthn |
| Email | Nodemailer (SMTP) |

## Prerequisites

- **Node.js** (v20.19+ or v22.12+) and npm
- **Go** 1.22+
- **MySQL** or **MariaDB**
- **FFmpeg** and **FFprobe** (in PATH)
- **Cloudflare R2** bucket with API credentials
- (Optional) **Cloudflare Turnstile** site key for CAPTCHA

## Setup

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

## Environment Variables

Copy `web/.env.example` to `web/.env` and fill in:

| Variable | Description |
|----------|-------------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
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
  server.js              # Express entry point
  config/                # Database, R2, session, email config
  db/                    # Schema and migrations
  middleware/            # Auth, permissions, MFA, installer
  routes/                # API and auth route handlers
  services/              # Business logic
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
```
