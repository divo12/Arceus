# Hippocampus — Deferred Work & Future Roadmap

> **Phase 0–4 complete.** 65 of 77 original review items resolved. This file tracks deferred items, new holistic review findings, and architectural improvements for Phase 5+.
>
> For the full historical review log (all 77 items with resolution details), see git history of this file on the `divo/hippocampus-phase1` branch.

---

## 1. Open — Must Fix Before Production

### CRITICAL

| # | File | Issue | Fix |
|---|------|-------|-----|
| C2 | `in_memory_vector.py` + `protocols.py` | **VectorStore.search not agent-scoped (tenant bleed)** — `search()` filters only by `container`, not `agent_id`. Shared container names leak memories across agents. | Add `agent_id: str` to `VectorStore.search` protocol. See D1 below. |
| R1 | `neo4j_graph.py:142-146` | **Cypher injection via f-string in `get_neighbors`** — `max_hops` interpolated directly into Cypher query `[*1..{max_hops}]`. No int validation before interpolation. If caller-supplied data ever reaches `max_hops`, this is a full injection vector. | Add `if not isinstance(max_hops, int) or max_hops < 1 or max_hops > 10: raise ValueError(...)` before query construction. |
| R2 | `neo4j_graph.py:196-206` | **`_schema_ready` race condition** — Plain instance bool with no lock. Concurrent coroutines can both read `False`, both run `CREATE CONSTRAINT`, and set `True` before the other's `await session.run(...)` completes. | Use `asyncio.Lock` or `asyncio.Event` to gate schema creation (same pattern as `SQLiteRelationalStore`). |

### HIGH

| # | File | Issue | Fix |
|---|------|-------|-----|
| R3 | `graph_store.py:99-102` | **N+1 sequential async calls in `GraphStore.search`** — Each seed node triggers a separate `await get_neighbors()`. With `top_k * 3` seeds (default 30), that's 30 sequential Neo4j round-trips. | Use `asyncio.gather()` to parallelize neighbor fetches. |
| R4 | `types.py:212-222` | **`DistilledMemory.to_memory_unit()` drops `container`** — Constructs `MemoryUnit` with empty container. Distilled memories upserted by `ReasoningBank.distill()` are never returned by scoped `search()` or `list_by_type()`. | Add `container` field to `DistilledMemory` and thread it from `ReasoningBank`. |
| R5 | `tiers/priming.py:23-27` | **`update_state` key-errors on corrupt/partial stored state** — Direct dict key access (`current["confidence"]`) crashes if stored state is missing a key from an older schema version. | Use `.get("confidence", 0.5)` with defaults, or validate schema on `get_current_state()`. |
| R6 | `tiers/procedural.py:38` | **`get_matching_habits` silently drops malformed LLM responses** — If LLM returns unexpected shape or non-int `index`, habits silently skipped with no log. | Add warning log for unexpected response shape; coerce `index` with `int()`. |

### MEDIUM

| # | File | Issue | Fix |
|---|------|-------|-----|
| R7 | `engines/extractor.py:38` | **`hippocampus` parameter untyped** — Circular import workaround loses all type safety. | Use `TYPE_CHECKING` guard + `from __future__ import annotations` (same pattern as `gc.py`). |
| R8 | `engines/reasoning_bank.py:161` | **O(N^2) consolidation loop blocks event loop** — 5,000 memories = 25M cosine comparisons in Python, all synchronous. | Add `MAX_CONSOLIDATION_MEMORIES = 500` cap; document as TODO for numpy/vector-index batch. |
| R9 | `tiers/working.py:16,49-53` | **`_conversation_locks` dict leaks memory** — One `asyncio.Lock` per task_id, never removed. Monotonic growth in long-running processes. | Clean up in `clear_task()` with `self._conversation_locks.pop(key, None)`. |
| R10 | `engines/promotion_engine.py:53,71` | **`_event_log` grows without bound** — Appended on every `run_promotions()`, never trimmed. | Cap with `collections.deque(maxlen=200)` or slice after extend. |
| R11 | `backends/azure_openai_llm.py:41` | **`_api_key` stored as plain `str` after `get_secret_value()`** — Visible in `repr()`, crash dumps, pytest variable inspector. | Keep as `SecretStr`, call `.get_secret_value()` only in `_get_client()`. |
| R12 | `backends/azure_openai_llm.py:99` | **`classify()` silently falls back to `options[0]`** — No warning log when LLM response doesn't match any option. Can suppress contradictions or cause incorrect dedup. | Add `logger.warning()` on no-match fallback. |

