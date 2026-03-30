# Hippocampus Storage

This guide explains how Hippocampus uses storage today and how it interacts with the main Paperclip system.

This is important because Hippocampus is not stored in `packages/db/src/schema`.

It is a separate memory runtime with:

- its own Python code
- its own migration file(s)
- its own storage backends
- its own runtime process

But it still interacts closely with the Paperclip server and often shares the same PostgreSQL instance.

## 1. The Short Version

Today, the main app database and Hippocampus are connected like this:

1. Paperclip server starts and chooses its main PostgreSQL connection
2. `server/src/index.ts` sets `ARCEUS_HIPPOCAMPUS_POSTGRES_URL` to that same connection string if no Hippocampus-specific URL is already set
3. the server starts the Hippocampus Python runtime through stdio RPC
4. Hippocampus stores its own data in a dedicated PostgreSQL schema named `hippocampus`
5. it may also use Redis for working memory and Neo4j for graph storage
6. the server talks to it through `hippocampus-bridge.ts`, not through direct SQL queries

So the main app and Hippocampus are separate storage subsystems, but they can share the same Postgres instance.

## 2. Where Hippocampus Lives

The main implementation is under:

- `services/hippocampus-runtime/python/`

The key files are:

- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/README.md`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/runtime.py`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/hippocampus.py`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/config.py`
- `services/hippocampus-runtime/python/src/arceus/config/settings.py`
- `services/hippocampus-runtime/python/migrations/versions/20260322_0001_hippocampus_storage.py`

On the Node/TypeScript side, the main integration points are:

- `server/src/services/hippocampus-contract.ts`
- `server/src/services/hippocampus-protocol.ts`
- `server/src/services/hippocampus-runtime-manager.ts`
- `server/src/services/hippocampus-bridge.ts`
- `server/src/services/memory-lifecycle.ts`
- `server/src/services/memory-scope.ts`
- `server/src/services/delegation-memory.ts`
- `server/src/services/profile-service.ts`
- `server/src/routes/memory.ts`

## 3. Hippocampus Has Multiple Storage Pipelines

Hippocampus is not "one table of memories."

It uses several kinds of storage for different memory roles.

## 4. Tier 1: Working Memory

Purpose:

- short-lived task context
- scratchpad-like state
- in-flight conversational context

Storage backend:

- cache backend
- production target: Redis
- test profile: in-memory dict cache

Important detail:

- the current Node bridge contract does not expose direct working-memory CRUD methods
- so working memory exists inside the Python runtime architecture, but the current server-facing APIs focus more on recall/extract/habits/priming/graph than on manipulating working memory explicitly

That means working memory is real in the architecture, but it is less directly visible from today's TypeScript integration surface.

## 5. Tier 2: Static Memory

Purpose:

- permanent, high-confidence facts
- identity or architectural truths
- long-term knowledge that should not decay

Storage backend:

- vector store
- production target: PostgreSQL + `pgvector`
- graph provenance can also be attached through the graph layer

Current Paperclip usage today:

- when an agent is created and linked to a role definition, `server/src/routes/agents.ts` seeds the role definition's system prompt into Hippocampus as static memory
- memory recall may surface static memory during run context building
- promotions can move qualifying dynamic memory into static memory

## 6. Tier 3: Dynamic Memory

Purpose:

- recent observations
- contextual facts
- memories that decay unless reinforced

Storage backend:

- same vector store path as static memory
- production target: PostgreSQL + `pgvector`

Current Paperclip usage today:

- `remember()` defaults to dynamic memory in the Node bridge
- delegation copy operations often write dynamic memory into task containers
- post-run extraction often produces dynamic facts
- dynamic memory is the main "recent relevant context" layer for recall

## 7. Tier 4: Procedural Memory

Purpose:

- habits
- learned trigger/action patterns
- "how the agent tends to behave"

Storage backend:

- relational store
- production target: PostgreSQL
- test profile: SQLite relational store

Current Paperclip usage today:

- `getHabits()` is used during `buildMemoryContextForRun(...)`
- profile generation includes active habits
- trajectory and pattern learning can eventually produce habits

This is one of the more important "hidden" memory layers because it affects behavior, not just search.

## 8. Tier 5: Priming Memory

Purpose:

- agent disposition/state
- morale, caution, confidence, current state summaries

Storage backend:

- relational store
- production target: PostgreSQL

Current Paperclip usage today:

- `getPriming()` is used during run context construction
- profile generation includes the priming prompt or priming-derived state
- trajectory processing can update priming state after outcomes

## 9. The Concrete PostgreSQL Schema Hippocampus Uses

Hippocampus has its own migration file:

- `services/hippocampus-runtime/python/migrations/versions/20260322_0001_hippocampus_storage.py`

That migration creates:

- PostgreSQL extension `vector`
- PostgreSQL schema `hippocampus`

And these tables:

- `hippocampus.habits`
- `hippocampus.priming_state`
- `hippocampus.patterns`
- `hippocampus.memory_metadata`
- `hippocampus.memory_units`

### `memory_units`

This is the most important Hippocampus table.

It stores:

- memory content
- embedding
- `memory_type`
- confidence
- relevance score
- container
- visibility
- metadata
- provenance/source fields
- timestamps
- expiration
- version lineage
- promotion status
- soft-delete markers

Important index:

- HNSW index on the vector embedding column for cosine search

So Hippocampus memory search is designed around vector retrieval, not plain SQL text search.

### `habits`

Stores procedural habits:

- trigger condition
- action
- confidence
- usage count
- active/inactive state

### `priming_state`

Stores one priming-state record per agent, as JSON.

### `patterns`

Stores learned patterns that can later feed habits and higher-level learning.

### `memory_metadata`

Stores key/value metadata for the memory subsystem itself.

