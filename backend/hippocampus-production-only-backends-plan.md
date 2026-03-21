# Plan: Hippocampus Production-Only Backend Cleanup

**Generated**: 2026-03-22  
**Estimated Complexity**: High

## Objective

End with a Hippocampus runtime backend package that contains only production backends and production backend infrastructure:

- `postgres_relational.py`
- `pgvector_store.py`
- `redis_cache.py`
- `sentence_transformers_embedding.py`
- `llm_engine.py` (rename from `azure_openai_llm.py`)
- `neo4j_graph.py`
- `protocols.py`
- `factory.py`

Everything else currently under [backend/arceus/core/hippocampus/backends](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends) should either:

- move into `tests/.../support/fakes`
- move outside `backends/` because it is not truly a backend
- or be deleted after all references are migrated

## Design-Doc Replacement Map

This cleanup follows the migration path already implied by [Hippocampus-design.md](/Users/divyansh/Arceus/Hippocampus-design.md), where several current modules are explicitly MVP-era implementations that should be superseded in production.

### Direct production replacements

- [sqlite_relational.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sqlite_relational.py) -> [postgres_relational.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/postgres_relational.py)
  - SQLite is the MVP relational store; PostgreSQL is the production replacement.

- [in_memory_vector.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/in_memory_vector.py) -> [pgvector_store.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/pgvector_store.py)
  - In-memory vector search is the MVP implementation; pgvector is the production replacement.

- [dict_cache.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/dict_cache.py) -> [redis_cache.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/redis_cache.py)
  - Dict cache is the MVP implementation; Redis is the production replacement.

- [azure_openai_llm.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/azure_openai_llm.py) -> `llm_engine.py`
  - This is a runtime rename, not a provider change. Azure OpenAI remains the actual production implementation.

- [sentence_transformers_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py) -> stays
  - This is already the design-aligned production embedding backend.

- [neo4j_graph.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/neo4j_graph.py) -> stays
  - Neo4j is the design-locked graph backend.

### Modules that leave runtime instead of being “replaced”

These files should leave runtime `backends/`, but they are not replaced by new production backend files:

- [noop_llm.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/noop_llm.py) -> `backend/tests/hippocampus/support/fakes/noop_llm.py`
- [simple_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/simple_embedding.py) -> `backend/tests/hippocampus/support/fakes/mock_embedding.py`
- [in_memory_graph.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/in_memory_graph.py) -> `backend/tests/hippocampus/support/fakes/in_memory_graph.py`
- [in_memory_pattern.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/in_memory_pattern.py) -> `backend/tests/hippocampus/support/fakes/in_memory_pattern.py`

### Special case: pattern adapter, not backend

- [sqlite_pattern.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sqlite_pattern.py) should not be replaced by another backend file.
- It should become `backend/arceus/core/hippocampus/stores/relational_pattern_store.py`.
- Reason: it wraps a relational backend and adds pattern-specific behavior, so it is an adapter/store, not a backend.

## Non-Negotiable Safety Constraint

Other agents are active in the repository. This cleanup must avoid breaking shared hotspots mid-flight.

That means:

1. Do additive work first.
2. Delay edits to shared integration files until the fake/test infrastructure is already in place.
3. Remove old runtime modules only in the final pass after all imports and tests are green.

## Current Dependency Reality

### Runtime/package hotspots

These files are shared hotspots and should be edited in a narrow, serialized integration window:

- [backend/arceus/core/hippocampus/backends/factory.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/factory.py)
- [backend/arceus/core/hippocampus/config.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/config.py)
- [backend/arceus/core/hippocampus/hippocampus.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/hippocampus.py)
- [backend/arceus/core/hippocampus/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/__init__.py)
- [backend/arceus/core/hippocampus/backends/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/__init__.py)

### Files to remove from runtime `backends/`

- `noop_llm.py`
- `simple_embedding.py`
- `dict_cache.py`
- `in_memory_vector.py`
- `in_memory_graph.py`
- `in_memory_pattern.py`
- `sqlite_relational.py`
- `sqlite_pattern.py`

### Hidden dependency that must be replaced

`sqlite_relational.py` is not just an old runtime backend. It is also the current relational test harness used by:

- `test_procedural.py`
- `test_priming.py`
- `test_hippocampus.py`
- `test_backends.py`

