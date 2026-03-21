# Hippocampus — Deferred Work & Future Roadmap

> **Phase 0–4 complete.** 65 of 77 original review items resolved. This file tracks deferred items, new holistic review findings, and architectural improvements for Phase 5+.
>
> For the full historical review log (all 77 items with resolution details), see git history of this file on the `divo/hippocampus-phase1` branch.

---

## 1. Open — Must Fix Before Production

### CRITICAL

| # | File | Issue | Fix |
|---|------|-------|-----|
| ~~C2~~ | ~~`in_memory_vector.py` + `protocols.py`~~ | ~~VectorStore.search not agent-scoped (tenant bleed)~~ | **RESOLVED Phase 5 Prompt 2** — Visibility-aware retrieval: own agent always visible, non-PRIVATE visible to all (single-startup), PRIVATE blocked cross-agent. `_is_accessible()` filter added. D1/M13 also resolved. |
| ~~R1~~ | ~~`neo4j_graph.py`~~ | ~~Cypher injection via f-string in `get_neighbors`~~ | **RESOLVED Phase 5 Prompt 1** — int validation guard added to both neo4j + in-memory backends. |
| ~~R2~~ | ~~`neo4j_graph.py`~~ | ~~`_schema_ready` race condition~~ | **RESOLVED Phase 5 Prompt 1** — `asyncio.Lock` + double-checked locking pattern. |

### HIGH

| # | File | Issue | Fix |
|---|------|-------|-----|
| ~~R3~~ | ~~`graph_store.py`~~ | ~~N+1 sequential async calls in `GraphStore.search`~~ | **RESOLVED Phase 5 Prompt 3** — `asyncio.gather()` parallelizes neighbor fetches. |
| ~~R4~~ | ~~`types.py`~~ | ~~`DistilledMemory.to_memory_unit()` drops `container`~~ | **RESOLVED Phase 5 Prompt 1** — `container` field added to `DistilledMemory`, threaded through `distill()` and `process_trajectory()`. |
| ~~R5~~ | ~~`tiers/priming.py`~~ | ~~`update_state` key-errors on corrupt/partial stored state~~ | **RESOLVED Phase 5 Prompt 3** — All dict accesses use `.get()` with defaults. |
| ~~R6~~ | ~~`tiers/procedural.py:38`~~ | ~~`get_matching_habits` silently drops malformed LLM responses~~ | **PARTIALLY RESOLVED** — warning logs + safe index coercion added. Broader LLM observability remains deferred; see F8. |

### MEDIUM

| # | File | Issue | Fix |
|---|------|-------|-----|
| ~~R7~~ | ~~`engines/extractor.py`~~ | ~~`hippocampus` parameter untyped~~ | **RESOLVED Phase 5 Prompt 3** — `TYPE_CHECKING` guard + `from __future__ import annotations`. |
| ~~R8~~ | ~~`engines/reasoning_bank.py:161`~~ | ~~O(N^2) consolidation loop blocks event loop~~ | **DEFERRED** — real scale issue, but should be solved with chunking/vectorized batching rather than a blind cap if we revisit it seriously. See F10. |
| ~~R9~~ | ~~`tiers/working.py`~~ | ~~`_conversation_locks` dict leaks memory~~ | **RESOLVED Phase 5 Prompt 3** — `clear_task()` now pops lock. |
| ~~R10~~ | ~~`engines/promotion_engine.py`~~ | ~~`_event_log` grows without bound~~ | **RESOLVED Phase 5 Prompt 3** — `deque(maxlen=200)`. |
| ~~R11~~ | ~~`backends/azure_openai_llm.py`~~ | ~~`_api_key` stored as plain `str`~~ | **RESOLVED Phase 5 Prompt 3** — Kept as `SecretStr`, `.get_secret_value()` only in `_get_client()`. |
| ~~R12~~ | ~~`backends/azure_openai_llm.py`~~ | ~~`classify()` silently falls back to `options[0]`~~ | **RESOLVED Phase 5 Prompt 3** — `logger.warning()` on no-match fallback. |

---

## 2. Graph Store (G1–G5)

Graph is currently observability scaffolding: no agent logic reads graph data, all adapters use `include_graph=False`. G2, G4, G5 resolved in Phase 5 Prompt 5. G1, G3 remain deferred.

