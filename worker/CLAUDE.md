# Videosite Worker (Unified) — Project Notes

## Environment
- **OS targets**: macOS (arm64 — Apple Silicon) and Windows (amd64)
- **Language**: Go 1.22
- **Build machine**: macOS (native build + cross-compile for Windows)

## Build

```bash
# macOS (native)
cd /Users/marcellophillips/videosite-project/worker
go build -o videosite-worker .

# Windows (cross-compile from macOS)
cd /Users/marcellophillips/videosite-project/worker
GOOS=windows GOARCH=amd64 go build -o videosite-worker.exe .
```

**IMPORTANT: After every compile, check `ls -l` on the binary to verify the "last modified" timestamp actually changed. The Go compiler can silently fail with no error output — the command exits 0 but produces no new binary. Always confirm the timestamp moved forward.**

## Quick compile check (all packages, both platforms)

```bash
cd /Users/marcellophillips/videosite-project/worker && go build ./...
cd /Users/marcellophillips/videosite-project/worker && GOOS=windows GOARCH=amd64 go build ./...
```

## Project Structure

This is a unified worker merged from two previously separate projects (`worker-macos/` and `worker-windows/`). It uses Go build tags (`_darwin.go` / `_windows.go` file suffixes) to compile platform-specific code for each target.

- Go transcoding worker that polls the videosite server for jobs
- Downloads source video from R2, transcodes to HLS with FFmpeg, uploads segments back to R2
- Communicates with server via authenticated REST API (`internal/api/`)
- Job lifecycle managed in `internal/slot/job.go`
- Worker main loop and console commands in `internal/worker/worker.go`

## Platform-specific files

The following files have platform variants selected at compile time by Go build tags:

| Area | darwin (macOS) | windows |
|------|---------------|---------|
| Hardware detection | `hardware/detect_darwin.go` | `hardware/detect_windows.go` |
| Encoder constants | `hardware/encoder_darwin.go` | `hardware/encoder_windows.go` |
| HLS transcoding | `transcoder/hls_darwin.go` | `transcoder/hls_windows.go` |
| Slot manager | `slot/manager_darwin.go` | `slot/manager_windows.go` |
| HW decode check | `slot/job_darwin.go` | `slot/job_windows.go` |
| Capabilities reload | `config/capabilities_darwin.go` | `config/capabilities_windows.go` |
| System proxy | `api/proxy_darwin.go` | `api/proxy_windows.go` |
| Startup banner | `main_darwin.go` | `main_windows.go` |
| Registration meta | `worker/worker_darwin.go` | `worker/worker_windows.go` |

Everything else is shared code that compiles identically on both platforms.

## macOS-specific notes

### Hardware acceleration
- Uses VideoToolbox (VT) via FFmpeg's `h264_videotoolbox` encoder
- Three tiers: (1) VT hw decode + scale_vt + VT hw encode, (2) CPU decode + VT hw encode, (3) libx264 full SW
- VT runs on the dedicated Media Engine, not GPU — Activity Monitor GPU% will show 0%

### Chip detection & concurrent jobs
- Reads `machdep.cpu.brand_string` via `sysctl -n`
- Parses Apple Silicon tier: Base=1, Pro=1, Max=2, Ultra=4 concurrent jobs (matches media engine count)
- User-configurable in `capabilities.json`

### Proxy
- Reads macOS system proxy via `scutil --proxy` (HTTPS then HTTP)
- Falls back to HTTPS_PROXY / HTTP_PROXY env vars

## Windows-specific notes

### Hardware acceleration
- Supports NVENC (NVIDIA), AMF (AMD), QSV (Intel) — multiple GPUs simultaneously
- Each GPU gets its own encoding slot with device index targeting
- NVENC: full GPU pipeline via CUDA (scale_cuda), AMF: D3D11VA decode + CPU scale, QSV: vpp_qsv scale (no padding)

### GPU detection
- NVIDIA: `nvidia-smi --query-gpu=name,gpu_uuid,index`
- AMD/Intel: PowerShell `Get-CimInstance Win32_VideoController`

### Concurrent jobs
- Defaults to number of enabled hardware encoders (or 1 for software-only)

### Proxy
- Reads Windows registry `HKCU\...\Internet Settings` (ProxyEnable + ProxyServer)
- Falls back to HTTPS_PROXY / HTTP_PROXY env vars

## capabilities.json

macOS example:
```json
{
  "chip_model": "Apple M4",
  "chip_tier": "Base",
  "concurrent_jobs": 1,
  "encoders": [
    {
      "number_id": 0,
      "hardware_id": "apple-videotoolbox",
      "name": "VideoToolbox (Apple M4)",
      "encoder_type": "VIDEOTOOLBOX",
      "enable": true,
      "device_index": 0
    }
  ]
}
```

Windows example:
```json
{
  "encoders": [
    {
      "number_id": 0,
      "hardware_id": "GPU-xxxx",
      "name": "NVIDIA GeForce RTX 4090",
      "encoder_type": "NVENC",
      "enable": true,
      "device_index": 0
    }
  ]
}
```

## Legacy

The original separate projects (`worker-macos/` and `worker-windows/`) are kept as-is for reference. This unified `/worker` directory is the canonical source going forward.