So it cannot simply be deleted. It must first be moved to test support.

### Hidden dependency that must be redesigned

`sqlite_pattern.py` is misnamed, but also important: it is the current relational-backed pattern adapter used in [backend/arceus/core/hippocampus/hippocampus.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/hippocampus.py) for both SQLite and PostgreSQL.

It should not stay in `backends/`, but it also should not be dropped.  
It should be replaced with a generic adapter such as:

- `backend/arceus/core/hippocampus/stores/relational_pattern_store.py`

## Target Structure

### Runtime production backend package

`backend/arceus/core/hippocampus/backends/`

- `factory.py`
- `protocols.py`
- `postgres_relational.py`
- `pgvector_store.py`
- `redis_cache.py`
- `sentence_transformers_embedding.py`
- `llm_engine.py`
- `neo4j_graph.py`

This exact set is the target runtime backend folder.

### Runtime non-backend adapter

`backend/arceus/core/hippocampus/stores/`

- `relational_pattern_store.py`

### Test support fakes

Recommended new package:

`backend/tests/hippocampus/support/fakes/`

- `noop_llm.py`
- `mock_embedding.py`
- `dict_cache.py`
- `in_memory_vector.py`
- `in_memory_graph.py`
- `in_memory_pattern.py`
- `sqlite_relational.py`

This keeps test scaffolding near tests and out of runtime exports.

## Migration Strategy

### Phase 0: Freeze and Baseline

**Goal**: Start from a known green state and avoid colliding with ongoing agent work.

**Tasks**

- Record current green baseline:
  - `cd backend && ./.venv/bin/pytest tests/ -v`
- Do not begin shared-hotspot edits until active agents are done touching:
  - `factory.py`
  - `config.py`
  - `hippocampus.py`
  - package `__init__.py` files
- If cleanup must start before that, only add new files under `tests/hippocampus/support/fakes/` and `hippocampus/stores/`.

**Acceptance Criteria**

- Baseline test result is documented.
- Hotspot files are treated as a serial integration step, not parallel work.

## Phase 1: Introduce Test Support Package Without Runtime Deletions

**Goal**: Make tests independent of runtime scaffolding before removing anything.

**Tasks**

### Task 1.1: Create test support package

- **Location**:
  - `backend/tests/hippocampus/support/__init__.py`
  - `backend/tests/hippocampus/support/fakes/__init__.py`
- **Description**:
  - Create a dedicated support namespace for Hippocampus test doubles.

### Task 1.2: Move or copy current fakes into test support

- **Move targets**:
  - `noop_llm.py`
  - `simple_embedding.py` -> `mock_embedding.py`
  - `dict_cache.py`
  - `in_memory_vector.py`
  - `in_memory_graph.py`
  - `in_memory_pattern.py`
  - `sqlite_relational.py`
- **Description**:
  - First copy behavior into test support with identical APIs.
  - Do not delete original runtime modules yet.

### Task 1.3: Repoint tests to test support imports

- **Description**:
  - Change tests to import from `tests.hippocampus.support.fakes...` instead of runtime `backends/...`.
- **Files affected**:
  - unit tests
  - adapter tests
  - any test fixtures that construct these fakes

**Acceptance Criteria**

- No test imports runtime fake backends anymore.
- Runtime package still unchanged for production code.

**Validation**

- Run full test suite.
- Run `rg` to verify no tests import:
  - `arceus.core.hippocampus.backends.noop_llm`
  - `...simple_embedding`
  - `...dict_cache`
  - `...in_memory_vector`
  - `...in_memory_graph`
  - `...in_memory_pattern`
  - `...sqlite_relational`

### Phase 1 strict test-migration checklist

Apply the test import migration in these clusters, in this order:

1. Low-risk projection and utility tests
   - [backend/tests/adapters/test_dashboard_projections.py](/Users/divyansh/Arceus/backend/tests/adapters/test_dashboard_projections.py)
   - [backend/tests/adapters/test_memory_projections.py](/Users/divyansh/Arceus/backend/tests/adapters/test_memory_projections.py)
   - [backend/tests/hippocampus/unit/test_gc.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_gc.py)
   - Validation:
     - `cd backend && ./.venv/bin/pytest tests/adapters/test_dashboard_projections.py tests/adapters/test_memory_projections.py tests/hippocampus/unit/test_gc.py -v`

