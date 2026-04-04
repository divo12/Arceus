FROM node:22-trixie-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/plugins/create-paperclip-plugin/package.json packages/plugins/create-paperclip-plugin/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/

RUN pnpm install --frozen-lockfile

FROM base AS python-deps
WORKDIR /app/services/hippocampus-runtime/python

COPY services/hippocampus-runtime/python/pyproject.toml ./
COPY services/hippocampus-runtime/python/README.md ./
COPY services/hippocampus-runtime/python/src ./src

# Install CPU-only torch first to prevent sentence-transformers from pulling
# GPU/CUDA wheels (~1.5 GB of nvidia-cuda-* packages not needed on Railway).
RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir --upgrade pip \
  && .venv/bin/pip install --no-cache-dir \
    torch \
    --index-url https://download.pytorch.org/whl/cpu \
  && .venv/bin/pip install --no-cache-dir .

FROM base AS build
WORKDIR /app

COPY --from=deps /app /app
COPY . .

RUN test -f server/ui-dist/index.html \
  && pnpm --filter @paperclipai/plugin-sdk build \
  && pnpm --filter @paperclipai/server build \
  && test -f server/dist/index.js

FROM base AS production
WORKDIR /app

# Copy only what is needed at runtime — skip source files, test files,
# the UI build source, CLI tooling, and other build-only artifacts.

# pnpm workspace manifests and hoisted node_modules
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules

# Compiled server output, UI assets, and server-local node_modules (tsx loader)
COPY --chown=node:node --from=build /app/server/package.json ./server/
COPY --chown=node:node --from=build /app/server/dist ./server/dist
COPY --chown=node:node --from=build /app/server/ui-dist ./server/ui-dist
COPY --chown=node:node --from=build /app/server/node_modules ./server/node_modules

# Workspace packages — source (resolved by tsx at runtime) and manifests
COPY --chown=node:node --from=build /app/packages/adapter-utils/package.json ./packages/adapter-utils/
COPY --chown=node:node --from=build /app/packages/adapter-utils/src ./packages/adapter-utils/src
COPY --chown=node:node --from=build /app/packages/adapter-utils/node_modules ./packages/adapter-utils/node_modules

COPY --chown=node:node --from=build /app/packages/db/package.json ./packages/db/
COPY --chown=node:node --from=build /app/packages/db/src ./packages/db/src
COPY --chown=node:node --from=build /app/packages/db/node_modules ./packages/db/node_modules

COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/
COPY --chown=node:node --from=build /app/packages/shared/src ./packages/shared/src
COPY --chown=node:node --from=build /app/packages/shared/node_modules ./packages/shared/node_modules

COPY --chown=node:node --from=build /app/packages/plugins/sdk/package.json ./packages/plugins/sdk/
COPY --chown=node:node --from=build /app/packages/plugins/sdk/dist ./packages/plugins/sdk/dist
COPY --chown=node:node --from=build /app/packages/plugins/sdk/node_modules ./packages/plugins/sdk/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/claude-local/package.json ./packages/adapters/claude-local/
COPY --chown=node:node --from=build /app/packages/adapters/claude-local/src ./packages/adapters/claude-local/src
COPY --chown=node:node --from=build /app/packages/adapters/claude-local/node_modules ./packages/adapters/claude-local/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/codex-local/package.json ./packages/adapters/codex-local/
COPY --chown=node:node --from=build /app/packages/adapters/codex-local/src ./packages/adapters/codex-local/src
COPY --chown=node:node --from=build /app/packages/adapters/codex-local/node_modules ./packages/adapters/codex-local/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/cursor-local/package.json ./packages/adapters/cursor-local/
COPY --chown=node:node --from=build /app/packages/adapters/cursor-local/src ./packages/adapters/cursor-local/src
COPY --chown=node:node --from=build /app/packages/adapters/cursor-local/node_modules ./packages/adapters/cursor-local/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/gemini-local/package.json ./packages/adapters/gemini-local/
COPY --chown=node:node --from=build /app/packages/adapters/gemini-local/src ./packages/adapters/gemini-local/src
COPY --chown=node:node --from=build /app/packages/adapters/gemini-local/node_modules ./packages/adapters/gemini-local/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/openclaw-gateway/package.json ./packages/adapters/openclaw-gateway/
COPY --chown=node:node --from=build /app/packages/adapters/openclaw-gateway/src ./packages/adapters/openclaw-gateway/src
COPY --chown=node:node --from=build /app/packages/adapters/openclaw-gateway/node_modules ./packages/adapters/openclaw-gateway/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/opencode-local/package.json ./packages/adapters/opencode-local/
COPY --chown=node:node --from=build /app/packages/adapters/opencode-local/src ./packages/adapters/opencode-local/src
COPY --chown=node:node --from=build /app/packages/adapters/opencode-local/node_modules ./packages/adapters/opencode-local/node_modules

COPY --chown=node:node --from=build /app/packages/adapters/pi-local/package.json ./packages/adapters/pi-local/
COPY --chown=node:node --from=build /app/packages/adapters/pi-local/src ./packages/adapters/pi-local/src
COPY --chown=node:node --from=build /app/packages/adapters/pi-local/node_modules ./packages/adapters/pi-local/node_modules

# Python venv (CPU-only torch + sentence-transformers)
COPY --chown=node:node --from=python-deps /app/services/hippocampus-runtime/python/.venv /app/services/hippocampus-runtime/python/.venv

# Entrypoint script
COPY --chown=node:node docker/entrypoint.sh /app/docker/entrypoint.sh

# Install only opencode-ai globally — the claude and codex CLI tools are
# optional user-configured adapters and can be installed at runtime if needed.
RUN npm install --global --omit=dev \
    opencode-ai \
  && chmod +x /app/docker/entrypoint.sh \
  && mkdir -p /paperclip \
  && chown -R node:node /paperclip /app

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  PAPERCLIP_HIPPOCAMPUS_MODE=active \
  PAPERCLIP_HIPPOCAMPUS_PYTHON_BIN=/app/services/hippocampus-runtime/python/.venv/bin/python \
  OPENCODE_URL=http://127.0.0.1:4098

EXPOSE 3100 4098

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3100/api/health || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
