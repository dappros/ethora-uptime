## Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
FROM node:20-alpine AS deps
WORKDIR /app
# Install deps with better resilience to transient DNS/network issues (EAI_AGAIN).
# Use lockfile when available for reproducibility.
COPY package.json package-lock.json tsconfig.json ./
RUN npm config set fund false \
 && npm config set audit false \
 && npm config set fetch-retries 6 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && (npm ci --include=dev --no-audit --no-fund || npm install --include=dev --no-audit --no-fund)

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY config ./config
COPY tsconfig.json package.json ./
RUN npm run build
RUN npm prune --omit=dev || true

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY config ./config
EXPOSE 8099
CMD ["node","dist/server.js"]