2. Relational + no-op dependent tests
   - [backend/tests/hippocampus/unit/test_procedural.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_procedural.py)
   - [backend/tests/hippocampus/unit/test_priming.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_priming.py)
   - Validation:
     - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit/test_procedural.py tests/hippocampus/unit/test_priming.py -v`

3. Pure learner/engine tests
   - [backend/tests/hippocampus/unit/test_pattern_learner.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_pattern_learner.py)
   - [backend/tests/hippocampus/unit/test_reasoning_bank.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_reasoning_bank.py)
   - Validation:
     - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit/test_pattern_learner.py tests/hippocampus/unit/test_reasoning_bank.py -v`

4. Tier and graph-heavy tests
   - [backend/tests/hippocampus/unit/test_tiers.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_tiers.py)
   - [backend/tests/hippocampus/unit/test_promotion_engine.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_promotion_engine.py)
   - [backend/tests/hippocampus/unit/test_phase2_graph_and_extractor.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_phase2_graph_and_extractor.py)
   - Validation:
     - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit/test_tiers.py tests/hippocampus/unit/test_promotion_engine.py tests/hippocampus/unit/test_phase2_graph_and_extractor.py -v`

5. Hippocampus orchestration unit test
   - [backend/tests/hippocampus/unit/test_hippocampus.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_hippocampus.py)
   - Validation:
     - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit/test_hippocampus.py -v`

6. Split fake-backend tests away from runtime-factory/provider tests
   - Review [backend/tests/hippocampus/unit/test_backends.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_backends.py)
   - Move fake behavior coverage into a new file:
     - `backend/tests/hippocampus/unit/test_support_fakes.py`
   - Keep runtime factory/provider tests in `test_backends.py`
   - Validation:
     - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit/test_backends.py tests/hippocampus/unit/test_support_fakes.py -v`

7. Full unit and full suite gate
   - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit -v`
   - `cd backend && ./.venv/bin/pytest tests/ -v`

### Phase 1 sensitive files

These tests are the highest-risk during fake migration and should be handled carefully:

- [backend/tests/hippocampus/unit/test_backends.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_backends.py)
  - mixes fake backend behavior with production factory/provider tests
- [backend/tests/hippocampus/unit/test_hippocampus.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_hippocampus.py)
  - monkeypatches `create_*` functions and wires multiple scaffolding backends together
- [backend/tests/hippocampus/unit/test_tiers.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_tiers.py)
  - subclasses `DictCacheStore`, so the copied fake must remain subclass-compatible
- [backend/tests/hippocampus/unit/test_reasoning_bank.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_reasoning_bank.py)
  - relies on helper constructors and `NoopLLMEngine` inheritance
- [backend/tests/hippocampus/unit/test_phase2_graph_and_extractor.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_phase2_graph_and_extractor.py)
  - heavily wires `GraphStore` around the in-memory graph fake
- [backend/tests/hippocampus/unit/test_priming.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_priming.py)
  - checks reopen/persistence semantics on the relational fake
- [backend/tests/hippocampus/unit/test_procedural.py](/Users/divyansh/Arceus/backend/tests/hippocampus/unit/test_procedural.py)
  - same relational fake sensitivity as priming

### Phase 1 migration rules

- Copy first, repoint tests second, delete nothing during this phase.
- Keep fake class names identical even if module paths change.
- Do not touch runtime `factory.py`, `config.py`, or `hippocampus.py` during test-support migration.
- Do not rewrite `test_backends.py` in one sweep; split fake-behavior tests from runtime factory/provider tests first.
- Before runtime cleanup begins, this search should be empty or intentionally limited to staged exceptions:
  - `rg -n "arceus\\.core\\.hippocampus\\.backends\\.(noop_llm|simple_embedding|dict_cache|in_memory_vector|in_memory_graph|in_memory_pattern|sqlite_relational)" backend/tests -g '!**/__pycache__/**'`

## Phase 2: Extract Pattern Adapter Out of `backends/`

**Goal**: Remove the misleading runtime `sqlite_pattern.py` and replace it with a properly named non-backend adapter.

**Tasks**

### Task 2.1: Add `RelationalPatternStore`

- **Location**:
  - `backend/arceus/core/hippocampus/stores/relational_pattern_store.py`
