## Ethora.com platform, copyright: Dappros Ltd (c) 2026, all rights reserved
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY config ./config
COPY tsconfig.json package.json ./
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY config ./config
EXPOSE 8099
CMD ["node","dist/server.js"]


