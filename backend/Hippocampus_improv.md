# Hippocampus Improvement Tracker

## Previously Tracked — Now Resolved

| # | Issue | Was Phase | Resolved In | How |
|---|-------|-----------|-------------|-----|
| H6 | No LLM extraction pipeline | Phase 2 | Phase 2 | `MemoryExtractor` with 3 modes, `NoopLLMEngine` stub, prompts, action decision pipeline |
| M6 | No version chain logic | Phase 2 | Phase 2 | `StaticMemory.update()` creates version chain, `GraphStore.version_memory()` + `get_version_history()` |
| L2 | No `__all__` exports in `__init__.py` | No spec phase | Phase 2 | Both `hippocampus/__init__.py` and `backends/__init__.py` now have full `__all__` exports |

---

## Deferred to Future Phases

Issues that will be addressed in upcoming phases per the v6 spec.

| # | Issue | Description | Phase | Spec Reference |
|---|-------|-------------|-------|----------------|
| M1 | Linear scan in `InMemoryVectorStore` | `search()` is O(n) cosine similarity. No ANN index. Spec plans Neo4j vector search or dedicated vector DB. | Phase 2+ | Neo4j entity extraction (line 3083) |
| M2 | No Procedural tier | `MemoryType.PROCEDURAL` defined but no `ProceduralMemory` tier class. Spec defines LLM-only trigger evaluation with batch calls. | Phase 4 | ProceduralMemory (line 3095) |
| M3 | No Priming tier | `MemoryType.PRIMING` defined but no `PrimingMemory` tier class. SQLite has `priming_state` table but no orchestration. | Phase 4 | PrimingMemory (line 3096) |
| L3 | `Pattern.formed_from` is plain tuple | Spec suggests richer linking to source memory IDs with relationship metadata in PatternLearner. | Phase 4 | PatternLearner (line 3094) |

---

## Phase 2 New Issues (from current review)

Issues found during Phase 2 code review that are deferred to later phases.

| # | Issue | Description | Phase | Spec Reference |
|---|-------|-------------|-------|----------------|
| M2.1 | `StaticMemory.update()` doesn't soft-delete old version | Old version remains fully queryable alongside new one. Version chain exists via graph edge but both appear in search. Spec says old should be superseded. | Phase 4 | GarbageCollector (line 3097) |
| M2.2 | `NoopLLMEngine` keyword matching is brittle | Classify returns wrong results when prompt has multiple keywords from different categories. Acceptable as stub, must be replaced with real Azure OpenAI LLM engine. | Phase 3+ | Real LLM wiring needed for delegation/promotion |
| L2.1 | `ExtractionMode.CONVERSATION` maps to `AGENT_EXTRACTION_PROMPT` | Uses same prompt as AGENT mode. Spec implies distinct extraction behavior for conversations. | Phase 3 | Adapters/delegation context |
| L2.2 | No integration test for `extract_from_conversation` on real `Hippocampus` | All extraction tests use `FakeHippocampus`. No test verifies the full wiring. | Ongoing | Test coverage |

---

## Not Covered by Any Phase — Standalone Improvements

Issues that won't be addressed by any planned phase but would improve code quality.

| # | Issue | Description | Severity | Suggested Action |
|---|-------|-------------|----------|------------------|
| S1 | `memory_scope.py` O(n²) dedup | Nested loop with set tracking for deduplication in `_deduplicate_by_priority()`. Acceptable at current scale but will degrade with large result sets. | MEDIUM | Replace content-prefix keying with ID-based dedup or use a dict comprehension. Simple fix, no spec dependency. |
| S2 | `SimpleEmbeddingEngine` not marked test-only | Hash-based deterministic embedding could be accidentally used in production if misconfigured. | LOW | Rename to `MockEmbeddingEngine` or add a clear docstring + runtime warning if used outside tests. |
| S3 | `_soft_delete` in extractor uses `getattr` for private attribute | `extractor.py:148` accesses `self._hippocampus._vector_store` via `getattr`. Fragile — if field is renamed, silently becomes a no-op. | MEDIUM | Add `Hippocampus.soft_delete(memory_id, reason)` as a public method. |
| S4 | `InMemoryGraphStoreBackend.update_node` uses raw `replace(**updates)` | If `updates` contains an invalid field name, raises `TypeError` with unclear message. No validation. | LOW | Validate `updates` keys against `GraphEntity` fields before calling `replace()`. |
| S5 | `Hippocampus.__init__` has 12 parameters | Constructor grew significantly with Phase 2 additions. Hard to read and maintain. | LOW | Group backends into a `HippocampusBackends` dataclass or use builder pattern. |
| S6 | Test coverage gaps | No tests for: SQLite habit/pattern CRUD, `DynamicMemory.find_decayed()` math precision, MMR lambda sensitivity, `find_expired()`, graph `get_neighbors` BFS correctness. | MEDIUM | Add targeted tests. No spec dependency — pure quality improvement. |