- **Description**:
  - Move the current logic from `sqlite_pattern.py` into a generic adapter that wraps `RelationalStore`.
  - Keep the API currently expected by `PatternLearner` and `Hippocampus`.

### Task 2.2: Update runtime imports

- **Location**:
  - [backend/arceus/core/hippocampus/hippocampus.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/hippocampus.py)
  - [backend/arceus/core/hippocampus/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/__init__.py)
- **Description**:
  - Replace `SQLitePatternStore` references with `RelationalPatternStore`.
  - Ensure the production wiring becomes:
    - relational backend -> `PostgreSQLRelationalStore`
    - pattern adapter -> `RelationalPatternStore`
    - engines and learners depend on the adapter, not on a backend-specific class
  - Remove runtime branching that selects `InMemoryPatternStore`.

### Task 2.3: Move `InMemoryPatternStore` to tests

- **Description**:
  - Once tests already import the fake from test support, remove runtime dependency on `InMemoryPatternStore`.

**Acceptance Criteria**

- Runtime no longer imports or exports `SQLitePatternStore`.
- Pattern storage in production goes through `RelationalPatternStore`.

**Validation**

- Run pattern learner tests, reasoning bank tests, and full suite.

## Phase 3: Rename Production LLM Backend to `llm_engine.py`

**Goal**: Match the production-only naming you want without unnecessary provider leakage in filenames.

**Tasks**

### Task 3.1: Add `llm_engine.py`

- **Location**:
  - `backend/arceus/core/hippocampus/backends/llm_engine.py`
- **Description**:
  - Move `AzureOpenAILLMEngine` and `has_azure_openai_credentials()` from `azure_openai_llm.py` into `llm_engine.py`.

### Task 3.2: Migrate imports

- **Description**:
  - Update `factory.py`, tests, and package exports.

### Task 3.3: Remove `azure_openai_llm.py`

- **Description**:
  - Only after imports are fully migrated and tests pass.

**Acceptance Criteria**

- Runtime package uses `llm_engine.py` only.
- No imports reference `azure_openai_llm.py`.

## Phase 4: Convert Factory and Config to Production-Only Runtime

**Goal**: Remove runtime support for old local-only backend branches.

**Tasks**

### Task 4.1: Remove non-production branches from factory

- **Location**:
  - [backend/arceus/core/hippocampus/backends/factory.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/factory.py)
- **Description**:
  - Remove branches for:
    - `in_memory`
    - `dict`
    - `sqlite`
    - `simple`
    - `noop`
  - Keep only:
    - `pgvector`
    - `postgresql`
    - `redis`
    - `neo4j`
    - `sentence-transformers`
    - Azure-backed `llm_engine`

### Task 4.1a: Apply the design-doc replacement map literally

- **Description**:
  - The runtime factory should reflect the replacement map exactly:
    - SQLite relational -> PostgreSQL relational
    - in-memory vector -> pgvector
    - dict cache -> Redis
    - Azure LLM file -> `llm_engine.py`
    - sentence-transformers stays
    - Neo4j stays
  - After this step, no runtime factory branch should instantiate MVP/test scaffolding.

### Phase 4 strict runtime-wiring checklist

Apply the runtime conversion in this order:

1. Add `backend/arceus/core/hippocampus/stores/relational_pattern_store.py`
2. Update [backend/arceus/core/hippocampus/hippocampus.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/hippocampus.py) to use `RelationalPatternStore` as the only runtime pattern adapter
3. Add `backend/arceus/core/hippocampus/backends/llm_engine.py`
4. Update [backend/arceus/core/hippocampus/backends/factory.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/factory.py) import paths from `azure_openai_llm` to `llm_engine`
5. Convert [backend/arceus/core/hippocampus/backends/factory.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/factory.py) to production-only creation logic
6. Update [backend/arceus/core/hippocampus/config.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/config.py) defaults to production-only values
7. Harden [backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py) by removing runtime `MockEmbeddingEngine` fallback
8. Tighten [backend/arceus/core/hippocampus/backends/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/__init__.py)
9. Tighten [backend/arceus/core/hippocampus/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/__init__.py)
10. Delete runtime modules only after import checks are clean

### Phase 4 validation checkpoints

