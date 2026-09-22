# syntax=docker/dockerfile:1.7
# Headroom publishes glibc/manylinux wheels (no musl/Alpine wheels for its
# ONNX dependency), so all Node stages use Debian Bookworm Slim.
ARG RUNTIME_IMAGE=node:22-bookworm-slim

# Step 1: Build the Next.js app on the native host CPU (BUILDPLATFORM).
# Running Webpack and bundling under native architecture is ~20x faster than QEMU emulation.
# Build on the same glibc Debian base as the runtime so traced Node modules and
# Next.js native helpers match the final image (not Alpine/musl).
FROM --platform=$BUILDPLATFORM ${RUNTIME_IMAGE} AS builder
WORKDIR /app

RUN apt-get update && \
  apt-get install -y --no-install-recommends python3 make g++ && \
  rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install --include=optional --no-audit --no-fund

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Step 2: Compile native C++ modules (better-sqlite3) for the TARGETPLATFORM.
# Only compiles native C++ modules; avoids running heavy Next.js build or extracting 500+ unrelated packages under QEMU.
# This stage must match the glibc Debian runtime below (not Alpine/musl).
FROM ${RUNTIME_IMAGE} AS native-deps
WORKDIR /app

RUN apt-get update && \
  apt-get install -y --no-install-recommends python3 make g++ && \
  rm -rf /var/lib/apt/lists/*

RUN npm init -y && \
  npm install better-sqlite3@12.10.0 bindings file-uri-to-path --no-audit --no-fund

# Tailscale static binaries (bundled so tunnel works in Docker).
# Fetches the latest stable tailscale and tailscaled. Override with --build-arg.
FROM alpine:3.19 AS tailscale
ARG TAILSCALE_VERSION=1.80.3
ARG TARGETARCH
RUN apk add --no-cache curl ca-certificates && \
  mkdir -p /out && \
  TARCH=${TARGETARCH:-amd64} && \
  case "$TARCH" in \
    amd64) TS_ARCH=amd64 ;; \
    arm64) TS_ARCH=arm64 ;; \
    arm) TS_ARCH=arm ;; \
    *) echo "Unsupported arch: $TARCH"; exit 1 ;; \
  esac && \
  curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TS_ARCH}.tgz" -o /tmp/tailscale.tgz && \
  tar -xzf /tmp/tailscale.tgz -C /tmp && \
  cp /tmp/tailscale_${TAILSCALE_VERSION}_${TS_ARCH}/tailscale /out/tailscale && \
  cp /tmp/tailscale_${TAILSCALE_VERSION}_${TS_ARCH}/tailscaled /out/tailscaled && \
  chmod +x /out/tailscale /out/tailscaled

FROM ${RUNTIME_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
# Keep the Node heap conservative so the 512 MB Render container has room for
# the local Headroom proxy next to VansRouter.
ENV NODE_OPTIONS=--max-old-space-size=192
# Local Headroom defaults. VansRouter caps compression requests at 2000 ms and
# fails open; these runtime settings keep the proxy itself lightweight.
ENV HEADROOM_ENABLED=1
ENV HEADROOM_PROXY_ONLY=true
ENV HEADROOM_SUPERVISED=1
ENV HEADROOM_URL=http://127.0.0.1:8787
ENV HEADROOM_HOST=127.0.0.1
ENV HEADROOM_PORT=8787
ENV HEADROOM_TELEMETRY=off
ENV HEADROOM_STATELESS=true
ENV HEADROOM_WORKERS=1
ENV HEADROOM_LIMIT_CONCURRENCY=8
ENV HEADROOM_MAX_CONNECTIONS=16
ENV HEADROOM_MAX_KEEPALIVE=4
ENV HEADROOM_KEEPALIVE_EXPIRY=10
ENV HEADROOM_COMPRESSION_MAX_WORKERS=1
ENV HEADROOM_ANTHROPIC_PRE_UPSTREAM_CONCURRENCY=2
ENV HEADROOM_PERIODIC_TOIN_STATS=0
ENV HEADROOM_NO_SUBSCRIPTION_TRACKING=1
ENV HEADROOM_MALLOC_TRIM=1
ENV HEADROOM_MALLOC_TRIM_INTERVAL_SECONDS=60
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1
ENV TOKENIZERS_PARALLELISM=false
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV MALLOC_ARENA_MAX=2
ENV OMP_NUM_THREADS=1
ENV MKL_NUM_THREADS=1
ENV NUMEXPR_NUM_THREADS=1
ENV PATH=/opt/headroom-venv/bin:$PATH
# API_KEY_SECRET is optional; src/shared/utils/apiKey.js persists a random secret
# under DATA_DIR when no runtime secret is provided.

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
# Boot-time provider seed (scripts/seed-providers.mjs, wired in custom-server.js).
# Needs src/lib (DB driver + migrations, ~500KB, relative imports only).
COPY --from=builder /app/scripts/seed-providers.mjs ./scripts/seed-providers.mjs
COPY --from=builder /app/src/lib ./src/lib
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone tracing may omit packages loaded through dynamic imports.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# SQLite is loaded dynamically by src/lib/db/driver.js; keep the target-architecture
# native driver compiled in native-deps.
COPY --from=native-deps /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=native-deps /app/node_modules/bindings ./node_modules/bindings
COPY --from=native-deps /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
RUN node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close(); console.log('SQLite native driver: better-sqlite3')"
# Bundle Tailscale binaries into /usr/local/bin so they survive the /app/data volume mount.
COPY --from=tailscale /out/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /out/tailscaled /usr/local/bin/tailscaled

# Debian runtime packages, isolated Headroom virtualenv, and the supervisor entrypoint.
# Install only the lightweight proxy core. Do not add [all], [ml], [code],
# PyTorch, CUDA, or heavy embedding packages.
RUN apt-get update && \
  apt-get install -y --no-install-recommends \
    ca-certificates \
    gosu \
    iptables \
    libgomp1 \
    libstdc++6 \
    python3 \
    python3-pip \
    python3-venv \
    zlib1g && \
  rm -rf /var/lib/apt/lists/* && \
  python3 -m venv /opt/headroom-venv && \
  /opt/headroom-venv/bin/pip install --no-cache-dir "headroom-ai[proxy]" && \
  /opt/headroom-venv/bin/headroom --version && \
  /opt/headroom-venv/bin/python -c "import fastapi, uvicorn, onnxruntime; print('Headroom proxy dependencies: fastapi/uvicorn/onnxruntime')" && \
  rm -rf /root/.cache/pip && \
  chown -R root:node /opt/headroom-venv && \
  chmod -R g+rX /opt/headroom-venv && \
  mkdir -p /app/data /app/data-home && \
  chown -R node:node /app /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true && \
  cp ./scripts/docker-entrypoint.sh /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
