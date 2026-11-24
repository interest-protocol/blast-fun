# syntax=docker/dockerfile:1
# One image for the web repository's long-running workers on Render
# (docs/deploy/LAUNCH-DEPLOY.md, "Worker packaging"). Each worker is its own
# Render service built from this file; the Render service settings start it with
# `/app/apps/workers/start.sh <worker>`, a name from apps/workers/src/processes.ts
# (`start.sh --list` prints them).
#
# The workers run their TypeScript sources directly, exactly as the npm scripts
# do (Node's type stripping plus scripts/register-runtime-types.mjs for SDK source and
# extensionless imports), so there is no build step. None of them loads a .tsx
# file, so every devDependency stays out: `npm ci --omit=dev`. (`typescript` is
# still installed: @mysten/sui's gql.tada declares it as a required peer, so the
# lockfile marks it a production package. The workers never load it.) Install
# scripts are skipped: no package the workers load needs one.
#
# Nothing secret is in the image: every value comes from the service's
# variables at start. The build context is the repository root (dockerfilePath
# in the Render service settings); the Dockerfile.dockerignore beside this file
# keeps it to the files copied below.
#
# node:24.18.0-bookworm-slim, pinned by digest (resolved 2026-10-07; the tag is
# informational). Node 24 is the version the repository's tests run on, and the
# hooks need node:module's registerHooks and stripTypeScriptTypes.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production \
    TZ=UTC \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# npm 12 applies the manifest repairs recorded in lockfile v4.
RUN npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund

# Dependencies first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/workers/package.json apps/workers/
COPY packages/core/package.json packages/core/
COPY vendor/next-eslint-glob/ vendor/next-eslint-glob/
COPY vendor/zod-v3/ vendor/zod-v3/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @blast/workers \
    && rm -rf apps/web \
    && npm cache clean --force

# What the workers load: the loader hooks, the core package's sources and the
# workers package (its entry points and server modules; tests stay out).
# Owned by root, so the worker cannot change them.
COPY scripts/register-runtime-types.mjs scripts/
COPY packages/core/src/ packages/core/src/
COPY apps/workers/ apps/workers/

# The image's unprivileged user (uid 1000).
USER node

# Each service's start command names its worker; without one, start.sh prints
# its usage and exits 2.
CMD ["/app/apps/workers/start.sh"]
