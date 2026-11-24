# Build context: repository root. npm's lockfile remains the dependency authority.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
COPY package.json package-lock.json ./
COPY apps/backend-api/package.json apps/backend-api/
COPY apps/web/package.json apps/web/
COPY apps/workers/package.json apps/workers/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY vendor/next-eslint-glob/ vendor/next-eslint-glob/
COPY vendor/zod-v3/blast-zod-v3-3.25.76.tgz vendor/zod-v3/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @blast/backend-api && npm cache clean --force

# This stage contains Bun, production dependencies and server sources only.
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=dependencies /app/node_modules/ node_modules/
COPY --from=dependencies /app/packages/core/ packages/core/
COPY --from=dependencies /app/packages/server/ packages/server/
COPY --from=dependencies /app/apps/backend-api/ apps/backend-api/
COPY packages/core/src/ packages/core/src/
COPY packages/server/src/ packages/server/src/
COPY apps/backend-api/src/ apps/backend-api/src/
COPY packages/server/assets/ packages/server/assets/
RUN bun packages/server/src/lib/verify-card-assets.ts
RUN test "$(bun --version)" = 1.4.2
USER bun
WORKDIR /app/apps/backend-api
CMD ["bun", "run", "src/main.ts"]
