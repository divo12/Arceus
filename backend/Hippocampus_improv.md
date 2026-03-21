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
| G1 | `GraphStore.search()` missing native vector + BM25 | Current `neo4j_graph.py:vector_search()` fetches ALL nodes and computes cosine in Python. Production should use Neo4j native vector index (`db.index.vector.queryNodes`) + fulltext BM25 index (`db.index.fulltext.queryNodes`) with Reciprocal Rank Fusion. Add indexes in `_ensure_schema()`. Fix when graph becomes part of agent decision path. |

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

### Hippocampus Public Write API (F1)

**Problem:** `DelegationMemoryManager.prepare_delegation_context()` (`delegation_memory.py:67`) calls `to_hippocampus._vector_store.upsert(copy)` directly. This bypasses:
- Embedding generation (copied memories keep stale embeddings from source agent)
- Graph node creation (`ensure_memory_node` never called — delegated memories invisible in graph)
- Tier routing (everything forced to DYNAMIC regardless of source type)
- Usage tracking (delegated memories start with zero access count)

**What breaks today:** Delegated memories don't appear in graph visualization. If the source agent's embedding model changes, copied embeddings become incompatible with the target agent's search space.

**Fix:** Add `Hippocampus.ingest()` — a public write path for pre-formed memories:

```python
async def ingest(
    self,
    content: str,
    container: str,
    memory_type: MemoryType = MemoryType.DYNAMIC,
    *,
    visibility: MemoryVisibility = MemoryVisibility.PRIVATE,
    source_type: str = "",
    source_id: str = "",
    provenance: str = "",
    metadata: dict | None = None,
) -> MemoryUnit:
    """Public write path — generates embedding, creates graph node, routes to tier."""
    embedding = await self._embedding.embed(content)
    unit = MemoryUnit(
        agent_id=self._agent_id, content=content, embedding=embedding,
        memory_type=memory_type, container=container, visibility=visibility,
        source_type=source_type, source_id=source_id, provenance=provenance,
        metadata=metadata or {},
    )
    # Route to correct tier
    if memory_type == MemoryType.STATIC:
        return await self.static_memory.add(...)
    else:
        return await self.dynamic_memory.add(...)
```

Then `DelegationMemoryManager` becomes:
```python
# Before: await to_hippocampus._vector_store.upsert(copy)
# After:
await to_hippocampus.ingest(
    content=mem.content, container=task_container,
    memory_type=MemoryType.DYNAMIC, visibility=MemoryVisibility.TASK_SCOPED,
    source_type="delegation", source_id=from_agent_id,
)
```

**When:** Before delegation flow is used in production.

### Decouple Extractor from Concrete Hippocampus (F9)

**Problem:** `MemoryExtractor.__init__` takes `hippocampus: Hippocampus` — the full concrete class. Currently safe via `TYPE_CHECKING` guard (R7 fix), but extractor only uses 6 capabilities:
- `static_memory.add()`, `static_memory.update()`
- `dynamic_memory.add()`
- `graph_store.find_similar_node()`, `graph_store.create_node()`, `graph_store.merge_node()`, `graph_store.create_edge_by_name()`
- `procedural_memory.add_habit()`
- `search()`
- `soft_delete()`

Everything else on `Hippocampus` (GC, promotion, priming, consolidation, summary, recall) is invisible to extractor.

**Fix:** Define narrow protocol in `engines/protocols.py`:

```python
class ExtractorContext(Protocol):
    static_memory: SupportsStaticMemory
    dynamic_memory: SupportsDynamicMemory
    graph_store: SupportsGraphStore
    procedural_memory: SupportsProceduralMemory | None
    async def search(self, query: str, container: str, top_k: int = 5) -> list[MemoryUnit]: ...
    async def soft_delete(self, memory_id: str, reason: str = "") -> None: ...
```

`Hippocampus` naturally satisfies this protocol. Tests can provide a lightweight fake instead of constructing a full Hippocampus with all backends.

