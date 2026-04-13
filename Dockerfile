# ============================================================
# Arceus API — Multi-stage Docker build for Railway
# ============================================================
# Includes: Fastify API + OpenCode agent runtime + git
# External deps: Supabase (Postgres + Storage), Azure OpenAI
# ============================================================

# ── Stage 1: Install dependencies + build ──────────────────
FROM node:22-slim AS build
WORKDIR /app

# git needed for workspace manager at runtime AND for npm ci (some deps)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Copy package files first (layer caching)
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/company-runtime/package.json ./packages/company-runtime/
COPY packages/db/package.json ./packages/db/
COPY packages/hippocampus/package.json ./packages/hippocampus/

RUN npm ci

# Copy source (only API + packages, skip web app — it deploys to Vercel)
COPY apps/api/ ./apps/api/
COPY packages/ ./packages/
COPY tsconfig.base.json ./
COPY opencode.json ./
COPY .opencode/ ./.opencode/

# Build only API and its dependencies (not web)
RUN npm run build --workspace @arceus/contracts --if-present && \
    npm run build --workspace @arceus/db --if-present && \
    npm run build --workspace @arceus/hippocampus --if-present && \
    npm run build --workspace @arceus/company-runtime --if-present && \
    npm run build --workspace @arceus/api

# Prune dev dependencies
RUN npm prune --production

# ── Stage 2: Production runtime ────────────────────────────
FROM node:22-slim AS production
WORKDIR /app

# git required at runtime for workspace manager (git init, commit, bundle)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 arceus && useradd -u 1001 -g arceus -m arceus

# Install OpenCode CLI + tsx globally
RUN npm install -g opencode-ai@1.3.17 tsx@4.19.3

# Copy production node_modules (hoisted at root)
COPY --from=build --chown=arceus:arceus /app/node_modules ./node_modules

# Copy API source + compiled output
COPY --from=build --chown=arceus:arceus /app/apps/api/src ./apps/api/src
COPY --from=build --chown=arceus:arceus /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=arceus:arceus /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=arceus:arceus /app/apps/api/tsconfig.json ./apps/api/

# Copy packages (source + compiled, imported via file: links)
COPY --from=build --chown=arceus:arceus /app/packages ./packages

# Copy root package.json + tsconfig (workspace resolution)
COPY --from=build --chown=arceus:arceus /app/package.json ./
COPY --from=build --chown=arceus:arceus /app/tsconfig.base.json ./

# Copy OpenCode config + agent prompts
COPY --from=build --chown=arceus:arceus /app/opencode.json ./
COPY --from=build --chown=arceus:arceus /app/.opencode ./.opencode

# Create workspace directory
RUN mkdir -p /tmp/workspaces && chown arceus:arceus /tmp/workspaces

USER arceus

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
ENV ARCEUS_WORKSPACE_ROOT=/tmp/workspaces

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# tsx handles ESM module resolution (import without .js extensions)
CMD ["npx", "tsx", "apps/api/src/server.ts"]
