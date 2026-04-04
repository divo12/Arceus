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

RUN python3 -m venv .venv \
  && .venv/bin/pip install --no-cache-dir --upgrade pip \
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

COPY --chown=node:node --from=build /app /app
COPY --chown=node:node --from=python-deps /app/services/hippocampus-runtime/python/.venv /app/services/hippocampus-runtime/python/.venv
COPY --chown=node:node docker/entrypoint.sh /app/docker/entrypoint.sh

RUN npm install --global --omit=dev \
    @anthropic-ai/claude-code@latest \
    @openai/codex@latest \
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