- After `RelationalPatternStore` wiring:
  - `cd backend && ./.venv/bin/pytest tests/hippocampus/unit/test_pattern_learner.py tests/hippocampus/unit/test_reasoning_bank.py -v`
- After `llm_engine.py` rename:
  - run backend/factory tests touching LLM creation
- After factory production-only conversion:
  - `cd backend && ./.venv/bin/pytest tests/ -v`
  - `cd backend && ./.venv/bin/pytest tests/hippocampus/integration -v`
- Before deleting runtime modules:
  - `rg -n "azure_openai_llm|sqlite_pattern|sqlite_relational|in_memory_vector|dict_cache|simple_embedding|noop_llm" backend -g '!**/__pycache__/**'`

### Task 4.2: Update config defaults

- **Location**:
  - [backend/arceus/core/hippocampus/config.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/config.py)
- **Description**:
  - Change defaults from scaffolding to production-only values:
    - `vector_store_backend="pgvector"`
    - `cache_backend="redis"`
    - `relational_backend="postgresql"`
    - `graph_store_backend="neo4j"`
    - `embedding_model="all-MiniLM-L6-v2"` or your chosen production model
  - Remove `sqlite_path` if no longer needed.
  - Align config semantics with the production replacement map:
    - relational -> PostgreSQL
    - vector -> pgvector
    - cache -> Redis
    - graph -> Neo4j
    - embeddings -> sentence-transformers
    - LLM -> Azure OpenAI via `llm_engine.py`

### Task 4.3: Remove mock embedding fallback from sentence-transformers runtime

- **Location**:
  - [backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py)
- **Description**:
  - Since production-only runtime is the goal, failure to load sentence-transformers should raise, not silently fall back to `MockEmbeddingEngine`.

### Task 4.4: Remove no-op LLM fallback from runtime

- **Description**:
  - `model_name="noop"` should stop being a runtime branch.
  - Tests should instantiate their own fake directly from test support.

**Acceptance Criteria**

- `factory.py` contains only production runtime creation logic.
- Production startup fails fast if required providers are missing.

**Validation**

- Full test suite
- Production-profile integration suite

## Phase 5: Remove Runtime Fake Modules

**Goal**: Delete all scaffolding modules from runtime `backends/`.

**Delete list**

- `noop_llm.py`
- `simple_embedding.py`
- `dict_cache.py`
- `in_memory_vector.py`
- `in_memory_graph.py`
- `in_memory_pattern.py`
- `sqlite_relational.py`
- `sqlite_pattern.py`

**Acceptance Criteria**

- No remaining imports reference deleted modules.
- `backends/` contains only the approved production set.

**Validation**

- `rg` confirms no references remain.
- Full tests pass.

## Phase 6: Tighten Public Exports and Docs

**Goal**: Make the public surface accurately reflect the new architecture.

**Tasks**

### Task 6.1: Shrink public exports

- **Location**:
  - [backend/arceus/core/hippocampus/backends/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/__init__.py)
  - [backend/arceus/core/hippocampus/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/__init__.py)
- **Description**:
  - Remove exports for fake/test-only classes.
  - Export only stable kernel API and production runtime components.

### Task 6.2: Update docs

- **Location**:
  - [backend/arceus/core/hippocampus/README.md](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/README.md)
  - [backend/Hippocampus_improv.md](/Users/divyansh/Arceus/backend/Hippocampus_improv.md)
  - [backend/production-backend-swap-plan.md](/Users/divyansh/Arceus/backend/production-backend-swap-plan.md)
- **Description**:
  - Rewrite directory structure to show:
    - production-only `backends/`
    - `stores/relational_pattern_store.py`
    - test support fakes under `tests/hippocampus/support/fakes`
  - Add the replacement map so future contributors can see which production module superseded which MVP/test-era module.

**Acceptance Criteria**

- Public docs match actual runtime structure.

## Execution Order That Minimizes Breakage

This is the safest exact order:

1. Add `tests/hippocampus/support/fakes/`
2. Copy fakes there
3. Repoint tests
4. Add `stores/relational_pattern_store.py`
5. Repoint runtime from `sqlite_pattern.py`
6. Add `llm_engine.py`
7. Repoint runtime imports
8. Remove fake branches from `factory.py`
9. Update config defaults
10. Remove fake runtime files
11. Shrink exports
12. Update docs