**When:** When extractor tests need to be faster or when a second consumer of `ExtractorContext` appears.

### Multi-Startup Scoping for Procedural & Priming (F6)

**Problem:** `ProceduralMemory` and `PrimingMemory` are scoped only by `agent_id`. If the same agent (e.g., `cto-1`) works across startups `acme` and `globex`, habits learned in `acme` ("always require security review") apply to `globex` too — which may be wrong.

**Current state:** Single-startup assumption holds. `startup_id` exists on `MemoryUnit` but is not used in `Habit` model or priming state queries.

**Fix:**
1. Add `startup_id: str` to `Habit` dataclass
2. Add `startup_id` column to relational `habits` table
3. All `ProceduralMemory` queries filter by `(agent_id, startup_id)`
4. `PrimingMemory` state key becomes `priming:{startup_id}:{agent_id}` instead of `priming:{agent_id}`
5. `Hippocampus.create()` threads `startup_id` to both tiers

**When:** When multi-startup-per-agent becomes a real product requirement.

### L12: Unused `pattern_store` in ReasoningBank

`ReasoningBank.__init__` accepts `pattern_store: PatternStore` and assigns `self._pattern_store`, but no method ever reads it. Vestigial from an earlier design where reasoning bank would query patterns during consolidation.

Remove the parameter and assignment when next touching `ReasoningBank`. One-line change, two call sites (`hippocampus.py:174`, `test_reasoning_bank.py:59`).

### Soft-Delete Compaction (F2)

**Problem:** `StaticMemory.update()` soft-deletes old versions (`is_deleted=True, deleted_reason="superseded_by_update"`), but they remain in the vector store forever. Over time, soft-deleted records accumulate — consuming storage, slowing `list_by_type()` scans, and inflating backup size.

**Fix:** Add a compaction job (can run inside `GarbageCollector.run()` or as a separate scheduled task):
1. Query all soft-deleted memories older than retention window (e.g., 30 days)
2. Archive to cold storage if audit trail needed
3. Hard-delete from vector store
4. Optionally keep latest `K` versions per memory chain (for rollback)

**When:** When memory volume affects storage cost or search performance.

### Centralize Promotion/Pruning Lifecycle (F3)

**Problem:** `ReasoningBank.consolidate()` and `PromotionEngine.run_promotions()` both independently decide when memories should be promoted, pruned, or merged. The thresholds are aligned through `HippocampusConfig`, but the logic is duplicated:
- ReasoningBank: checks `access_count >= threshold` and `confidence >= threshold` and `age >= days` in `consolidate()`
- PromotionEngine: checks the same fields with the same thresholds in `_qualifies_for_static()`

**Fix:** Extract `MemoryLifecyclePolicy`:
```python
class MemoryLifecyclePolicy:
    def qualifies_for_promotion(self, mem: MemoryUnit) -> bool: ...
    def qualifies_for_pruning(self, mem: MemoryUnit) -> bool: ...
    def is_stale(self, mem: MemoryUnit) -> bool: ...
```

Both engines call the shared policy. Add cross-engine test asserting they agree on the same candidate set.

**When:** When lifecycle rules become more complex (e.g., domain-specific promotion criteria, startup-level overrides).

### Profile Compaction for Prompt Context (F4)

**Problem:** `ArceusProfileEngine.generate_profile()` returns ALL static facts, ALL dynamic facts, ALL active habits, and full priming state. With a mature agent, this could be 50+ static facts, 100+ dynamic facts — too large for LLM prompt injection.

**Current code (`profile_engine.py:42-51`):**
```python
static_facts = await hippocampus.list_memories(...)   # all static
dynamic_facts = await hippocampus.list_memories(...)   # all dynamic
```

