# Hippocampus — Future Roadmap

> **Phase 0–5 complete.** All 77 original review items + 13 holistic review items + 9 test quality items resolved. 135 tests passing.
>
> This file tracks only **remaining deferred work** — architectural improvements for post-MVP.
>
> For full resolution history, see git history on the `divo/hippocampus-phase1` branch.

---

## Graph Store

| # | Issue | Context |
|---|-------|---------|
| G1 | `GraphStore.search()` missing BM25 + container scoping | Spec calls for `bm25_rerank()` after cosine. Current impl uses cosine only, no container filter. Fix when graph becomes part of agent decision path. |
| G3 | `cypher_query()` ignores query param | `InMemoryGraphStoreBackend` hardcodes UPDATES chain traversal regardless of input query. Test scaffolding only — production uses Neo4j. |
| S11 | O(E) edge scan in `InMemoryGraphStoreBackend` | Test scaffolding only; production uses Neo4j with native graph indices. |

---

## Extraction Modes

Extraction works for current AGENT-centric flows. Expand when meetings and reflection loops become active product inputs.

1. Add explicit `REFLECTION` mode on `ExtractionMode`
2. Dedicated `CONVERSATION` and `REFLECTION` prompts
3. Mode-aware post-processing (bias memory typing per mode)
4. Better `MEETING` extraction: decisions, owners, deadlines, action items
5. Regression tests proving each mode stores meaningfully different outputs

---

## Production Backend Swap

| Backend | Current (test scaffolding) | Production Target |
|---------|---------------------------|-------------------|
| Relational | `SQLiteRelationalStore` | PostgreSQL |
| Vector | `InMemoryVectorStore` | Qdrant / pgvector / Pinecone |
| Cache | `DictCacheStore` | Redis / Valkey |
| Embedding | `MockEmbeddingEngine` | Azure OpenAI / Cohere |
| Graph | `InMemoryGraphStoreBackend` | `Neo4jGraphStoreBackend` (already exists) |

Protocol-based architecture is correct. Each backend swappable independently. Factory routes based on config.

---

## Architecture Improvements

### Hippocampus Public API

**F1: `DelegationMemoryManager` bypasses Hippocampus public API.** `prepare_delegation_context()` calls `_vector_store.upsert()` directly, skipping embedding generation, graph wiring, and tier routing. Add `Hippocampus.ingest()` accepting full `MemoryUnit` kwargs.

**F9: Narrow `ExtractorContext` protocol.** `MemoryExtractor` depends on concrete `Hippocampus` object. Current `TYPE_CHECKING` fix is safe; better long-term design is a narrow protocol describing only what extractor actually uses. Protocol sketch:

```python
class ExtractorContext(Protocol):
    static_memory: SupportsStaticMemory
    dynamic_memory: SupportsDynamicMemory
    graph_store: SupportsGraphStore
    procedural_memory: SupportsProceduralMemory | None
    async def search(self, query: str, container: str, top_k: int = 5) -> list[MemoryUnit]: ...
    async def soft_delete(self, memory_id: str, reason: str = "") -> None: ...
```

### Scoping & Isolation

**F6: Startup-level scoping for Procedural & Priming.** Currently scoped only by `agent_id`. Add `startup_id` to `Habit` model, relational schema, and all queries. Composite `(startup_id, agent_id)` key for priming state. Fix when multi-startup-per-agent becomes real.

**L12: Unused `pattern_store` in `ReasoningBank`.** Vestigial parameter — assigned in `__init__` but never read. Remove when touching `ReasoningBank` for other reasons.

### Lifecycle & Storage

**F2: Soft-delete compaction.** `StaticMemory.update()` soft-deletes superseded versions, but historical versions remain in storage. Add compaction job to archive/purge old versions. Fix when memory volume affects storage cost.

**F3: Centralize promotion/pruning lifecycle policy.** `ReasoningBank` and `PromotionEngine` carry parallel promotion-candidate logic. Extract shared `MemoryLifecyclePolicy` module. Fix when lifecycle decisions become more complex.

### Performance & Scalability

**F4: Profile compaction for prompt-context.** `ArceusProfileEngine` returns full profile. Add compact-profile projection for LLM injection with context-budget optimization. Fix when profiles create prompt-budget pressure.

**F7: Backend-native atomic append for working memory.** `WorkingMemory.append_conversation()` uses in-process `asyncio.Lock`. Extend `WorkingMemoryBackend` with atomic append (Redis Lua / Postgres row locks). Fix when working memory written from multiple processes.

**F10: Scalable consolidation for large memory sets.** `ReasoningBank.consolidate()` performs O(N^2) pairwise passes. Recommended: partition candidates, vector pre-filtering, numpy batching, chunked async yields. Fix before large-memory production workloads.

### Observability

**F8: Broader LLM observability.** Warning logs exist at key malformed-response boundaries. Add centralized counters for malformed LLM outputs, fallback paths, per-engine warning rates, and lightweight tracing. Fix when operational monitoring becomes part of production readiness.

---

## Summary

| Category | Count |
|----------|-------|
| Graph Store | 3 (G1, G3, S11) |
| Extraction Modes | 1 |
| Production Backends | 1 (F5) |
| Architecture | 4 (F1, F6, F9, L12) |
| Lifecycle & Storage | 2 (F2, F3) |
| Performance & Scalability | 3 (F4, F7, F10) |
| Observability | 1 (F8) |
| **Total Deferred** | **15** |

All items are post-MVP. No blockers for current development.
