# syntax=docker/dockerfile:1.7
#
# Worker image: Go transcode worker + jellyfin-ffmpeg (NVENC + QSV).
# Build context MUST be `./worker` (see .github/workflows/build-worker.yml).
#
# Two stages so the runtime image carries no Go toolchain — just the static
# binary, ffmpeg runtime, and Debian's TLS roots.

# ---------- Stage 1: build the Go binary ----------
FROM golang:1.25-bookworm AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . ./
# CGO_ENABLED=0 → fully static binary, no glibc dep. trimpath + -s -w strip
# absolute paths and DWARF debug info; the linux-amd64 binary lands ~13 MB.
# Linux-only build tags (*_linux.go) select the right platform files; the
# darwin/windows variants are excluded by the build constraint.
ENV CGO_ENABLED=0 GOOS=linux GOARCH=amd64
RUN go build -trimpath -ldflags='-s -w' -o /out/videosite-worker .


# ---------- Stage 2: runtime ----------
FROM debian:bookworm-slim AS runtime

# jellyfin-ffmpeg7 bundles NVENC, QSV (libvpl + iHD driver), and VA-API
# runtime in a single apt package — no separate intel-media-va-driver,
# libvpl, or NVIDIA encoder headers needed.
#
# Host responsibilities (NOT in the image):
#   NVIDIA: nvidia-container-toolkit installed, run with `--gpus all`
#   Intel:  bind-mount /dev/dri (`--device /dev/dri:/dev/dri`)
RUN set -eux \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
        > /etc/apt/sources.list.d/jellyfin.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        jellyfin-ffmpeg7 \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Jellyfin installs to /usr/lib/jellyfin-ffmpeg/. Symlink into /usr/local/bin
# so the worker's exec.LookPath("ffmpeg")/("ffprobe") finds them.
RUN ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg  /usr/local/bin/ffmpeg \
    && ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe

# The worker writes config.json, capabilities.json, cert/, logs/, temp/ in
# its cwd. Making /data the cwd lets the operator bind a single volume for
# all persistent state.
WORKDIR /data
COPY --from=builder /out/videosite-worker /usr/local/bin/videosite-worker

# Runs as root by default — /dev/dri/renderD<N> on the host is typically
# root:render 660, and GPU passthrough (NVIDIA toolkit / DRI device perms)
# is a docker-compose-side concern. The other session can add a `user:`
# directive + render/video group GIDs once the server layout is settled.
CMD ["videosite-worker"]
