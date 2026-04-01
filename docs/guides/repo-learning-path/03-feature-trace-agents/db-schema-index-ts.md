# `packages/db/src/schema/index.ts`

This guide explains `[packages/db/src/schema/index.ts](/Users/divyansh/Arceus/packages/db/src/schema/index.ts)` as the database schema barrel.

If you want one sentence first:

`packages/db/src/schema/index.ts` gathers the project’s table modules into one schema surface so the rest of the repo can import tables consistently from `@paperclipai/db`.

## Mental Model

Just like the shared package has a public doorway, the database package also has one.

This file is that doorway.

It says:

- these are the tables that exist
- these are the schema modules the rest of the monorepo is allowed to rely on

So while it does not contain the column definitions itself, it tells you what the persistence universe of the product looks like.

## Why This File Matters In An End-to-End Trace

When tracing agents, the deepest layer is not:

- page
- route
- service

The deepest durable layer is:

- tables

This file shows the named tables the system persists through Drizzle.

For the agent feature path, the most relevant exports are:

- `agents`
- `agentConfigRevisions`
- `agentApiKeys`
- `agentRuntimeState`
- `agentTaskSessions`
- `agentWakeupRequests`
- `heartbeatRuns`
- `heartbeatRunEvents`
- `costEvents`

That list alone already tells you a lot about the product.

## What The Agent-Related Tables Tell You

### `agents`

This is the core identity/configuration record for an agent.

### `agentConfigRevisions`

Agent configuration changes are versioned.

### `agentApiKeys`

Agents can authenticate as principals.

### `agentRuntimeState`

The system persists current runtime continuity, not only historical runs.

### `agentTaskSessions`

The system tracks continuity per task scope, not just per agent globally.

### `agentWakeupRequests`

The system distinguishes a request to wake from the run that may follow.

### `heartbeatRuns`

Actual execution attempts are persisted separately.

### `heartbeatRunEvents`

Runs emit structured events, not just final status.

### `costEvents`

Spend is modeled explicitly and can be aggregated operationally.

That is already enough to see Paperclip as a runtime control plane rather than a normal CRUD app.

## Why Use A Schema Barrel

Without a barrel like this, every consumer would import tables from many scattered files.

A single export surface gives:

- cleaner imports
- consistent package boundaries
- easier discovery of available tables

It also makes the schema package feel like a coherent API instead of a pile of files.

## What This File Does Not Tell You

This file does not tell you:

- each column name
- indexes
- foreign keys
- default values

For that, you go to the concrete schema files like:

- `[packages/db/src/schema/agents.ts](/Users/divyansh/Arceus/packages/db/src/schema/agents.ts)`
- `[packages/db/src/schema/heartbeat_runs.ts](/Users/divyansh/Arceus/packages/db/src/schema/heartbeat_runs.ts)`
- `[packages/db/src/schema/agent_runtime_state.ts](/Users/divyansh/Arceus/packages/db/src/schema/agent_runtime_state.ts)`

But for learning the repo, this file is still valuable because it shows the shape of the persistence surface at a glance.

## Technical Thinking

If `packages/shared/src/index.ts` is the language of the system, then `packages/db/src/schema/index.ts` is the storage map of the system.

One tells you what the app agrees concepts mean.

The other tells you what data the app actually stores durably.

Together, they anchor the deeper backend layers.

## Self-Check

You understand this file if you can answer:

1. Why is it useful to have a single export surface for tables?
2. Which agent-related tables suggest Paperclip supports long-lived runtime continuity?
3. What is the conceptual difference between `agentWakeupRequests` and `heartbeatRuns`?

