# Plan: Production Backend Swap

**Generated**: 2026-03-21
**Estimated Complexity**: High

## Overview
Replace Hippocampus production backends with a concrete, narrowed stack while preserving the current protocol boundaries and fast test scaffolding:

- `RelationalStore` -> PostgreSQL
- `VectorStore` -> PostgreSQL + pgvector
- `WorkingMemoryBackend` -> Redis
- `EmbeddingEngine` -> `SentenceTransformerEmbeddingEngine`
- `GraphStoreBackend` -> `Neo4jGraphStoreBackend` (existing implementation retained)

The implementation should keep current in-memory / SQLite / dict backends for tests and local fast paths, and add explicit production backends rather than deleting scaffolding. The production design uses one PostgreSQL DSN and one dedicated schema (`hippocampus`) for both relational and vector persistence.

## Prerequisites
- PostgreSQL instance with the `vector` extension available
- Redis instance reachable from backend workers/API
- Neo4j instance reachable from backend workers/API
- Local sentence-transformers model cache or network access to download the selected model
- New Python dependency: `pgvector`
- Existing dependencies already present in `backend/pyproject.toml`: `asyncpg`, `redis`, `sentence-transformers`, `neo4j`, `sqlalchemy[asyncio]`

## Sprint 1: Contracts, Config, and Production Wiring
**Goal**: Make backend selection explicit and production-safe without changing existing test defaults.
**Demo/Validation**:
- Create a `HippocampusConfig` that selects PostgreSQL + pgvector + Redis + Neo4j + sentence-transformers
- Existing tests using `sqlite` / `in_memory` / `dict` still pass unchanged

### Task 1.1: Extend backend config for production URLs and backend names
- **Location**: `backend/arceus/core/hippocampus/config.py`, `backend/arceus/config/settings.py`
- **Description**: Add explicit config fields for PostgreSQL and Redis-backed Hippocampus operation. Keep current defaults for tests, but support:
  - `relational_backend="postgresql"`
  - `vector_store_backend="pgvector"`
  - `cache_backend="redis"`
  - `postgres_url`
  - `postgres_schema="hippocampus"`
  - `redis_url`
  - optional pgvector tuning fields such as `vector_index_type`, `vector_top_k_fetch_multiplier`
- **Dependencies**: None
- **Acceptance Criteria**:
  - Current tests that instantiate `HippocampusConfig()` without overrides still behave the same
  - Production config can be fully expressed without relying on hardcoded test backends
- **Validation**:
  - Add/adjust config contract tests
  - Instantiate config objects for both test and production profiles

### Task 1.2: Add factory routing for production-only backend implementations
- **Location**: `backend/arceus/core/hippocampus/backends/factory.py`
- **Description**: Add new branches for PostgreSQL relational, pgvector vector, and Redis cache backends. Keep existing branches intact. Use explicit errors for missing URLs/unsupported values.
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - Factory returns the correct backend class for every supported backend name
  - Unsupported names still fail loudly
- **Validation**:
  - Extend backend factory tests for each new backend selector

### Task 1.3: Add a production compose/dev bootstrap for backend verification
- **Location**: `backend/docker-compose.hippocampus.yml`, `backend/arceus/core/hippocampus/README.md`
- **Description**: Add a minimal local stack for PostgreSQL + pgvector, Redis, and Neo4j so the production profile is runnable before cloud deployment.
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - A developer can bring up the backing services locally with one command
  - README includes env vars and startup order
- **Validation**:
  - Manual smoke run documented in the plan and README

## Sprint 2: PostgreSQL Persistence for Relational + Vector Memory
**Goal**: Move durable Hippocampus state into PostgreSQL while preserving protocol behavior.
**Demo/Validation**:
- A Hippocampus instance can initialize against PostgreSQL
- Habits, priming state, patterns, and memory vectors survive process restarts
- Recall/search returns scoped results from pgvector-backed storage

### Task 2.1: Implement `PostgreSQLRelationalStore`
- **Location**: `backend/arceus/core/hippocampus/backends/postgres_relational.py`
- **Description**: Implement protocol parity for habits, priming state, patterns, and metadata using PostgreSQL. Use one shared schema (`hippocampus`) with tables:
  - `habits`
  - `priming_state`
  - `patterns`
  - `memory_metadata`
  Keep the store API aligned with `SQLiteRelationalStore`, including initialization locking and frozen-dataclass reconstruction.
- **Dependencies**: Task 1.1, Task 1.2
- **Acceptance Criteria**:
  - All `RelationalStore` methods behave the same as SQLite from the caller’s perspective
  - No mutable dataclass updates are introduced
  - Initialize is idempotent and concurrency-safe
- **Validation**:
  - Add backend parity tests mirroring current SQLite tests
  - Add a restart persistence test

