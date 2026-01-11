## Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
#
# NOTE:
# Uptime ships with compiled JS in `dist/` committed to the repo.
# This Dockerfile intentionally avoids running `tsc` during image build to reduce network / toolchain flakiness.
#
#
# IMPORTANT (ARM64 / Apple Silicon VMs):
# On some environments (notably Node 20 + npm on alpine), `npm ci` can intermittently produce broken/empty
# node_modules with errors like "Exit handler never called!" and then the runtime crashes with:
#   Cannot find package '/app/node_modules/express/index.js'
# Using a Debian-based image avoids this class of npm/alpine issues and is still lightweight enough for uptime.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Pin npm to a stable version to avoid sporadic npm internal errors like:
#   "npm error Exit handler never called!"
RUN npm i -g npm@9.9.3 \
 && npm --version
# Install production deps.
# NOTE:
# We intentionally avoid BuildKit cache mounts here. On some environments npm can hit an internal error:
#   "npm error Exit handler never called!"
# A small retry loop + cache cleanup makes this far more reliable for CI/VM installs.
#
# Additionally, we keep the install step resilient:
# - retry transient network/DNS failures
# - fall back from `npm ci` to `npm install` if npm hits internal errors
RUN npm config set fund false \
 && npm config set audit false \
 && npm config set progress false \
 && npm config set update-notifier false \
 && npm config set fetch-retries 6 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && ( \
      ok=0; \
      for i in 1 2 3; do \
        echo "[uptime] deps install attempt $i/3"; \
        npm ci --omit=dev --no-audit --no-fund; rc=$?; \
        if [ "$rc" -eq 0 ]; then ok=1; break; fi; \
        echo "[uptime] npm ci failed (rc=$rc); trying npm install (omit=dev)"; \
        rm -rf node_modules || true; \
        npm cache clean --force || true; \
        npm install --omit=dev --no-audit --no-fund; rc2=$?; \
        if [ "$rc2" -eq 0 ]; then ok=1; break; fi; \
        echo "[uptime] npm install failed (rc=$rc2); retrying after backoff..."; \
        rm -rf node_modules || true; \
        npm cache clean --force || true; \
        sleep 3; \
      done; \
      test "$ok" -eq 1; \
    ) \
 && test -f /app/node_modules/express/package.json

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY config ./config
EXPOSE 8099
CMD ["node","dist/server.js"]



