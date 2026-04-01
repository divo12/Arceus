# `packages/shared/src/index.ts`

This guide explains `[packages/shared/src/index.ts](/Users/divyansh/Arceus/packages/shared/src/index.ts)` as the cross-layer contract barrel.

If you want one sentence first:

`packages/shared/src/index.ts` is the file that re-exports the vocabulary of the system so UI and backend can talk about the same concepts using the same constants and types.

## Mental Model

In a monorepo like this, one of the fastest ways to create bugs is:

- backend says an agent status can be `"running"`
- UI forgets that and assumes only `"active"` or `"paused"`

The shared package exists to reduce that kind of drift.

So this file is not exciting because it contains logic.

It is important because it contains agreement.

## What This File Really Is

This file is a barrel export.

That means it gathers exports from deeper shared modules and presents them as one public shared surface.

It re-exports:

- constants
- string unions and related types
- core entity types
- settings types
- plugin types
- runtime-related types

From the outside, this becomes the “language package” of the repo.

## Why This Matters In Phase 3

While tracing agents end-to-end, you will keep seeing types imported from `@paperclipai/shared`.

That happens in:

- UI pages
- frontend API wrappers
- backend routes
- backend services

So even though this file is not executing business logic, it is still part of the feature path because it helps all layers agree on:

- what an `Agent` is
- what statuses are allowed
- what roles exist
- what heartbeat run statuses mean

## Big Export Families

## 1. Constants And Enum-Like Sets

The file exports many constants such as:

- `AGENT_STATUSES`
- `AGENT_ADAPTER_TYPES`
- `AGENT_ROLES`
- `AGENT_ROLE_LABELS`
- `DELEGATION_STYLES`
- `HEARTBEAT_RUN_STATUSES`
- and many more

These are the canonical allowed-value sets for the product.

The important idea:

the UI should not make up these lists locally if the backend already depends on them too.

## 2. Entity Types

The file also exports types such as:

- `Agent`
- `AgentDetail`
- `AgentRuntimeState`
- `AgentTaskSession`
- `HeartbeatRun`
- `Project`
- `Issue`

These are the common data shapes passed between layers.

When a UI page imports `AgentDetail`, that is the page saying:

“tell me the shape the backend promises to return.”

## 3. Settings, Governance, And Runtime Types

The export list includes things for:

- instance settings
- delegation
- workspace execution
- budgets
- plugins

That tells you the repo is not using the shared package only for simple entities.

It is also using it for policy concepts and operational concepts.

## What This File Does Not Mean

This file is not the full definition of every type.

It is the public doorway.

The deeper type modules and constant modules contain the actual definitions.

So the right mental model is:

- `packages/shared/src/index.ts` = exported front desk
- deeper shared files = actual rooms behind the desk

## Why This File Helps Repo Navigation

If you are ever confused about whether a concept is cross-layer and important, check whether it is exported here.

If it is, that usually means:

- multiple parts of the system rely on it
- changing it may ripple across UI, backend, and maybe database mapping

That makes this file a good “importance detector.”

## Self-Check

You understand this file if you can answer:

1. Why is a shared contract package valuable in a UI + backend monorepo?
2. Why is this file important even though it mostly re-exports?
3. What kind of bugs get prevented by centralizing shared statuses and types?

