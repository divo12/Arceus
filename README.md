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
- `apps/api`: Fastify control-plane shell
- `packages/contracts`: shared domain types and schemas
- `packages/company-runtime`: seeded company snapshot and event helpers

## Living Architecture Notes

- `docs/core-design-principles.md`: repository-wide product and architecture principles

## Scripts

- `npm run dev:web`
- `npm run dev:api`
- `npm run build`
- `npm run typecheck`