| # | Issue | Summary |
|---|-------|---------|
| G1 | `GraphStore.search()` missing BM25 + container scoping | Spec calls for `bm25_rerank()` after cosine. Current impl uses cosine only, no container filter. |
| ~~G2~~ | ~~`UPDATES` edges have no `GraphEntity` nodes~~ | **RESOLVED Prompt 5** — `ensure_memory_node()` in static + dynamic tiers; `update()` ensures both nodes before UPDATES edge. |
| G3 | `cypher_query()` ignores query param | `InMemoryGraphStoreBackend` hardcodes UPDATES chain traversal regardless of input query. |
| ~~G4~~ | ~~`create_edge` ignores missing nodes~~ | **RESOLVED Prompt 5** — `KeyError` raised in both neo4j + in-memory backends. |
| ~~G5~~ | ~~`memory_projections.py` flattens edges~~ | **RESOLVED Prompt 5** — `get_graph_view()` uses real `relation_type.value` + `edge.weight`. |

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

## 4. ~~Dashboard Summary (was H2)~~ — RESOLVED Phase 5 Prompt 4

All three fields wired: `top_patterns` via `PatternLearner.get_top_patterns()`, `recent_learnings` via `DynamicMemory.get_recent()`, `recent_promotions` via `PromotionEngine.get_recent_promotions()`. Pattern cards projection added to `ArceusMemoryProjections`.

---

## 5. ~~Design Thought: Instance vs Agent Scoping (D1)~~ — RESOLVED Phase 5 Prompt 2

Implemented visibility-aware retrieval model (not strict agent_id filtering). Public `search()` no longer takes `agent_id` (M13 resolved). `VectorStore.search` protocol takes `agent_id`, `_is_accessible()` enforces: own agent → allow, non-PRIVATE → allow (single-startup), PRIVATE cross-agent → block.

**Remaining:** `L12` (unused `pattern_store` in `ReasoningBank`) — deferred, still vestigial but harmless.

---

## 6. Future Improvements (F1–F10)

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

### F8: Broader LLM observability

Current quick fix adds warning logs at key malformed-response boundaries (for example, habit trigger evaluation). The system still lacks structured observability for LLM fallbacks, malformed outputs, retry frequency, and prompt/result diagnostics.

**Fix:** Add centralized counters/log fields for malformed LLM outputs, fallback paths, and per-engine warning rates. Consider lightweight tracing around extraction, trigger evaluation, contradiction checks, and classification fallbacks.

**When:** Post-MVP, once operational monitoring becomes part of production readiness

### F9: Narrow `ExtractorContext` protocol to remove concrete Hippocampus coupling

`MemoryExtractor` currently depends on the concrete `Hippocampus` object. `TYPE_CHECKING` fixes the import cycle safely, but the better long-term design is to depend on a narrow protocol describing only the capabilities extractor logic actually uses.

**Production-ready protocol sketch:**

```python
from __future__ import annotations

from typing import Protocol

from arceus.core.hippocampus.types import (
    ExtractedFact,
    GraphEntity,
    Habit,
    MemoryUnit,
    RelationType,
)


class SupportsStaticMemory(Protocol):
    async def add(self, fact: ExtractedFact, container: str) -> MemoryUnit: ...
    async def update(self, memory_id: str, new_content: str) -> MemoryUnit: ...


class SupportsDynamicMemory(Protocol):
    async def add(self, fact: ExtractedFact, container: str) -> MemoryUnit: ...


class SupportsProceduralMemory(Protocol):
    async def add_habit(self, habit: Habit) -> Habit: ...


class SupportsGraphStore(Protocol):
    async def find_similar_node(
        self,
        embedding: list[float],
        threshold: float = 0.7,
        container: str = "",
    ) -> GraphEntity | None: ...
    async def create_node(self, entity: GraphEntity) -> str: ...
    async def merge_node(self, existing: GraphEntity, new: GraphEntity) -> GraphEntity: ...
    async def create_edge_by_name(
        self,
        source_name: str,
        target_name: str,
        rel_type: RelationType,
        container: str = "",
    ) -> str | None: ...


class ExtractorContext(Protocol):
    static_memory: SupportsStaticMemory
    dynamic_memory: SupportsDynamicMemory
    graph_store: SupportsGraphStore
    procedural_memory: SupportsProceduralMemory | None

    async def search(
        self,
        query: str,
        container: str,
        top_k: int = 5,
    ) -> list[MemoryUnit]: ...

    async def soft_delete(self, memory_id: str, reason: str = "") -> None: ...
```

**Refactor path:**
1. Add `engines/protocols.py`
2. Move the protocol there
3. Type `MemoryExtractor.__init__(..., hippocampus: ExtractorContext)`
4. Keep `Hippocampus` as one implementation of that protocol
5. Update extractor tests/fakes to implement the same narrow surface

