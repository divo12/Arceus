# Hippocampus Phase 5: Dashboard Integration + Production Hardening

> **Spec reference**: hippocampus_design_v6.md Phase 5 (Week 10)
> **Branch**: `divo/hippocampus-phase1` (continuing)
> **Exit criteria**: Board inspects agent beliefs via projections; all security/correctness issues resolved; graph visualization works end-to-end
> **Depends on**: Phase 0-4 (all complete)

---

## Overview

Phase 5 has two tracks running in parallel:

1. **Track A — Dashboard Integration**: Wire up the projection layer so the board can inspect agent memory through the dashboard. Memory explorer, graph visualization, pattern cards, promotion stream.
2. **Track B — Production Hardening**: Fix the 13 open code issues (R1-R12 + C2) and 9 test quality issues (RT1-RT9) surfaced by the holistic review. These are security, correctness, and reliability fixes that must land before production.

---

## What Already Exists (Phase 0-4 Foundation)

| Component | Status | What Exists |
|-----------|--------|-------------|
| **MemorySummaryProjection** | PARTIAL | Type defined, `get_summary()` wired but 3 fields always empty (`top_patterns`, `recent_learnings`, `recent_promotions`) |
| **GraphMemoryView** | PARTIAL | Type defined, `get_graph_view()` works but flattens edges to `"related_to"` and graph has known issues (G1-G5) |
| **MemoryPromotionEvent** | COMPLETE | Type defined, `get_promotion_stream()` works, events stored in `PromotionEngine._event_log` |
| **ArceusMemoryProjections** | PARTIAL | 3 methods exist: `get_summary()`, `get_graph_view()`, `get_promotion_stream()` — all functional but shallow |
| **Pattern cards** | NOT WIRED | `PatternLearner` exists, patterns stored, but no projection method to surface them |
| **Version history** | BROKEN | G2+G3: `UPDATES` edges have no `GraphEntity` nodes; `cypher_query()` ignores query |
| **Tenant isolation** | BROKEN | C2: `VectorStore.search` not agent-scoped |
| **Neo4j security** | BROKEN | R1: Cypher injection, R2: schema race condition |

---

## Track A: Dashboard Integration

### Step A1: Wire `get_summary()` Empty Fields

**File**: `hippocampus/hippocampus.py` — `get_summary()`

Currently returns empty lists for `top_patterns`, `recent_learnings`, `recent_promotions`. Wire them:

```python
# recent_promotions — method already exists
recent_promotions = []
if self.promotion_engine is not None:
    events = await self.promotion_engine.get_recent_promotions(limit=5)
    recent_promotions = [
        f"{e.from_type}→{e.to_type}: {e.reason}" for e in events
    ]

# recent_learnings — get last 7 days of dynamic memories
recent_learnings = []
if hasattr(self, 'dynamic_memory') and self.dynamic_memory is not None:
    recent = await self.dynamic_memory.get_recent(container, days=7)
    recent_learnings = [m.content for m in recent[:5]]

# top_patterns — add get_top_patterns() to PatternLearner
top_patterns = []
if self.pattern_learner is not None:
    patterns = await self.pattern_learner.get_top_patterns(limit=5)
    top_patterns = [
        {"description": p.description, "success_rate": p.success_rate, "usage_count": p.usage_count}
        for p in patterns
    ]
```

**Requires**:
- Add `get_top_patterns(limit: int = 5) -> list[Pattern]` to `PatternLearner`
- Add `get_recent(container: str, days: int) -> list[MemoryUnit]` to `DynamicMemory`
- Update `get_summary()` signature to accept `container: str`

### Step A2: Pattern Cards Projection

**File**: `memory_projections.py` — add new method

```python
async def get_pattern_cards(
    self, hippocampus: Hippocampus, limit: int = 10
) -> list[dict]:
    """Pattern cards with LLM-generated names for dashboard display."""
    if hippocampus.pattern_learner is None:
        return []
    patterns = await hippocampus.pattern_learner.get_top_patterns(limit=limit)
    return [
        {
            "id": p.id,
            "description": p.description,
            "strategy": p.strategy,
            "domain": p.domain,
            "success_rate": p.success_rate,
            "usage_count": p.usage_count,
            "status": p.status.value,
        }
        for p in patterns
    ]
```

### Step A3: Fix Graph Visualization (G1-G5)

This is the largest Track A item. Graph needs to actually work for dashboard display.

**G2 fix**: Create `GraphEntity` nodes when memories are stored.

**File**: `tiers/static.py` + `tiers/dynamic.py` — after `_vector_store.upsert()`, also create a corresponding `GraphEntity` node:

```python
# After upsert to vector store, mirror to graph
entity = GraphEntity(
    id=unit.id,
    name=unit.content[:100],
    entity_type=unit.memory_type.value,
    properties={"container": unit.container, "agent_id": unit.agent_id},
)
await self._graph_store.upsert_node(entity)
```

**G4 fix**: `create_edge` should raise on missing nodes.

**File**: `neo4j_graph.py` — after `MATCH...CREATE` query, check `result.peek()`:

```python
if not records:
    raise KeyError(f"Cannot create edge: source={source_id} or target={target_id} not found")
```

**G5 fix**: `get_graph_view()` should preserve real edge types.

**File**: `memory_projections.py` — use `graph_store._backend.get_edges()` to get actual relationships:

```python
all_edges = await hippocampus.graph_store._backend.get_edges(center.id)
edges = [
    {"source": e.source_id, "target": e.target_id, "type": e.relation_type.value, "weight": e.weight}
    for e in all_edges
    if e.target_id in {n.id for n in neighbors}
]
```

**G1 deferred**: BM25 re-ranking — add container filter to `GraphStore.search()` but defer BM25 to Phase 6.

**G3 deferred**: `cypher_query()` in `InMemoryGraphStoreBackend` — document as test-only limitation. Production uses Neo4j natively.

### Step A4: Memory Explorer Endpoint Support

Add methods to support a memory explorer UI that lets the board browse and search memories.

**File**: `hippocampus.py` — add:

```python
async def list_memories(
    self, container: str, memory_type: MemoryType | None = None, limit: int = 50
) -> list[MemoryUnit]:
    """List memories for explorer view with optional type filter."""
    if memory_type is not None:
        return await self._vector_store.list_by_type(
            agent_id=self._agent_id, memory_type=memory_type
        )[:limit]
    static = await self._vector_store.list_by_type(
        agent_id=self._agent_id, memory_type=MemoryType.STATIC
    )
    dynamic = await self._vector_store.list_by_type(
        agent_id=self._agent_id, memory_type=MemoryType.DYNAMIC
    )
    return sorted(static + dynamic, key=lambda m: m.created_at, reverse=True)[:limit]
```

**File**: `memory_projections.py` — add:

```python
async def get_memory_explorer(
    self, hippocampus: Hippocampus, container: str,
    memory_type: str | None = None, limit: int = 50
) -> list[dict]:
    """Memory explorer data for dashboard browse/search UI."""
    type_filter = MemoryType(memory_type) if memory_type else None
    memories = await hippocampus.list_memories(container, type_filter, limit)
    return [
        {
            "id": m.id,
            "content": m.content,
            "memory_type": m.memory_type.value,
            "confidence": m.confidence,
            "created_at": m.created_at.isoformat(),
            "container": m.container,
            "source_type": m.source_type,
        }
        for m in memories
    ]
```

### Step A5: Version History (depends on G2 fix)

Once `GraphEntity` nodes exist for memories, version history becomes functional.

**File**: `memory_projections.py` — add:

```python
async def get_version_history(
    self, hippocampus: Hippocampus, memory_id: str
) -> list[dict]:
    """Version chain for a specific memory."""
    history = await hippocampus.graph_store.get_version_history(memory_id)
    return [
        {"id": node.id, "name": node.name, "created_at": node.properties.get("created_at", "")}
        for node in history
    ]
```

---

## Track B: Production Hardening

### Step B1: Security Fixes (CRITICAL)

**R1 — Cypher injection** (`neo4j_graph.py:142-146`):
```python
async def get_neighbors(self, node_id: str, max_hops: int = 2) -> list[GraphEntity]:
    if not isinstance(max_hops, int) or max_hops < 1 or max_hops > 10:
        raise ValueError(f"max_hops must be int 1-10, got {max_hops!r}")
    # ... rest of method
```

**R2 — Schema race condition** (`neo4j_graph.py:196-206`):
```python
import asyncio

class Neo4jGraphStoreBackend:
    def __init__(self, ...):
        # ... existing
        self._schema_ready = False
        self._schema_lock = asyncio.Lock()  # ADD THIS

    async def _ensure_schema(self):
        if self._schema_ready:
            return
        async with self._schema_lock:
            if self._schema_ready:  # double-check
                return
            async with self._driver.session() as session:
                await session.run("CREATE CONSTRAINT ...")
            self._schema_ready = True
```

### Step B2: Data Loss Fix (HIGH)

**R4 — DistilledMemory drops container** (`types.py`):