---

## 2. Graph Store (G1–G5)

Graph is currently observability scaffolding: no agent logic reads graph data, all adapters use `include_graph=False`. These are real issues but non-load-bearing — fix when graph becomes part of the agent decision path.

| # | Issue | Summary |
|---|-------|---------|
| G1 | `GraphStore.search()` missing BM25 + container scoping | Spec calls for `bm25_rerank()` after cosine. Current impl uses cosine only, no container filter. |
| G2 | `UPDATES` edges have no `GraphEntity` nodes | `StaticMemory.update()` creates edges between `MemoryUnit` IDs but `get_version_history()` walks `GraphEntity` nodes. Version history returns empty. |
| G3 | `cypher_query()` ignores query param | `InMemoryGraphStoreBackend` hardcodes UPDATES chain traversal regardless of input query. |
| G4 | `create_edge` ignores missing nodes | Neo4j `MATCH` silently returns zero records for nonexistent nodes; `create_edge()` always returns `rel.id`. |
| G5 | `memory_projections.py` flattens edges | `get_graph_view()` emits all links as `{"type": "related_to", "weight": 1.0}`, losing actual `RelationType` and weight. |

---

## 3. Extraction Modes (E1)

### E1: Flesh out `MemoryExtractor` modes beyond AGENT

Current state:
- `AGENT` — fully functional
- `MEETING` — dedicated prompt, shares downstream behavior
- `CONVERSATION` — maps to AGENT prompt (no distinct behavior)
- `REFLECTION` — does not exist yet

Phase 5+ should add:
1. Explicit `REFLECTION` mode on `ExtractionMode`
2. Dedicated `CONVERSATION` and `REFLECTION` prompts
3. Mode-aware post-processing (bias memory typing per mode)
4. Better `MEETING` extraction: decisions, owners, deadlines, action items
5. Regression tests proving each mode stores meaningfully different outputs

**Why deferred:** Extraction works for current AGENT-centric flows. Valuable only once meetings and reflection loops become active product inputs.

---

## 4. Dashboard Summary (was H2)

`Hippocampus.get_summary()` has three always-empty fields: `top_patterns`, `recent_learnings`, `recent_promotions`.

**Phase 5 wiring:**
1. `recent_promotions` — call `promotion_engine.get_recent_promotions(limit=5)` (method exists)
2. `recent_learnings` — call `dynamic_memory.get_recent(container, days=7)[:5]` (method exists)
3. `top_patterns` — add `get_top_patterns()` to `PatternLearner`, sort by `success_rate * log(usage_count + 1)`

**Why deferred:** No agent logic reads these fields. Purely dashboard display. Underlying data stored correctly.

---

## 5. Design Thought: Instance vs Agent Scoping (D1)

`C2` (tenant bleed) and `M13` (`search()` accepts then deletes `agent_id`) are two sides of the same design inconsistency.

**Proper OOP model:**
- One `Hippocampus` instance = one agent
- Public methods are instance-scoped (no caller-supplied `agent_id`)
- Storage layer enforces `agent_id` filtering internally via `self._agent_id`

