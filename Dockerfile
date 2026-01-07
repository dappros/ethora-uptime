## Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
#
# NOTE:
# Uptime ships with compiled JS in `dist/` committed to the repo.
# This Dockerfile intentionally avoids running `tsc` during image build to reduce network / toolchain flakiness.
#
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set fund false \
 && npm config set audit false \
 && npm config set fetch-retries 6 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund)

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY config ./config
EXPOSE 8099
CMD ["node","dist/server.js"]