Add `container` field to `DistilledMemory`:
```python
@dataclass(frozen=True)
class DistilledMemory:
    # ... existing fields
    container: str = ""  # ADD THIS

    def to_memory_unit(self) -> MemoryUnit:
        return MemoryUnit(
            # ... existing
            container=self.container,  # ADD THIS
        )
```

Thread `container` from `ReasoningBank.distill()`:
```python
async def distill(self, trajectory, verdict, container: str = "") -> DistilledMemory | None:
    # ...
    distilled = DistilledMemory(
        # ... existing
        container=container,  # ADD THIS
    )
```

### Step B3: Correctness Fixes (HIGH)

**R3 — N+1 graph search** (`graph_store.py:99-102`):
```python
import asyncio

# Replace sequential loop with gather
neighbor_lists = await asyncio.gather(
    *[self._backend.get_neighbors(node.id, max_hops) for node in seed_nodes]
)
all_neighbors = [n for sublist in neighbor_lists for n in sublist]
```

**R5 — Priming key-errors** (`tiers/priming.py:23-27`):
```python
new_state = {
    "confidence": current.get("confidence", 0.5) * (1 - lr) + max(signal, 0) * lr,
    "caution": current.get("caution", 0.3) * (1 - lr) + max(-signal, 0) * lr,
    "morale": current.get("morale", 0.5) * (1 - lr) + (signal * 0.5 + 0.5) * lr,
    "recent_events": [
        *current.get("recent_events", [])[-9:],
        # ...
    ],
}
```

**R6 — Procedural silent drops** (`tiers/procedural.py:38`):
```python
import logging
logger = logging.getLogger(__name__)

# In get_matching_habits:
if not isinstance(items, list):
    logger.warning("Unexpected LLM response shape in get_matching_habits: %s", type(items))
    return []

# For index coercion:
try:
    idx = int(item.get("index", -1))
except (TypeError, ValueError):
    logger.warning("Non-integer index in habit match response: %r", item.get("index"))
    continue
```

### Step B4: Tenant Isolation (C2 + D1 Design)

**C2 — VectorStore.search agent_id scoping**:

1. Add `agent_id: str` parameter to `VectorStore.search` protocol
2. Update `InMemoryVectorStore.search()` to filter by `agent_id`
3. Update all call sites in `Hippocampus` to pass `self._agent_id`
4. Remove dangling `agent_id` param from `Hippocampus.search()` (M13)
5. Clean up `L12` — remove unused `pattern_store` from `ReasoningBank.__init__`

### Step B5: Hardening Fixes (MEDIUM)

**R7 — Extractor untyped** (`engines/extractor.py:38`):
```python
from __future__ import annotations
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from arceus.core.hippocampus.hippocampus import Hippocampus
```

**R8 — O(N^2) consolidation cap** (`engines/reasoning_bank.py`):
```python
MAX_CONSOLIDATION_MEMORIES = 500
# In consolidate():
all_memories = all_memories[:MAX_CONSOLIDATION_MEMORIES]  # TODO: batch with numpy
```

**R9 — Lock leak** (`tiers/working.py`):
```python
async def clear_task(self, task_id: str) -> None:
    # ... existing clear calls
    # Cleanup lock
    key = f"{self._prefix}:conv:{task_id}"
    self._conversation_locks.pop(key, None)
```

**R10 — Event log cap** (`engines/promotion_engine.py`):
```python
from collections import deque

# In __init__:
self._event_log: deque[MemoryPromotionEvent] = deque(maxlen=200)
```

**R11 — API key exposure** (`backends/azure_openai_llm.py`):
```python
from pydantic import SecretStr

def __init__(self, ...):
    # Store as SecretStr, not plain str
    self._api_key = SecretStr(api_key) if api_key else settings.azure_openai_api_key

def _get_client(self):
    # Unwrap only here
    api_key = self._api_key.get_secret_value() if isinstance(self._api_key, SecretStr) else self._api_key
```

**R12 — Classify silent fallback** (`backends/azure_openai_llm.py`):
```python
# After the options loop:
logger.warning(
    "classify() could not match LLM response %r to options %r; defaulting to %r",
    normalized, options, options[0]
)
return options[0]
```

### Step B6: Test Quality Fixes (RT1-RT9)