**Clean refactor:**
1. Remove `agent_id` from public `Hippocampus.search()` and similar APIs
2. Add `agent_id` to `VectorStore.search()` protocol, enforce in all implementations
3. `Hippocampus` passes `self._agent_id` into store calls internally
4. Shared DB/vector-store support without leaking multi-tenant concerns into public API

**Also linked:** `L12` (unused `pattern_store` param in `ReasoningBank`) — same instance-vs-param scoping question.

---

## 6. Future Improvements (F1–F7)

Architectural improvements that require broader API changes. Not bugs — current code works correctly.

### F1: `DelegationMemoryManager` bypasses Hippocampus public API

`prepare_delegation_context()` calls `_vector_store.upsert()` directly, skipping embedding generation, graph wiring, and tier routing.

**Fix:** Add `Hippocampus.ingest()` accepting full `MemoryUnit` kwargs (content, container, source_type, source_id, provenance, visibility, metadata). Replace direct `_vector_store.upsert()` calls.

**When:** Phase 5+ (startup-shared write path needs the same API)

### F2: Soft-delete compaction

`StaticMemory.update()` soft-deletes superseded versions, but historical versions remain in storage.

**Fix:** Add compaction job to archive/purge soft-deleted records older than retention window. Optionally keep latest `K` versions in hot storage.

**When:** Post-MVP, once memory volume affects storage cost

### F3: Centralize promotion/pruning lifecycle policy

`ReasoningBank` and `PromotionEngine` carry parallel promotion-candidate logic, aligned through config.

**Fix:** Extract shared `MemoryLifecyclePolicy` module. Both engines call same policy. Add cross-engine lifecycle test suite.

**When:** Post-MVP, once lifecycle decisions become more complex

### F4: Profile compaction for prompt-context

`ArceusProfileEngine` returns full truthful profile. No context-budget optimization yet.

**Fix:** Add separate compact-profile projection for LLM injection. Select most relevant facts, recent context, active habits for a given task. Summarize/compress when token pressure matters.

**When:** Post-MVP, once profiles create prompt-budget pressure

### F5: Replace test-scaffolding backends with production stores

| Backend | Current | Production Target |
|---------|---------|-------------------|
| Relational | `SQLiteRelationalStore` | PostgreSQL |
| Vector | `InMemoryVectorStore` | Qdrant / pgvector / Pinecone |
| Cache | `DictCacheStore` | Redis / Valkey |
| Embedding | `MockEmbeddingEngine` | Azure OpenAI / Cohere |
| Graph | `InMemoryGraphStoreBackend` | `Neo4jGraphStoreBackend` (already exists) |

Protocol-based architecture is correct. Each backend swappable independently. Factory routes based on config.

**When:** Before production deployment

### F6: Startup-level scoping for Procedural & Priming

`ProceduralMemory` and `PrimingMemory` scoped only by `agent_id`. Same agent shares habits/priming across all startups.

**Fix:** Add `startup_id` to `Habit` model, relational schema, and all queries. Composite `(startup_id, agent_id)` key for priming state.

**When:** Phase 5+ or when multi-startup-per-agent becomes real

### F7: Backend-native atomic append for working memory

`WorkingMemory.append_conversation()` uses in-process `asyncio.Lock`. Safe for single process, not for distributed workers.

**Fix:** Extend `WorkingMemoryBackend` with atomic append operation. Use Redis Lua / Postgres row locks natively.

**When:** Post-MVP, once working memory written from multiple processes

---

## 7. Standalone Deferred

| # | Issue | Why Deferred |
|---|-------|--------------|
| S11 | O(E) edge scan in `InMemoryGraphStoreBackend` | Test scaffolding only; production uses Neo4j with native graph indices |

---

## 8. Test Quality — New Findings

Holistic test review (post Phase 4). T1–T13 from PR#1 are all resolved.

### HIGH