**Fix:** Add `generate_compact_profile(task_description, token_budget)`:
1. Score facts by relevance to current task (vector similarity to `task_description`)
2. Score habits by recency and trigger relevance
3. Pack highest-scoring items until `token_budget` reached
4. Summarize remaining items as "and N more facts about X domain..."

**When:** When profiles create prompt-budget pressure (likely when agents accumulate >50 static facts).

### Backend-Native Atomic Append for Working Memory (F7)

**Problem:** `WorkingMemory.append_conversation()` (`working.py:22-28`) does read-modify-write under an in-process `asyncio.Lock`. Safe for single process, but if two workers serve the same agent:
1. Worker A reads `[]`, Worker B reads `[]`
2. Both append and write — one message lost

**Fix:** Extend `WorkingMemoryBackend` protocol with:
```python
async def append(self, key: str, value: str, ttl_seconds: int) -> None: ...
```

Implementation per backend:
- **Redis:** `RPUSH` + `EXPIRE` (atomic, no read-modify-write needed)
- **PostgreSQL:** `INSERT INTO conversations (key, message, seq) VALUES ($1, $2, nextval(...))` with row-level locking
- **DictCacheStore:** Keep current in-process lock (test scaffolding only)

**When:** When working memory is written from multiple processes (distributed deployment).

### Scalable Consolidation for Large Memory Sets (F10)

**Problem:** `ReasoningBank.consolidate()` loads ALL dynamic memories and runs three O(N^2) pairwise loops:
- Dedup pass: cosine similarity on all pairs
- Contradiction pass: cosine similarity on all pairs → LLM classification
- Merge pass: cosine similarity on all pairs → LLM merge

With 5,000 memories this is 25M cosine comparisons in pure Python, blocking the event loop.

**Recommended approach:**
1. **Vector pre-filtering:** Use the vector store to find likely duplicate candidates (top-k nearest neighbors per memory) instead of all-pairs
2. **Partitioning:** Group by domain/container before pairwise comparison — memories in different domains rarely duplicate
3. **Batched numpy:** Replace Python-loop cosine with `numpy` matrix operations for 100x speedup on the similarity computation
4. **Chunked async:** `await asyncio.sleep(0)` between batches to yield back to the event loop
5. **Metrics:** Log consolidation duration, candidate volume, and merge/dedup/contradiction counts

**Emergency guardrail:** If implementing the above is deferred further, a `MAX_CONSOLIDATION_MEMORIES = 500` cap sorted by confidence is acceptable as a temporary measure — but it silently drops low-confidence memories from maintenance.

**When:** Before agent memory cardinality exceeds ~1,000 dynamic memories per container.

### LLM Observability (F8)

**Problem:** Phase 5 Prompt 3 added `logger.warning()` at key boundaries (classify fallback, procedural habit matching). But there's no structured observability for:
- How often LLM returns unparseable JSON (extraction, contradiction check, merge)
- Fallback frequency per engine method (classify, decide, analyze)
- Retry counts from tenacity (currently logged but not metered)
- Prompt/response pairs for debugging (currently discarded after use)

**Fix:**
1. Add counters per LLM method: `llm_calls_total`, `llm_fallbacks_total`, `llm_parse_errors_total`
2. Structured log fields: `{"engine": "classify", "options": [...], "response": "...", "matched": false}`
3. Optional trace capture: store last N prompt/response pairs in a ring buffer for debug inspection
4. Wire into `AzureOpenAILLMEngine` — the only production LLM backend

**When:** When operational monitoring becomes part of production readiness.

---

## Summary

| Category | Count |
|----------|-------|
| Graph Store | 1 (G1) |
| Extraction Modes | 1 |
| Production Backends | 1 (F5) |
| Architecture | 4 (F1, F6, F9, L12) |
| Lifecycle & Storage | 2 (F2, F3) |
| Performance & Scalability | 3 (F4, F7, F10) |
| Observability | 1 (F8) |
| **Total Deferred** | **13** |

All items are post-MVP. No blockers for current development.
