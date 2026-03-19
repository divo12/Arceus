# Hippocampus Improvement Tracker

Remaining issues from Phase 0/1 code review that are deferred to later phases.

## HIGH

| # | Issue | Description | Phase | Status |
|---|-------|-------------|-------|--------|
| H6 | No LLM extraction pipeline | `remember()` wraps raw content into `ExtractedFact` manually. No `MemoryExtractor` with 3 modes, no LLM fact extraction (GPT-4o), no action decision (ADD/UPDATE/DELETE/NONE), no entity/relationship extraction to Neo4j, no relationship classification (GPT-4o-mini). | Phase 2 | Deferred |

## MEDIUM

| # | Issue | Description | Phase | Status |
|---|-------|-------------|-------|--------|
| M1 | Linear scan in `InMemoryVectorStore` | `search()` is O(n) cosine similarity over all items. No ANN index. Spec mentions preparing for approximate nearest neighbor in Phase 2+ (Neo4j vector search). | Phase 2+ | Deferred |
| M2 | No Procedural tier | `MemoryType.PROCEDURAL` defined in types but no `ProceduralMemory` tier class. Spec defines LLM-only trigger evaluation with batch calls. | Phase 4 | Deferred |
| M3 | No Priming tier | `MemoryType.PRIMING` defined in types but no `PrimingMemory` tier class. SQLite has `priming_state` table but no orchestration. Spec defines LLM disposition generation. | Phase 4 | Deferred |
| M4 | `memory_scope.py` O(n²) dedup | Nested loop with set tracking for deduplication. Acceptable for MVP result set sizes but should be revisited at scale. | No spec phase | Acceptable for MVP |
| M6 | No version chain logic | `version` and `previous_version_id` fields exist on `MemoryUnit` but no logic uses them. Spec defines version chain traversal and UPDATES relationship in Neo4j. | Phase 2 | Deferred |

## LOW

| # | Issue | Description | Phase | Status |
|---|-------|-------------|-------|--------|
| L1 | `SimpleEmbeddingEngine` not marked test-only | Hash-based deterministic embedding could be accidentally used in production. Should be renamed or have a clear docstring. | No spec phase | Nice-to-have |
| L2 | No `__all__` exports in `__init__.py` | Public API surface is implicit; consumers import from deep paths. | No spec phase | Nice-to-have |
| L3 | `Pattern.formed_from` is plain tuple | Works but spec suggests richer linking to source memory IDs with relationship metadata in PatternLearner. | Phase 4 | Deferred |
| L4 | Test coverage gaps | No tests for SQLite habit/pattern CRUD, DynamicMemory `find_decayed()` math precision, MMR lambda sensitivity, or `find_expired()`. | Ongoing | Expand per phase |
