# syntax=docker/dockerfile:1.7
#
# Web image: Express server + built React/Vite SPA, served on $PORT (3000).
# Build context MUST be `./web` (see .github/workflows/build-web.yml).
#
# Three stages so the runtime image carries neither the Vite toolchain nor
# any native-compilation toolchain — just node + production deps + built
# assets.

# ---------- Stage 1: build the React/Vite client ----------
FROM node:22-bookworm-slim AS client-builder
WORKDIR /build
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build


# ---------- Stage 2: install production server deps ----------
FROM node:22-bookworm-slim AS server-deps
# argon2 ships glibc prebuilds, so this usually isn't exercised — but keep
# python3+make+g++ available in case a transitive native dep falls back to
# source. Lives in this stage only; the runtime image below doesn't inherit.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ---------- Stage 3: runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Server source. Listing each path explicitly so unrelated files (drafts,
# logs, audits, sibling old/ trees) can never accidentally land in the image
# even if .dockerignore drifts.
COPY package.json ./
COPY server.js ./
COPY api-schema.json ./
COPY config/ ./config/
COPY db/ ./db/
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY services/ ./services/
COPY scripts/ ./scripts/

# Production node_modules + built client bundle from the earlier stages.
COPY --from=server-deps    /build/node_modules ./node_modules
COPY --from=client-builder /build/dist         ./client/dist

# Drop root for the runtime process. The `node` user (UID 1000) ships in the
# official node image; COPY default 644 / 755 perms are world-readable so it
# can read every file we just copied.
USER node

EXPOSE 3000
CMD ["node", "server.js"]
