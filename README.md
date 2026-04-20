# Arceus

Arceus is an AI company operating system built on top of OpenCode. This repository starts the MVP scaffold with:

- a control-plane API shell,
- a web dashboard shell,
- shared domain contracts,
- seeded company runtime data.

## Core Design Principles

The repository keeps a living set of system principles in `docs/core-design-principles.md`.
These principles are meant to shape schema design, orchestration, UI behavior, and runtime policy.

## Workspaces

- `apps/web`: Next.js dashboard shell
- `apps/api`: Fastify control-plane API
- `packages/contracts`: shared domain types and Zod schemas
- `packages/db`: Drizzle ORM schema and database adapter
- `packages/hippocampus`: vector memory engine (pgvector + in-memory)
- `packages/company-runtime`: agent definitions, trust, policy, skills, meetings
- `packages/task-engine`: sprint/task state machine and execution cycle

## Living Architecture Notes

- `docs/core-design-principles.md`: repository-wide product and architecture principles

## Scripts

- `npm run dev:web`
- `npm run dev:api`
- `npm run build`
- `npm run typecheck`

## Building

### Prerequisites

- Node.js 20+
- npm 9+

### Web Dashboard (Next.js)

```bash
npm run dev:web        # Start dev server on http://localhost:3000
```

### API Server (Fastify)

```bash
npm run dev:api        # Start dev server on http://localhost:3001
```

### Documentation

API reference is auto-generated from JSDoc docstrings using TypeDoc.

```bash
npm run docs:dev       # Start VitePress dev server (live reload)
npm run docs:build     # Generate TypeDoc + build static docs site
npm run docs:preview   # Preview the built docs site
npm run docs:typedoc   # Regenerate API reference markdown only
```

### Type Checking

```bash
npm run typecheck      # Run tsc --noEmit across all workspaces
```