Do not reverse that order.

## Recommended Commit Boundaries

To avoid merge pain with other agents, use these commit slices:

1. `test(hippocampus): introduce support fakes package and repoint tests`
2. `refactor(hippocampus): replace sqlite_pattern with relational_pattern_store`
3. `refactor(hippocampus): rename azure backend to llm_engine`
4. `refactor(hippocampus): make factory and config production-only`
5. `chore(hippocampus): remove runtime fake backends and tighten exports`
6. `docs(hippocampus): update runtime structure documentation`

## File Ownership / Conflict Map

### Safe early work while other agents run

- new files under `backend/tests/hippocampus/support/fakes/`
- new files under `backend/arceus/core/hippocampus/stores/`
- test import updates
- README/doc updates that only describe the future target and do not touch runtime imports

### Serial integration work

- `factory.py`
- `config.py`
- `hippocampus.py`
- `sentence_transformers_embedding.py`
- package `__init__.py`
- backend module deletions

If other agents are still touching those files, defer those steps until they finish.

### Suggested ownership lanes

- Lane A: test-support fakes extraction and test import migration
- Lane B: pattern adapter extraction to `stores/relational_pattern_store.py`
- Lane C: runtime wiring and production-only factory/config conversion
- Lane D: final deletion pass and export tightening

Only Lane C and Lane D require strict serialization across shared runtime hotspots.

### Concrete ownership notes by file

- `backend/tests/hippocampus/support/fakes/*`
  - safe for one cleanup agent to own end-to-end
  - no expected overlap with production backend work

- `backend/tests/hippocampus/unit/test_procedural.py`
- `backend/tests/hippocampus/unit/test_priming.py`
- `backend/tests/hippocampus/unit/test_hippocampus.py`
- `backend/tests/hippocampus/unit/test_pattern_learner.py`
- `backend/tests/hippocampus/unit/test_reasoning_bank.py`
- `backend/tests/hippocampus/unit/test_promotion_engine.py`
- `backend/tests/hippocampus/unit/test_tiers.py`
- `backend/tests/hippocampus/unit/test_phase2_graph_and_extractor.py`
- `backend/tests/hippocampus/unit/test_gc.py`
- `backend/tests/adapters/test_dashboard_projections.py`
- `backend/tests/adapters/test_memory_projections.py`
  - safe once the support fakes package exists
  - batch these together in one coordinated test-migration change

- `backend/arceus/core/hippocampus/stores/relational_pattern_store.py`
  - safe additive file
  - can be created before touching runtime imports

- `backend/arceus/core/hippocampus/backends/factory.py`
  - highest-risk hotspot
  - owns backend selection, config coupling, and runtime breakage potential
  - must be edited in isolation after test migration is complete

- `backend/arceus/core/hippocampus/config.py`
  - high-risk hotspot
  - changing defaults here can silently alter startup behavior across the app
  - serialize with `factory.py`

- `backend/arceus/core/hippocampus/hippocampus.py`
  - high-risk hotspot
  - owns wiring for `RelationalPatternStore`
  - serialize with pattern-adapter migration

- `backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py`
  - medium-high risk
  - runtime fallback removal changes failure mode
  - do after tests no longer depend on runtime mock embedding paths

- `backend/arceus/core/hippocampus/__init__.py`
- `backend/arceus/core/hippocampus/backends/__init__.py`
  - medium risk
  - public surface changes can break contract-style tests and convenience imports
  - do near the end

- runtime file deletions under `backend/arceus/core/hippocampus/backends/`
  - final serialized step only
  - never combine first-time rewiring and deletes in the same commit

## Strict Ordered Execution Checklist

This is the no-break rollout order. Do not skip ahead.

1. Record a green baseline with `cd backend && ./.venv/bin/pytest tests/ -v`.
2. Confirm no active agent is editing:
   - `backend/arceus/core/hippocampus/backends/factory.py`
   - `backend/arceus/core/hippocampus/config.py`
   - `backend/arceus/core/hippocampus/hippocampus.py`
   - `backend/arceus/core/hippocampus/__init__.py`
   - `backend/arceus/core/hippocampus/backends/__init__.py`