### Task 2.2: Implement `PGVectorStore`
- **Location**: `backend/arceus/core/hippocampus/backends/pgvector_store.py`
- **Description**: Implement `VectorStore` on PostgreSQL using pgvector. Use one table under the `hippocampus` schema with all `MemoryUnit` fields plus soft-delete columns:
  - `deleted_at TIMESTAMPTZ NULL`
  - `delete_reason TEXT NOT NULL DEFAULT ''`
  Store `metadata` as `JSONB`, embeddings as `vector(<dimensions>)`, and preserve visibility-aware retrieval logic.
- **Dependencies**: Task 1.1, Task 1.2
- **Acceptance Criteria**:
  - Supports `upsert`, `get`, `search`, `list_by_type`, `soft_delete`, and `find_expired`
  - `search()` preserves current behavior: container filter + visibility-aware access + `top_k`
  - `list_by_type()` remains strict to `agent_id`
- **Validation**:
  - Add backend parity tests mirroring the current `InMemoryVectorStore` suite
  - Add soft-delete and expiry behavior tests

### Task 2.3: Add pgvector DDL, indexes, and bootstrap
- **Location**: `backend/arceus/core/hippocampus/backends/postgres_relational.py`, `backend/arceus/core/hippocampus/backends/pgvector_store.py`, `backend/arceus/db/migrations/`
- **Description**: Ensure PostgreSQL bootstrap enables `CREATE EXTENSION IF NOT EXISTS vector` and creates indexes:
  - B-tree indexes for `agent_id`, `container`, `memory_type`, `created_at`
  - ANN index on `embedding` using cosine distance (prefer HNSW; IVFFlat only if HNSW is unavailable in the target environment)
  - JSONB/path indexes only if needed for `usage_count`-heavy promotion flows
- **Dependencies**: Task 2.1, Task 2.2
- **Acceptance Criteria**:
  - Fresh bootstrap produces a queryable schema without manual SQL
  - Production deployment instructions explicitly call out pgvector extension availability
- **Validation**:
  - Fresh DB integration test
  - Explain-plan/manual verification for vector query path

## Sprint 3: Redis Working Memory and Production Embedding/Graph Profile
**Goal**: Finish the production runtime path for ephemeral cache and embeddings without disturbing existing graph logic.
**Demo/Validation**:
- Working memory uses Redis with TTL and prefix-clear semantics
- Production Hippocampus can boot with sentence-transformers and Neo4j
- No production path depends on `MockEmbeddingEngine`

### Task 3.1: Implement `RedisCacheStore`
- **Location**: `backend/arceus/core/hippocampus/backends/redis_cache.py`
- **Description**: Implement `WorkingMemoryBackend` with `redis.asyncio`. Match current dict semantics:
  - `set(key, value, ttl_seconds)`
  - `get(key)`
  - `delete(key)`
  - `get_all(prefix)`
  - `clear(prefix)`
  Use `SCAN` for prefix operations, not `KEYS`.
- **Dependencies**: Task 1.1, Task 1.2
- **Acceptance Criteria**:
  - TTL behavior matches the current cache contract
  - Backend exposes explicit async close/disconnect handling
  - Working memory tests pass against Redis backend
- **Validation**:
  - Add Redis-specific backend tests
  - Add `WorkingMemory` parity tests against Redis

### Task 3.2: Promote sentence-transformers to the production embedding path
- **Location**: `backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py`, `backend/arceus/core/hippocampus/backends/factory.py`, `backend/arceus/core/hippocampus/README.md`
- **Description**: Keep `SentenceTransformerEmbeddingEngine` as the production embedding backend and treat `MockEmbeddingEngine` as test-only scaffolding. Add config/docs for:
  - explicit production model name
  - device selection (`cpu`/`cuda`)
  - startup warmup / model-load failure handling
- **Dependencies**: Task 1.1
- **Acceptance Criteria**:
  - Production docs no longer present Azure/Cohere as the chosen Hippocampus embedding target
  - Engine startup behavior is deterministic and documented
- **Validation**:
  - Extend embedding factory tests
  - Add one startup smoke test for real model configuration (can be marked integration/optional)

### Task 3.3: Keep Neo4j as-is but formalize the production profile
- **Location**: `backend/arceus/core/hippocampus/backends/neo4j_graph.py`, `backend/arceus/core/hippocampus/README.md`
- **Description**: Do not rewrite the Neo4j backend. Add only production-readiness items:
  - config/profile documentation
  - startup connectivity smoke check
  - schema/index bootstrap verification
  - clear local-dev fallback instructions for `in_memory`
- **Dependencies**: Task 1.3
- **Acceptance Criteria**:
  - Production profile clearly uses Neo4j
  - Existing Neo4j tests still pass
- **Validation**:
  - Add a configuration smoke test
  - Re-run current Neo4j backend tests