**Why deferred:** Current `TYPE_CHECKING` fix is safe and sufficient. This refactor is about cleaner architecture, lower coupling, and easier testing — not immediate correctness.

### F10: Scalable consolidation for large memory sets

`ReasoningBank.consolidate()` currently performs multiple O(N^2) pairwise passes across memories in Python. This is acceptable for small/medium agent memory sets, but it will eventually become an event-loop and latency problem as memory volume grows.

**Recommended direction:**
1. Partition candidate sets before pairwise comparison (for example by domain / memory type / recency window)
2. Generate likely duplicate/merge candidates using vector pre-filtering instead of full all-pairs scans
3. Batch similarity work with numpy or another vectorized path
4. Chunk long consolidation passes so async workers can yield between batches
5. Add metrics/logging for consolidation duration, candidate volume, and skipped batches

**Avoid as final design:** A simple fixed hard cap is acceptable as an emergency guardrail, but it is not the preferred long-term solution because it silently drops part of the memory set from maintenance.

**When:** Before large-memory production workloads or when agent memory cardinality starts growing materially

---

## 7. Standalone Deferred

| # | Issue | Why Deferred |
|---|-------|--------------|
| S11 | O(E) edge scan in `InMemoryGraphStoreBackend` | Test scaffolding only; production uses Neo4j with native graph indices |

---

## 8. ~~Test Quality — New Findings~~ — ALL RESOLVED Phase 5 Prompt 6

All 9 test quality issues resolved. T1–T13 from PR#1 + RT1–RT9 from holistic review all done.

| # | Status |
|---|--------|
| ~~RT1~~ | **RESOLVED** — Asserts `== 0` not `>= 0` |
| ~~RT2~~ | **RESOLVED** — `FakeNeo4jSession` uses precise `startswith()` matching |
| ~~RT3~~ | **RESOLVED** — Comment documenting fake-only traversal behavior |
| ~~RT4~~ | **RESOLVED** — Comment explaining search ignores expiry by design |
| ~~RT5~~ | **RESOLVED** — `top_k` truncation test added (10 memories, top_k=3) |
| ~~RT6~~ | **RESOLVED** — Cross-scope dedup test added |
| ~~RT7~~ | **RESOLVED** — Empty static store promotion test added |
| ~~RT8~~ | **RESOLVED** — `@pytest_asyncio.fixture` with proper teardown |
| ~~RT9~~ | **RESOLVED** — Asserts `"uses"` (G5 fixed in Prompt 5) |

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| **Open — Must Fix** | 0 CRITICAL + 0 HIGH + 0 MEDIUM | All resolved (C2, R1–R12). R6 partial→F8, R8 deferred→F10. |
| Graph Store (deferred) | 5 | G1–G5 |
| Extraction Modes (deferred) | 1 | E1 |
| ~~Dashboard Summary~~ | ~~1~~ | ~~H2~~ **RESOLVED Prompt 4** |
| ~~Design Thoughts~~ | ~~1~~ | ~~D1~~ **RESOLVED Prompt 2** (L12 deferred) |
| Future Improvements | 10 | F1–F10 |
| Standalone Deferred | 1 | S11 |
| ~~Test Quality~~ | ~~9~~ | ~~RT1–RT9~~ **ALL RESOLVED Prompt 6** |
| **Total Open** | **0** | All code + test issues resolved through Phase 5 Prompts 1–6 |
| **Total Deferred** | **12** | Post-MVP (F1–F10, G1, G3) |
| **Total Test Issues** | **9** | RT1–RT9 |

**Phase 0–4 scorecard:** 65 of 77 original items resolved. **Phase 5 Prompts 1–4:** All 13 code issues resolved (C2, R1–R12). Dashboard wired (H2). D1/M13 resolved. R6 partial (see F8), R8 deferred (see F10).

### Priority Order — ALL RESOLVED
1. ~~**Immediate** (security/data loss): R1, R2, R4~~ **Prompt 1**
2. ~~**Before production**: C2, R5, R11~~ **Prompts 2–3**
3. ~~**Performance**: R3~~ **Prompt 3** | R8 → F10 (deferred)
4. ~~**Hardening**: R6, R9, R10, R12~~ **Prompt 3** | R6 partial → F8
5. ~~**Type safety**: R7~~ **Prompt 3**
6. ~~**Dashboard**: H2~~ **Prompt 4**