3. Create `backend/tests/hippocampus/support/fakes/` and add all fake modules there.
4. Repoint every test import from runtime fake backends to test support fakes.
5. Run unit tests only.
   - checkpoint: runtime package still unchanged, tests green
6. Add `backend/arceus/core/hippocampus/stores/relational_pattern_store.py`.
7. Rewire `backend/arceus/core/hippocampus/hippocampus.py` and package exports from `SQLitePatternStore` to `RelationalPatternStore`.
8. Remove runtime dependency on `InMemoryPatternStore`.
9. Run focused pattern/reasoning/hippocampus tests, then full suite.
10. Add `backend/arceus/core/hippocampus/backends/llm_engine.py`.
11. Repoint runtime imports from `azure_openai_llm.py` to `llm_engine.py`.
12. Run backend and integration tests that touch LLM backend creation.
13. In one serialized pass, edit `factory.py` and `config.py` together:
    - remove MVP/test branches
    - set production-only defaults
14. Remove runtime fallback from `sentence_transformers_embedding.py`.
15. Run full suite plus production integration tests.
16. Tighten `__init__.py` exports.
17. Delete obsolete runtime backend files.
18. Run full suite one last time.
19. Update docs only after code is fully green.

## Checkpoints and Stop Conditions

- After Phase 1:
  - stop if any test still imports runtime fakes
  - stop if runtime files needed edits to keep tests passing

- After pattern adapter migration:
  - stop if `hippocampus.py` still imports `SQLitePatternStore`
  - stop if `__init__.py` still exports `SQLitePatternStore`

- After LLM backend rename:
  - stop if any runtime file imports `azure_openai_llm.py`
  - stop if tests still assume the old runtime filename

- After factory/config conversion:
  - stop if any startup path still depends on:
    - `in_memory`
    - `dict`
    - `sqlite`
    - `simple`
    - `noop`

- Before deletions:
  - stop unless `rg` shows zero references to each candidate file

## Suggested Commit Boundaries With Gates

1. `test(hippocampus): add support fakes and repoint test imports`
   - gate: all unit tests pass

2. `refactor(hippocampus): replace sqlite_pattern with relational_pattern_store`
   - gate: pattern learner, reasoning bank, and hippocampus tests pass

3. `refactor(hippocampus): rename azure backend module to llm_engine`
   - gate: backend tests and integration smoke tests touching backend creation pass

4. `refactor(hippocampus): make runtime factory and config production-only`
   - gate: full suite passes, production integration suite passes

5. `chore(hippocampus): remove obsolete runtime backend modules`
   - gate: zero import references remain, full suite passes

6. `docs(hippocampus): align docs with production-only runtime structure`
   - gate: code is already green, docs-only diff

## Testing Strategy

Run after each phase:

- `cd backend && ./.venv/bin/pytest tests/hippocampus/unit -v`

Run after each integration step:

- `cd backend && ./.venv/bin/pytest tests/ -v`

Run after production-only factory conversion:

- `cd backend && ./.venv/bin/pytest tests/hippocampus/integration -v`

## Risks and Mitigations

### Risk 1: Test suite still imports runtime scaffolding

- **Mitigation**:
  - Move tests first, delete last.

### Risk 2: Sentence-transformers runtime loses fallback and starts failing in dev

- **Mitigation**:
  - Make that change only after test support fakes are independent of runtime.
  - Update docs to say production runtime is strict by design.

### Risk 3: Factory/config changes break local usage immediately

- **Mitigation**:
  - Land docs and migration instructions in the same change.
  - If needed, keep one short-lived compatibility branch behind explicit deprecation errors.

### Risk 4: Pattern flow breaks during `sqlite_pattern.py` removal

- **Mitigation**:
  - Introduce `RelationalPatternStore` first.
  - Delete `sqlite_pattern.py` only after `hippocampus.py` is fully switched.

### Risk 5: Merge conflicts with active agents

- **Mitigation**:
  - Start with additive files only.
  - Integrate hotspots in one short, focused pass after other agents settle.

## Rollback Plan

- If test support migration fails, revert only the test import commit.
- If `RelationalPatternStore` migration fails, restore the old runtime import and retry before deleting `sqlite_pattern.py`.
- If production-only factory conversion causes regressions, restore the previous `factory.py` and `config.py` while keeping the test support package intact.
- Never combine deletes with first-time behavior changes in the same commit.
