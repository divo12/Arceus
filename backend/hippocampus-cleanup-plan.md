# Plan: Hippocampus Structure Cleanup

**Generated**: 2026-03-22
**Estimated Complexity**: Medium

## Overview

The current Hippocampus package is already close to the design in [Hippocampus-design.md](/Users/divyansh/Arceus/Hippocampus-design.md): the kernel exists under [backend/arceus/core/hippocampus](/Users/divyansh/Arceus/backend/arceus/core/hippocampus), and the Arceus adapters already live separately in [backend/arceus/core/memory_scope.py](/Users/divyansh/Arceus/backend/arceus/core/memory_scope.py), [backend/arceus/core/delegation_memory.py](/Users/divyansh/Arceus/backend/arceus/core/delegation_memory.py), [backend/arceus/core/profile_engine.py](/Users/divyansh/Arceus/backend/arceus/core/profile_engine.py), and [backend/arceus/core/memory_projections.py](/Users/divyansh/Arceus/backend/arceus/core/memory_projections.py).

The main structural debt is not the kernel/adapter split. It is that [backend/arceus/core/hippocampus/backends](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends) currently mixes:

- production backends
- local dev backends
- test doubles
- one misleadingly named relational-backed pattern adapter

This plan keeps working code paths intact while making it easier to tell what is production, what is local-dev, and what is test scaffolding.

## Current Findings

### Already aligned with design

- The adapter layer is already outside the kernel package, matching the design intent.
- The tier and engine split is clean and should remain.
- Production backends now exist for PostgreSQL, pgvector, Redis, and Neo4j.

### Main mismatches

- Test doubles live beside production backends inside `backends/`.
- [sqlite_pattern.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sqlite_pattern.py) is no longer SQLite-specific. It wraps any `RelationalStore`, including PostgreSQL.
- The public exports in [backend/arceus/core/hippocampus/backends/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/__init__.py) and [backend/arceus/core/hippocampus/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/__init__.py) expose internal/test-oriented classes and make cleanup harder.
- The design shows a `prompts/` directory, but implementation still uses a single [prompts.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/prompts.py) module.

### Important do-not-delete-yet conclusion

These files are active and should not be removed today:

- [noop_llm.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/noop_llm.py)
- [simple_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/simple_embedding.py)
- [dict_cache.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/dict_cache.py)
- [in_memory_pattern.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/in_memory_pattern.py)
- [in_memory_vector.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/in_memory_vector.py)
- [in_memory_graph.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/in_memory_graph.py)
- [sqlite_relational.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sqlite_relational.py)

They are still used by tests, local/dev flows, or explicit factory branches.

## Cleanup Policy

Use these rules for cleanup decisions:

1. Remove only files with no runtime, test, or factory references.
2. Rename misleading files before deleting them.
3. Move test doubles behind a clearer namespace before considering removal.
4. Shrink public exports before moving files, so fewer imports break.
5. Keep one release of compatibility shims for renamed modules.

## Sprint 1: Low-Risk Structural Cleanup

**Goal**: Make the package boundary honest without changing behavior.

**Demo/Validation**:

- `cd backend && ./.venv/bin/pytest tests/ -v`
- Confirm no public imports break in tests
- Confirm README structure section reflects actual package layout

### Task 1.1: Reduce public exports

- **Location**:
  - [backend/arceus/core/hippocampus/backends/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/__init__.py)
  - [backend/arceus/core/hippocampus/__init__.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/__init__.py)
- **Description**:
  - Stop treating test/dev backends as first-class package exports.
  - Keep exports focused on the kernel API and stable production-facing types.
- **Acceptance Criteria**:
  - No tests import test doubles from package-level wildcard exports.
  - Internal imports continue using direct module paths.
- **Validation**:
  - Run full test suite.
  - Search for `from arceus.core.hippocampus import` and ensure only intended symbols are exported.

### Task 1.2: Rename `sqlite_pattern.py`