## 10. Other Backends In The Pipeline

Besides PostgreSQL, Hippocampus can use:

### Redis

Used for:

- working memory cache
- short-lived context

### Neo4j

Used for:

- graph entities
- graph edges
- version history / relationship exploration

This powers graph-oriented operations exposed through:

- `graphSearch`
- `graphNeighbors`
- `graphEdges`
- `graphVersionHistory`

### Embedding engine

Used for:

- converting memory text into vectors
- similarity search
- entity matching

### LLM engines

Used for:

- extracting structured facts from conversation
- contradiction checks
- classification and consolidation
- explanation generation around promotions and patterns

These are not "databases," but they are part of the full memory-storage pipeline because they determine what gets stored and how it is classified.

## 11. Production Stack vs Test Stack

### Production targets

According to Hippocampus config and README, the intended production stack is:

- relational store: PostgreSQL
- vector store: pgvector on PostgreSQL
- cache backend: Redis
- graph backend: Neo4j

### Test profile

The `test_fakes` profile swaps those with:

- in-memory vector store
- SQLite relational store
- in-memory graph store
- dict cache
- mock embedding engine
- noop LLM

That means local tests can validate behavior without requiring the full production stack.

## 12. How The Node Server Talks To Hippocampus

The TypeScript server does not query Hippocampus tables directly.

Instead, it uses this chain:

1. `server/src/index.ts` starts the runtime
2. `server/src/services/hippocampus-runtime-manager.ts` spawns the Python process
3. `server/src/services/hippocampus-protocol.ts` defines the JSON-RPC methods
4. `server/src/services/hippocampus-bridge.ts` exposes a typed bridge to the rest of the server

Important bridge methods include:

- `remember`
- `recall`
- `extract`
- `processTrajectory`
- `getPriming`
- `getHabits`
- `getSummary`
- `listMemories`
- `graphSearch`
- `graphNeighbors`
- `graphEdges`
- `graphVersionHistory`
- `runGC`
- `runPromotions`

## 13. What Paperclip Actually Uses Today

This is the most important "today" section.

There is a difference between:

- what Hippocampus is architecturally capable of
- what the current Paperclip app actively uses

### 13.1 Pre-run memory injection

Before a heartbeat run, `buildMemoryContextForRun(...)` in `server/src/services/memory-lifecycle.ts` can fetch:

- priming prompt
- matching habits
- recalled memories
- delegator context

That gets assembled into a markdown block for adapter prompt injection.

### 13.2 Post-run extraction and learning

After a run, `extractMemoriesFromRun(...)` can:

- build pseudo-conversation messages from stdout/stderr excerpts
- call `extract(...)`
- call `processTrajectory(...)`

That means run output can become:

- extracted facts
- distilled learning
- patterns
- habits
- priming-state changes

### 13.3 Delegation recording

`recordDelegationEvent(...)` writes delegation event context into both delegator and delegatee memory stores.

### 13.4 Role-definition seeding

When an agent is hired and has a role definition, the role definition system prompt can be seeded into static memory.

### 13.5 Memory routes

`server/src/routes/memory.ts` exposes operator-facing APIs for:

- health
- summary
- list
- priming
- habits
- remember
- recall
- meeting extraction
- scoped recall
- shareable memories
- profile
- delegation prep
- delegation internalization
- graph view
- explorer
- promotion log
- version history
- GC
- promotion runs

So the runtime is not only used implicitly during runs; it also has an explicit memory API surface.

## 14. Scope Containers In Today’s System

The TypeScript side defines these container shapes in `memory-scope.ts`:

- `startup:{startupId}`
- `startup:{startupId}:emp:{employeeId}`
- `startup:{startupId}:task:{taskId}`
- `startup:{startupId}:task:{taskId}:sub:{agentId}`

These are used by higher-level services for:

- scoped recall
- shareable memory browsing
- delegation memory copying
- profile generation

Important nuance:

- some generic bridge calls still use the default container path
- the richer container-aware behavior is primarily exposed through the memory services and routes layer

So container-aware memory exists today, but it is not yet uniformly used by every integration point.

## 15. How Hippocampus Interacts With The Main App DB

Today the interaction is:

### Shared Postgres instance

By default, the server passes its active Postgres connection string into Hippocampus through:

- `ARCEUS_HIPPOCAMPUS_POSTGRES_URL`

So both systems may share:

- one PostgreSQL server/instance

But they do not share the same schema namespace:

- main app tables live in the Paperclip DB schema space used by `packages/db`
- memory tables live in the `hippocampus` schema created by the Python migration

### Separate migration systems

Main app DB migrations:

- Drizzle
- `packages/db/src/migrations`

Hippocampus migrations:

- Alembic-style Python migration files
- `services/hippocampus-runtime/python/migrations/versions`

That distinction matters a lot during a revamp.

### Separate access paths

Main app data is accessed by:

- Drizzle queries from the server

Hippocampus data is accessed by:

- JSON-RPC over stdio to the Python runtime

So even when they share Postgres, the application integration path is very different.

## 16. Revamp Implications

If you revamp DB architecture and Hippocampus is in scope, remember:

1. `packages/db` changes do not automatically update Hippocampus storage
2. Hippocampus has its own schema and migration path
3. changing the main app’s Postgres topology may affect Hippocampus defaults
4. changing agent/role/issue lifecycle can affect how memory gets seeded or extracted
5. `packages/shared` contract changes may affect the TypeScript side of Hippocampus integration

## 17. Bottom Line

The clean mental model is:

- Paperclip app DB stores control-plane data
- Hippocampus stores agent memory data
- they can share the same PostgreSQL server
- but they use different schemas, codepaths, and migration systems
- and today Paperclip actively uses Hippocampus for prompt priming, recall, extraction, learning, delegation, and memory exploration