| # | Fix |
|---|-----|
| RT1 | `test_gc.py` — assert exact `== 0` values for empty baseline |
| RT2 | `test_backends.py` — use regex query matching in `FakeNeo4jSession` |
| RT3 | `test_backends.py` — add comment documenting fake-only traversal |
| RT4 | `test_backends.py` — add comment: `search` intentionally ignores `expires_at` |
| RT5 | `test_backends.py` — add test with 10 memories, `top_k=3` |
| RT6 | `test_memory_scope.py` — add cross-scope dedup test |
| RT7 | `test_promotion_engine.py` — add empty-store promotion test |
| RT8 | `conftest.py` — convert to `@pytest_asyncio.fixture` |
| RT9 | `test_memory_projections.py` — add comment linking to G5 |

---

## Execution Order

### Phase 5a — Security (do first, in parallel)
1. **B1**: R1 + R2 (Neo4j security) — 30 min
2. **B2**: R4 (distilled memory container) — 20 min
3. **B3**: R3, R5, R6 (correctness) — 45 min

### Phase 5b — Tenant Isolation
4. **B4**: C2 + D1 + M13 + L12 (agent_id scoping) — 1-2 hours

### Phase 5c — Dashboard (main feature work)
5. **A1**: Wire summary empty fields — 1 hour
6. **A2**: Pattern cards projection — 30 min
7. **A3**: Graph fixes G2, G4, G5 — 2 hours
8. **A4**: Memory explorer — 1 hour
9. **A5**: Version history — 30 min

### Phase 5d — Hardening (can parallel with 5c)
10. **B5**: R7-R12 (medium fixes) — 1 hour
11. **B6**: RT1-RT9 (test quality) — 1.5 hours

### Phase 5e — Verify
12. Run full test suite: `uv run pytest tests/ -v`
13. Run Hippocampus_app scenario tests
14. Verify dashboard projections return complete data

---

## Key Files

| File | Operation | Description |
|------|-----------|-------------|
| `hippocampus/hippocampus.py` | Modify | Wire summary fields, add `list_memories()`, remove `agent_id` from `search()` |
| `hippocampus/types.py` | Modify | Add `container` to `DistilledMemory`, type `list` fields |
| `hippocampus/backends/protocols.py` | Modify | Add `agent_id` to `VectorStore.search` |
| `hippocampus/backends/neo4j_graph.py` | Modify | R1 injection fix, R2 race fix, G4 missing node check |
| `hippocampus/backends/azure_openai_llm.py` | Modify | R11 SecretStr, R12 classify warning |
| `hippocampus/backends/in_memory_vector.py` | Modify | Add `agent_id` filter to `search()` |
| `hippocampus/engines/graph_store.py` | Modify | R3 asyncio.gather for neighbors |
| `hippocampus/engines/reasoning_bank.py` | Modify | R8 consolidation cap, R4 container threading |
| `hippocampus/engines/extractor.py` | Modify | R7 TYPE_CHECKING import |
| `hippocampus/engines/promotion_engine.py` | Modify | R10 deque cap |
| `hippocampus/engines/pattern_learner.py` | Modify | Add `get_top_patterns()` |
| `hippocampus/tiers/priming.py` | Modify | R5 `.get()` defaults |
| `hippocampus/tiers/procedural.py` | Modify | R6 logging + int coercion |
| `hippocampus/tiers/working.py` | Modify | R9 lock cleanup |
| `hippocampus/tiers/static.py` | Modify | G2 mirror to graph nodes |
| `hippocampus/tiers/dynamic.py` | Modify | G2 mirror to graph nodes, add `get_recent()` |
| `core/memory_projections.py` | Modify | A2 pattern cards, A4 explorer, A5 version history, G5 real edges |
| `tests/hippocampus/unit/test_backends.py` | Modify | RT2-RT5 fixes |
| `tests/hippocampus/unit/test_gc.py` | Modify | RT1 fix |
| `tests/hippocampus/unit/test_promotion_engine.py` | Modify | RT7 fix |
| `tests/adapters/conftest.py` | Modify | RT8 async fixture |
| `tests/adapters/test_memory_scope.py` | Modify | RT6 dedup test |
| `tests/adapters/test_memory_projections.py` | Modify | RT9 comment + new projection tests |

---

## Risks and Mitigation

| Risk | Mitigation |
|------|------------|
| C2 agent_id scoping touches many files | Protocol change is mechanical; grep all `VectorStore.search` call sites |
| G2 graph node mirroring doubles storage writes | Acceptable for dashboard value; graph is optional observability layer |
| R8 consolidation cap may skip valid merges | 500 is generous for MVP; add `logger.info` when cap hit |
| Graph fix tests need Neo4j fakes update | RT2 already covers fake improvements |

---

## SESSION_ID (for /ccg:execute use)
- CODEX_SESSION: N/A
- GEMINI_SESSION: N/A