- **Location**:
  - [backend/arceus/core/hippocampus/backends/sqlite_pattern.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sqlite_pattern.py)
  - [backend/arceus/core/hippocampus/hippocampus.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/hippocampus.py)
- **Description**:
  - Rename to `relational_pattern_store.py` or `sql_pattern_store.py`.
  - Keep a thin compatibility shim at `sqlite_pattern.py` during transition.
- **Acceptance Criteria**:
  - Name matches actual behavior for both SQLite and PostgreSQL.
  - No business logic changes.
- **Validation**:
  - Update imports and run tests.

### Task 1.3: Refresh docs to reflect production-vs-test status

- **Location**:
  - [backend/arceus/core/hippocampus/README.md](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/README.md)
- **Description**:
  - Mark each backend as `production`, `dev`, or `test double`.
  - Explicitly call out that `NoopLLMEngine` and `MockEmbeddingEngine` are scaffolding, not production dependencies.
- **Acceptance Criteria**:
  - README matches actual factory behavior.
  - Cleanup intent is visible to future contributors.
- **Validation**:
  - Manual review.

## Sprint 2: Separate Test/Dev Backends From Production Backends

**Goal**: Make `backends/` easier to scan by grouping scaffolding into a dedicated namespace.

**Demo/Validation**:

- Tests still pass after moves
- Factory still supports local/dev profiles
- Direct imports in tests are updated cleanly

### Task 2.1: Create a `testing/` or `dev/` subpackage

- **Location**:
  - New package under [backend/arceus/core/hippocampus/backends](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends)
- **Description**:
  - Create either:
    - `backends/testing/` for pure test doubles
    - `backends/dev/` for local non-production backends
  - Recommended split:
    - `testing/`: `noop_llm.py`, `mock_embedding.py`, `in_memory_pattern.py`
    - `dev/`: `dict_cache.py`, `in_memory_vector.py`, `in_memory_graph.py`, `sqlite_relational.py`
- **Acceptance Criteria**:
  - Scaffolding is clearly separated from production adapters.
  - Production backends remain at the top level or in future provider-specific namespaces.
- **Validation**:
  - Full test run
  - Search imports after move

### Task 2.2: Rename `simple_embedding.py` to `mock_embedding.py`

- **Location**:
  - [backend/arceus/core/hippocampus/backends/simple_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/simple_embedding.py)
  - [backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/sentence_transformers_embedding.py)
- **Description**:
  - The current file is not a "simple" semantic embedding engine. It is a deterministic mock.
  - Rename class references to `MockEmbeddingEngine` from a matching module path.
  - Keep `simple_embedding.py` as a compatibility shim for one cleanup cycle.
- **Acceptance Criteria**:
  - Naming becomes self-explanatory.
  - Sentence-transformers fallback still works in non-strict mode.
- **Validation**:
  - Full test run including embedding-related tests.

### Task 2.3: Move `NoopLLMEngine`, do not remove it yet

- **Location**:
  - [backend/arceus/core/hippocampus/backends/noop_llm.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/noop_llm.py)
  - [backend/arceus/core/hippocampus/backends/factory.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/backends/factory.py)
- **Description**:
  - Move it under `testing/` or `dev/` and keep `model_name="noop"` support for tests and offline development.
  - Do not delete until all tests stop depending on the `"noop"` factory branch.
- **Acceptance Criteria**:
  - Tests can still build a local no-network Hippocampus.
  - The file no longer reads like a production backend.
- **Validation**:
  - Run procedural, priming, reasoning bank, promotion, and backend unit tests.

## Sprint 3: Optional Design Alignment Cleanup

**Goal**: Move closer to the design doc where it helps readability, without unnecessary churn.

**Demo/Validation**:

- No behavior change
- Prompt and backend organization are easier to navigate

### Task 3.1: Split `prompts.py` into `prompts/`

- **Location**:
  - [backend/arceus/core/hippocampus/prompts.py](/Users/divyansh/Arceus/backend/arceus/core/hippocampus/prompts.py)