| # | File | Issue | Fix |
|---|------|-------|-----|
| RT1 | `test_gc.py:29` | **`test_gc_runs_all_stages` asserts nothing meaningful** — Every assertion is `>= 0`. On an empty store all GC stages return 0. A regression breaking every GC stage would still pass. | Assert exact 0 values for empty baseline, or add fixture data and assert specific counts. |
| RT2 | `test_backends.py:56` | **`FakeNeo4jSession` state mutation leaks across query branches** — Shared mutable `state` dict with fragile `in`-based query matching. `SET` branch can overwrite `node_id` into node dict. | Use precise regex matching or split into dedicated fakes per operation. |
| RT3 | `test_backends.py:516` | **Neo4j `cypher_query` history assertion encodes fake behavior** — Test asserts `["memory-v1", "memory-v2"]` but this is the fake's traversal order, not necessarily what real Neo4j returns. | Document as fake-only test, or add contract test specifying production behavior. |

### MEDIUM

| # | File | Issue | Fix |
|---|------|-------|-----|
| RT4 | `test_backends.py:253` | **Expired memory appears in `search` results** — Assertion encodes expired memory in live search results without documenting intent. | Add comment explaining `search` intentionally ignores expiry (only `find_expired` filters). |
| RT5 | `test_backends.py:206` | **Missing `top_k` truncation test** — Only tests with fewer candidates than `top_k`. Truncation logic never verified. | Add test with 10 memories, `top_k=3`, assert exactly 3 results. |
| RT6 | `test_memory_scope.py:22` | **No cross-scope dedup/ordering test** — `get_memories_for_agent` merges 3 containers but only asserts presence/absence. No test for duplicate content across scopes. | Add test with same memory in 2 scopes, assert dedup behavior. |
| RT7 | `test_promotion_engine.py` | **Missing test: promotion with empty static store** — Contradiction check always tested with pre-seeded static memory. No test for empty-store path (should skip classification). | Add test with empty static store, assert promotion proceeds. |
| RT8 | `conftest.py:12` | **`hippocampus_factory` is sync fixture returning async factory** — Bypasses pytest-asyncio resource lifecycle. If `_create()` raises, cleanup not guaranteed. | Convert to `@pytest_asyncio.fixture` that yields. |
| RT9 | `test_memory_projections.py:86` | **Edge type assertion says `"related_to"` but edge was created as `USES`** — Tests the projection's flattening behavior (G5), but if G5 is ever fixed, this test encodes the wrong expected value. | Add comment linking to G5, or parametrize for both pre/post-G5 behavior. |

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| **Open — Must Fix** | 3 CRITICAL + 4 HIGH + 6 MEDIUM | C2, R1–R12 (holistic review) |
| Graph Store (deferred) | 5 | G1–G5 |
| Extraction Modes (deferred) | 1 | E1 |
| Dashboard Summary (deferred) | 1 | H2 |
| Design Thoughts | 1 | D1 (+ L12, M13 linked) |
| Future Improvements | 7 | F1–F7 |
| Standalone Deferred | 1 | S11 |
| Test Quality (new) | 3 HIGH + 6 MEDIUM | RT1–RT9 |
| **Total Open** | **13** | 3 CRITICAL, 4 HIGH, 6 MEDIUM |
| **Total Deferred** | **12** | Phase 5+ |
| **Total Test Issues** | **9** | RT1–RT9 |

**Phase 0–4 scorecard:** 65 of 77 original items resolved. 12 deferred to Phase 5+. Holistic review surfaced 13 new code issues (R1–R12 + C2) and 9 test quality issues (RT1–RT9).

### Priority Order
1. **Immediate** (security/data loss): R1 (cypher injection), R2 (schema race), R4 (distilled memory invisible)
2. **Before production**: C2 (tenant bleed), R5 (priming key-errors), R11 (api key in plain str)
3. **Performance**: R3 (N+1 graph search), R8 (O(N^2) consolidation)
4. **Hardening**: R6, R9, R10, R12 (logging, cleanup, bounds)
5. **Type safety**: R7 (extractor typing)
