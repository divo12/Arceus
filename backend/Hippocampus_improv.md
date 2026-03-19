# Hippocampus Improvement Tracker

## Previously Tracked — Now Resolved

| # | Issue | Was Phase | Resolved In | How |
|---|-------|-----------|-------------|-----|
| H6 | No LLM extraction pipeline | Phase 2 | Phase 2 | `MemoryExtractor` with 3 modes, `NoopLLMEngine` stub, prompts, action decision pipeline |
| M6 | No version chain logic | Phase 2 | Phase 2 | `StaticMemory.update()` creates version chain, `GraphStore.version_memory()` + `get_version_history()` |
| L2 | No `__all__` exports in `__init__.py` | No spec phase | Phase 2 | Both `hippocampus/__init__.py` and `backends/__init__.py` now have full `__all__` exports |
| S2 | `SimpleEmbeddingEngine` not marked test-only | No spec phase | Phase 3 | Renamed to `MockEmbeddingEngine` with clear test-only intent |
| S4 | `InMemoryGraphStoreBackend.update_node` no validation | No spec phase | Phase 3 | Added `_VALID_NODE_FIELDS` set and validates `updates` keys before `replace()` |
| S5 | `Hippocampus.__init__` has 12 parameters | No spec phase | Phase 2 | Grouped into `HippocampusBackends` dataclass |
| M2.2 | `NoopLLMEngine` keyword matching is brittle | Phase 3+ | Phase 3 | `AzureOpenAILLMEngine` added as real LLM backend; `NoopLLMEngine` remains for tests only |
| S7 | Timezone-naive `fromisoformat` in PromotionEngine | No spec phase | Phase 3 refactor | Added `parse_utc_iso()` to `utils/time.py`; PromotionEngine now uses it for all ISO parsing |
| S10 | Duplicated `_create_hippocampus` test helper | No spec phase | Phase 3 refactor | Extracted to `tests/adapters/conftest.py` as shared `hippocampus_factory` fixture |
| M4 | `memory_projections.py` accesses private `_backend` | Phase 5 | Phase 3 refactor | Added `get_neighbors()` public method on `GraphStore`; projections now use public API |

---

## Deferred to Future Phases

Issues that will be addressed in upcoming phases per the v6 spec.

| # | Issue | Description | Phase | Spec Reference |
|---|-------|-------------|-------|----------------|
| M1 | Linear scan in `InMemoryVectorStore` | `search()` is O(n) cosine similarity. No ANN index. Spec plans Neo4j vector search or dedicated vector DB. | Phase 2+ | Neo4j entity extraction (line 3083) |
| M2 | No Procedural tier | `MemoryType.PROCEDURAL` defined but no `ProceduralMemory` tier class. Spec defines LLM-only trigger evaluation with batch calls. | Phase 4 | ProceduralMemory (line 3095) |
| M3 | No Priming tier | `MemoryType.PRIMING` defined but no `PrimingMemory` tier class. SQLite has `priming_state` table but no orchestration. | Phase 4 | PrimingMemory (line 3096) |
| L3 | `Pattern.formed_from` is plain tuple | Spec suggests richer linking to source memory IDs with relationship metadata in PatternLearner. | Phase 4 | PatternLearner (line 3094) |
| M5 | `profile_engine.py` uses empty-string search | `generate_profile()` calls `recall("")` to list all memories. Relies on empty-string embedding behavior. | Phase 4 | ProceduralMemory/PrimingMemory additions will refactor profile generation |

---

## Phase 2 New Issues (from current review)

Issues found during Phase 2 code review that are deferred to later phases.

| # | Issue | Description | Phase | Spec Reference |
|---|-------|-------------|-------|----------------|
| M2.1 | `StaticMemory.update()` doesn't soft-delete old version | Old version remains fully queryable alongside new one. Version chain exists via graph edge but both appear in search. Spec says old should be superseded. | Phase 4 | GarbageCollector (line 3097) |
| L2.1 | `ExtractionMode.CONVERSATION` maps to `AGENT_EXTRACTION_PROMPT` | Uses same prompt as AGENT mode. Spec implies distinct extraction behavior for conversations. | Phase 3 | Adapters/delegation context |
| L2.2 | No integration test for `extract_from_conversation` on real `Hippocampus` | All extraction tests use `FakeHippocampus`. No test verifies the full wiring. | Ongoing | Test coverage |

---

## Not Covered by Any Phase — Standalone Improvements

Issues that won't be addressed by any planned phase but would improve code quality.

| # | Issue | Description | Severity | Suggested Action |
|---|-------|-------------|----------|------------------|
| S1 | `memory_scope.py` O(n²) dedup | Nested loop with set tracking for deduplication in `_deduplicate_by_priority()`. Acceptable at current scale but will degrade with large result sets. | MEDIUM | Replace content-prefix keying with ID-based dedup or use a dict comprehension. Simple fix, no spec dependency. |
| S3 | `_soft_delete` in extractor uses `getattr` for private attribute | `extractor.py:148` accesses `self._hippocampus._vector_store` via `getattr`. Fragile — if field is renamed, silently becomes a no-op. | MEDIUM | Add `Hippocampus.soft_delete(memory_id, reason)` as a public method. |
| S6 | Test coverage gaps | No tests for: SQLite habit/pattern CRUD, `DynamicMemory.find_decayed()` math precision, MMR lambda sensitivity, `find_expired()`, graph `get_neighbors` BFS correctness. | MEDIUM | Add targeted tests. No spec dependency — pure quality improvement. |
| S8 | Mixed datetime imports | Some files import `datetime` from stdlib, others use `utils/time.py`. Inconsistent timezone handling risk. | LOW | Standardize on `utils/time.py` for all datetime operations across the codebase. |
| S9 | Tests access private `_qualifies_for_static` | `test_promotion_engine.py` tests private method directly. Acceptable for unit coverage but couples tests to internals. | LOW | Keep as-is — private method tests are pragmatic here. Document that refactors may break these tests. |
| S11 | O(E) edge scan in `InMemoryGraphStoreBackend` | `get_edges()` does linear scan over all edges. Fine for tests but won't scale if used in production. Related to existing M1 (linear scan in vector store). | LOW | Add adjacency-list index. Only matters if InMemory backend is used beyond tests. |