- **Description**:
  - Convert the monolithic prompt module into prompt assets or smaller modules if prompt count keeps growing.
  - Only do this if prompt maintenance is already painful.
- **Acceptance Criteria**:
  - Prompt ownership is clearer.
  - Extraction, contradiction, merge, and priming prompts are easy to edit independently.
- **Validation**:
  - Prompt-dependent tests pass.

### Task 3.2: Decide whether provider-specific layout is worth it

- **Location**:
  - `backends/`
- **Description**:
  - Consider future grouping like:
    - `backends/vector/`
    - `backends/relational/`
    - `backends/cache/`
    - `backends/graph/`
    - `backends/llm/`
    - `backends/embedding/`
  - This is optional. It is only worth doing if backend count keeps increasing.
- **Acceptance Criteria**:
  - Decision documented as either "do now" or "explicitly defer".
- **Validation**:
  - Architecture review.

## Sprint 4: Final Removal Pass

**Goal**: Remove legacy shims only after references are gone.

**Demo/Validation**:

- Search confirms no old import paths remain
- Tests pass without compatibility layers

### Task 4.1: Remove deprecated shim modules

- **Description**:
  - Delete compatibility files only after all imports have migrated.
  - Candidates after migration:
    - `sqlite_pattern.py` shim
    - `simple_embedding.py` shim
- **Acceptance Criteria**:
  - No remaining imports of legacy names.
- **Validation**:
  - `rg` for old module paths
  - Full test run

### Task 4.2: Revisit `NoopLLMEngine` removal

- **Description**:
  - Only consider removing `NoopLLMEngine` if all of the following are true:
    - tests use local fakes declared in `tests/`
    - factory no longer supports `"noop"`
    - offline/dev workflows no longer depend on it
  - If any of those remain true, keep it.
- **Acceptance Criteria**:
  - Deletion is justified by zero references, not by aesthetics.
- **Validation**:
  - Search imports
  - Search config branches
  - Run full tests

## Recommended File Decisions

### Safe to remove now

- No named Hippocampus source files are obvious delete-now candidates.
- Ignore `__pycache__` artifacts; they are workspace noise, not architectural debt.

### Rename or relocate

- `sqlite_pattern.py` -> `relational_pattern_store.py`
- `simple_embedding.py` -> `mock_embedding.py`
- `noop_llm.py` -> `backends/testing/noop_llm.py` or `backends/dev/noop_llm.py`
- `in_memory_pattern.py` -> `backends/testing/in_memory_pattern.py`

### Keep where they are for now

- `postgres_relational.py`
- `pgvector_store.py`
- `redis_cache.py`
- `neo4j_graph.py`
- `sentence_transformers_embedding.py`
- `azure_openai_llm.py`

### Keep, but possibly group under `dev/` later

- `dict_cache.py`
- `in_memory_vector.py`
- `in_memory_graph.py`
- `sqlite_relational.py`

## Testing Strategy

- Run `cd backend && ./.venv/bin/pytest tests/ -v` after each sprint.
- Add targeted search checks before removal:
  - `rg "noop_llm|simple_embedding|sqlite_pattern|InMemoryPatternStore|DictCacheStore|MockEmbeddingEngine|NoopLLMEngine" backend`
- Prefer one rename/move per commit.

## Potential Risks and Gotchas

- Package-level exports currently hide how much code depends on internal names.
- `NoopLLMEngine` is not just a test helper; it is also a factory-supported offline branch.
- `MockEmbeddingEngine` is still used as sentence-transformers fallback in non-strict mode.
- `sqlite_pattern.py` looks removable, but it is actually the main relational-backed pattern adapter today.
- Moving in-memory backends too aggressively may blur the distinction between `test-only` and `useful local-dev backend`.

## Rollback Plan

- Keep compatibility shim files during rename sprints.
- Revert only the affected rename/move commit if imports become noisy.
- Do not combine structural moves with behavioral changes.
