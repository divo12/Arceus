# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────
# Arceus API — single common Dockerfile.
#
# Used by:
#   • Railway (per railway.toml: dockerfilePath = "Dockerfile")
#   • Any other generic container host (Fly, Render, Cloud Run, etc.)
#
# NOT used by Vercel — the web app deploys directly via apps/web/vercel.json.
# This image only ships the API.
# ─────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22.12-slim

# ── deps ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# git is required at install + runtime by the workspace manager.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy ONLY package manifests of workspaces that actually exist on disk,
# so Docker can cache the install plan. apps/web2 is in workspaces glob
# but has no package.json — npm tolerates, but Dockerfile COPY does not,
# so it's omitted intentionally.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# apps/tui is intentionally omitted — it's an ink/React CLI we don't ship
# in the API image, and its postinstall script (`fix-ink-react.mjs`) only
# runs if its package.json is present.
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/hippocampus/package.json packages/hippocampus/
COPY packages/company-runtime/package.json packages/company-runtime/
COPY packages/runtime-shared/package.json packages/runtime-shared/
COPY packages/task-engine/package.json packages/task-engine/
COPY packages/arceus-mcp/package.json packages/arceus-mcp/

RUN npm ci --include=dev

# ── build ────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY opencode.json* ./
COPY .opencode/ ./.opencode/

# Compile every workspace the API imports from. `--if-present` keeps it
# tolerant of packages without a build script.
RUN npm run build --workspace @arceus/contracts --if-present \
 && npm run build --workspace @arceus/runtime-shared --if-present \
 && npm run build --workspace @arceus/db --if-present \
 && npm run build --workspace @arceus/hippocampus --if-present \
 && npm run build --workspace @arceus/company-runtime --if-present \
 && npm run build --workspace @arceus/task-engine --if-present \
 && npm run build --workspace @arceus/mcp --if-present \
 && npm run build --workspace @arceus/api

# Strip dev deps from the runtime layer.
RUN npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS production
WORKDIR /app

# git: workspace manager (init/commit/tag/bundle).
# tar: local-fallback exportTarball path (Spec 36 Phase A.2).
# curl: HEALTHCHECK probe.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git tar curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for the running process.
RUN groupadd -g 1001 arceus && useradd -u 1001 -g arceus -m -s /bin/bash arceus

# Pin the OpenCode CLI version the API spawns at runtime.
ARG OPENCODE_VERSION=1.3.17
ARG TSX_VERSION=4.19.3
# tsx is the runtime: cross-package imports resolve to .ts source via
# package.json "main": "./src/index.ts" entries, so we run TypeScript
# directly rather than try to compose pre-compiled dist/ folders.
RUN npm install -g opencode-ai@${OPENCODE_VERSION} tsx@${TSX_VERSION}

# Copy hoisted node_modules + workspace tree + compiled API.
COPY --from=build --chown=arceus:arceus /app/node_modules ./node_modules
COPY --from=build --chown=arceus:arceus /app/package.json ./
COPY --from=build --chown=arceus:arceus /app/tsconfig.base.json ./
COPY --from=build --chown=arceus:arceus /app/packages ./packages
COPY --from=build --chown=arceus:arceus /app/apps/api ./apps/api
COPY --from=build --chown=arceus:arceus /app/opencode.json ./opencode.json
COPY --from=build --chown=arceus:arceus /app/.opencode ./.opencode

# Per-company workspace root + bundle cache.
# /app/workspace is a fixed path OpenCode mkdir's at warm-up time;
# create it owned by `arceus` so the non-root runtime can write to it.
RUN mkdir -p /var/lib/arceus/workspaces /app/workspace \
    && chown -R arceus:arceus /var/lib/arceus /app/workspace

COPY --chown=arceus:arceus docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER arceus

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    ARCEUS_WORKSPACE_ROOT=/var/lib/arceus/workspaces

VOLUME ["/var/lib/arceus"]

EXPOSE 4000

# /api/control-plane/status returns 200 with healthy:true once bootstrap
# completes, even before any company exists. /health is also acceptable
# but its presence varies by branch — control-plane status is safer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:${PORT}/api/control-plane/status > /dev/null || exit 1

# Workspace packages declare "main": "./src/index.ts", so cross-package
# imports resolve to TypeScript source files. Use tsx (not node) so those
# .ts imports load via the tsx ESM loader.
#
# Call tsx DIRECTLY (not via `npx`/`npm exec`) so PID 1 is the node
# process itself. With npm as PID 1, any SIGTERM forwarded through the
# wrapper bounces the container — the API saw graceful-shutdown +
# container restart loops with double OpenCode warm-ups as a result.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["tsx", "apps/api/src/server.ts"]
