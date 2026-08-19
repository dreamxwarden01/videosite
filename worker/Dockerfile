# syntax=docker/dockerfile:1.7
#
# Worker image: Go transcode worker + jellyfin-ffmpeg (NVENC + QSV).
# Build context MUST be `./worker` (see .github/workflows/build-worker.yml).
#
# Two stages so the runtime image carries no Go toolchain — just the static
# binary, ffmpeg runtime, and Debian's TLS roots.

# ---------- Stage 1: build the Go binary ----------
# --platform=$BUILDPLATFORM pins the BUILDER to the machine doing the building
# (the amd64 runner) rather than the target. Go cross-compiles, so an arm64 image
# costs a different GOARCH and nothing else — without this, BuildKit would run the
# whole Go toolchain under QEMU for the arm64 leg and take many times longer.
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . ./
# CGO_ENABLED=0 → fully static binary, no glibc dep. trimpath + -s -w strip
# absolute paths and DWARF debug info; the linux-amd64 binary lands ~13 MB.
# Linux-only build tags (*_linux.go) select the right platform files; the
# darwin/windows variants are excluded by the build constraint.
#
# TARGETOS/TARGETARCH are supplied by BuildKit per requested platform. They MUST
# be declared without defaults: a default shadows the value BuildKit injects, and
# the stage then silently builds for that default instead of the requested
# platform — an `ARG TARGETARCH=amd64` here produced an x86-64 binary inside the
# arm64 image, which would not have run at all.
ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH
RUN go build -trimpath -ldflags='-s -w' -o /out/videosite-worker .


# ---------- Stage 2: runtime ----------
FROM debian:bookworm-slim AS runtime

# jellyfin-ffmpeg7 bundles NVENC, QSV (libvpl + iHD driver), and VA-API
# runtime in a single apt package — no separate intel-media-va-driver,
# libvpl, or NVIDIA encoder headers needed. Jellyfin publishes it for arm64 as
# well as amd64, so the arch comes from dpkg rather than being pinned.
#
# NVENC and QSV are x86 accelerators: an arm64 image gets the same ffmpeg but
# encodes in software unless the host exposes a VA-API device it supports. arm64
# is for running the worker at all on Apple Silicon, not for accelerated
# transcoding there.
#
# Unlike the builder this stage runs target-arch binaries (apt/dpkg), so the
# arm64 leg is emulated via QEMU and is the slow part of a multi-arch build.
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
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" \
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