## Sprint 4: Cutover Safety, Test Matrix, and Documentation Cleanup
**Goal**: Make the swap safe to adopt and easy to verify.
**Demo/Validation**:
- A documented production config boots cleanly
- Test scaffolding remains fast
- Migration/cutover steps are explicit and reversible

### Task 4.1: Add backend matrix tests and production integration markers
- **Location**: `backend/tests/hippocampus/unit/`, `backend/tests/hippocampus/integration/`, `backend/pyproject.toml`
- **Description**: Split tests into:
  - fast unit tests that keep SQLite/in-memory/dict
  - optional integration tests for PostgreSQL/pgvector, Redis, and Neo4j
  Add pytest markers/env gating so CI can run unit-only by default and production stack tests in a separate job.
- **Dependencies**: Sprint 2, Sprint 3
- **Acceptance Criteria**:
  - Existing fast suite remains the default
  - Production stack tests can be run deterministically in CI or local compose
- **Validation**:
  - `pytest tests/ -v` for unit-only path
  - dedicated integration command documented

### Task 4.2: Clean up backend documentation to match the chosen target stack
- **Location**: `backend/arceus/core/hippocampus/README.md`, `backend/Hippocampus_improv.md`
- **Description**: Replace “future target options” language with the chosen implementation target for this phase:
  - PostgreSQL + pgvector
  - Redis
  - SentenceTransformers
  - Neo4j
  Leave Qdrant/Pinecone/Cohere/Valkey as deferred alternatives, not current targets.
- **Dependencies**: Sprint 1
- **Acceptance Criteria**:
  - Docs no longer contradict the chosen production stack
  - Test scaffolding is still clearly documented as scaffolding
- **Validation**:
  - README review
  - grep for stale target matrix text

### Task 4.3: Add cutover and rollback procedure
- **Location**: `backend/arceus/core/hippocampus/README.md`
- **Description**: Document the rollout procedure:
  1. Deploy backing services
  2. Enable pgvector extension
  3. Run Hippocampus schema bootstrap
  4. Switch config values by environment
  5. Run smoke tests
  6. Roll back by switching config selectors to test/dev backends or previous deployment image
- **Dependencies**: Sprint 2, Sprint 3
- **Acceptance Criteria**:
  - Another engineer can follow the document without making architecture decisions
  - Rollback is config-driven and does not require code reverts
- **Validation**:
  - Dry-run checklist walkthrough

## Testing Strategy
- Keep all current fast unit tests on `SQLiteRelationalStore`, `InMemoryVectorStore`, `DictCacheStore`, and `InMemoryGraphStoreBackend`
- Add production integration coverage for:
  - PostgreSQL relational behavior parity
  - pgvector search/list/soft-delete/expiry/visibility behavior
  - Redis TTL and prefix-clear behavior
  - Neo4j startup/profile smoke path
- Add one end-to-end production-profile Hippocampus test:
  - create Hippocampus with PostgreSQL + pgvector + Redis + Neo4j + sentence-transformers
  - `remember()`
  - `recall()`
  - `run_promotions()`
  - `run_gc()`
- Keep integration tests opt-in in local development and isolated in CI

## Potential Risks & Gotchas
- **Config default breakage**: changing defaults from test scaffolding to production backends will break current tests and local flows. Mitigation: keep current defaults; introduce explicit production config values.
- **Postgres duplication**: relational and vector backends must not create two separate DSN stories. Mitigation: one PostgreSQL DSN, one `hippocampus` schema, separate backend classes.
- **pgvector availability**: many hosted Postgres environments need the extension enabled explicitly. Mitigation: make extension bootstrap and readiness checks part of setup.
- **SentenceTransformer cold start**: model loading can add noticeable startup latency. Mitigation: document warmup and keep model/device explicit in config.
- **Redis prefix deletes**: `KEYS` would not scale. Mitigation: require `SCAN`.
- **Neo4j remains partly Python-ranked**: current graph vector search is still not native-index driven. Accept for this phase; leave native graph vector/fulltext optimization as a later improvement.
- **Test speed regression**: production integration tests can slow the suite if mixed with unit tests. Mitigation: separate pytest markers and jobs.

## Rollback Plan
- Keep all existing scaffolding backends in the codebase and factories
- Roll back production by switching config selectors back to the previous deployment profile rather than deleting new backends
- If PostgreSQL/Redis/Neo4j rollout fails:
  - disable the production Hippocampus profile in environment config
  - redeploy prior image/config
  - keep data intact in PostgreSQL/Neo4j for postmortem

## Assumptions
- The chosen production stack is fixed for this phase: PostgreSQL + pgvector, Redis, SentenceTransformers, Neo4j
- Azure OpenAI remains the LLM backend; it is not part of this swap
- Fast unit tests must continue to use test scaffolding backends by default
- Hippocampus production persistence should share one PostgreSQL deployment rather than introducing separate relational and vector databases
