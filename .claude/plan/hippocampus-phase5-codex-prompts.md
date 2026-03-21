# Hippocampus Phase 5 — Codex Prompts

> Give these prompts to Codex **in order** (1 → 6). Each prompt builds on the previous one.
> After each prompt, verify the output compiles and tests pass before moving to the next.
>
> **Design principle**: Each Hippocampus is per-agent. All sub-components receive `agent_id` at construction. Public Hippocampus methods are instance-scoped — they never take `agent_id` as a parameter. Only the low-level protocol layer (`RelationalStore`, `VectorStore`) takes `agent_id` in method signatures because the underlying DB is shared.

---

## Prompt 1: Security + Critical Fixes (R1, R2, R4)

```
You are fixing 3 critical/high-severity issues in the Hippocampus memory system. These are security and data-loss bugs that must be resolved before any feature work.

IMPORTANT RULES:
- All dataclasses are frozen — create new instances with `dataclasses.replace()`, NEVER mutate.
- Use `utc_now()` from `arceus.core.hippocampus.utils.time` — NEVER `datetime.utcnow()`.
- Follow existing code style exactly (use `from __future__ import annotations`).
- Minimal changes only — fix the bug, nothing else.

## Fix 1: R1 — Cypher injection in `get_neighbors` (CRITICAL)

File: `backend/arceus/core/hippocampus/backends/neo4j_graph.py`

The `get_neighbors()` method interpolates `max_hops` directly into a Cypher query via f-string:
`[*1..{max_hops}]`

Neo4j does not support parameterized range literals, so we must validate before interpolation.

Fix: Add validation at the top of `get_neighbors()`:
```python
if not isinstance(max_hops, int) or max_hops < 1 or max_hops > 10:
    raise ValueError(f"max_hops must be an integer between 1 and 10, got {max_hops!r}")
```

Also add the same guard to `InMemoryGraphStoreBackend.get_neighbors()` in `in_memory_graph.py` for consistency.

## Fix 2: R2 — `_schema_ready` race condition (CRITICAL)

File: `backend/arceus/core/hippocampus/backends/neo4j_graph.py`

`_schema_ready` is a plain bool with no lock. Concurrent async coroutines can both read `False`, both run `CREATE CONSTRAINT`, and one may set `True` before the other's `await session.run()` completes.

Fix: Add `asyncio.Lock` with double-checked locking pattern (same as `SQLiteRelationalStore.initialize()`):
1. Add `import asyncio` at top
2. Add `self._schema_lock = asyncio.Lock()` in `__init__`
3. In `_ensure_schema()`: fast check outside lock, re-check inside lock, run schema setup, then set flag

## Fix 3: R4 — `DistilledMemory.to_memory_unit()` drops container (HIGH)

File: `backend/arceus/core/hippocampus/types.py`

`DistilledMemory` has no `container` field. When `to_memory_unit()` is called, the resulting `MemoryUnit` has `container=""`, making distilled memories invisible to all scoped queries.

Fix:
1. Add `container: str = ""` field to `DistilledMemory` dataclass
2. Pass `container=self.container` in `to_memory_unit()`
3. In `backend/arceus/core/hippocampus/engines/reasoning_bank.py`, update `distill()` to accept and thread `container: str`:
   - Add `container: str = ""` parameter to `distill()`
   - Pass `container=container` when constructing `DistilledMemory`
4. In `hippocampus.py`, wherever `reasoning_bank.distill()` is called, pass the appropriate container

Do NOT change any other files. Run `uv run pytest tests/ -v` after changes.
```

---

## Prompt 2: Tenant Isolation with Visibility-Aware Retrieval (C2 + D1 + M13 + L12)

```
You are fixing the tenant isolation design inconsistency in the Hippocampus memory system. This is tracked as C2 (critical), M13 (medium), L12 (low), and Design Thought D1.

IMPORTANT RULES:
- All dataclasses are frozen — use `dataclasses.replace()`.
- Minimal changes — only touch what's needed for visibility-aware scoping.
- Run tests after each sub-step.

## Background

The design principle is: one `Hippocampus` instance = one agent. Public methods are instance-scoped. Storage layer enforces access control.

Currently, `VectorStore.search()` filters only by `container`, not `agent_id`. Shared container names can leak memories across agents.

### Design Decision: Visibility-Aware Retrieval (not strict agent_id filtering)

Strict `agent_id` filtering would break startup-shared memory. A memory stored in `startup:acme` by `pm-1` would become invisible to `cto-1`, defeating the purpose of shared containers.

Instead, we use the existing `MemoryVisibility` enum (already on `MemoryUnit`) to control cross-agent access:

```python
class MemoryVisibility(Enum):
    PRIVATE = "private"          # only owning agent can see
    TASK_SCOPED = "task_scoped"  # agents in same startup can see
    STARTUP_SHARED = "shared"    # agents in same startup can see
    BOARD_VISIBLE = "board"      # agents in same startup can see
```

The retrieval predicate is:
- **Own memories** (`memory.agent_id == caller_agent_id`): always returned
- **Non-PRIVATE memories** (`memory.visibility != PRIVATE`): returned to any agent (single-startup assumption — all agents share one startup)
- **PRIVATE + different agent**: blocked

This preserves tenant isolation while keeping startup-shared memory truly shared.

NOTE: We assume a single startup for now. When multi-startup becomes real (F6), add `startup_id` to the search predicate as a one-line change.

## Sub-step 2A: Add `agent_id` to `VectorStore.search` protocol

File: `backend/arceus/core/hippocampus/backends/protocols.py`

Add `agent_id: str` as a keyword parameter to `VectorStore.search()`:
```python
async def search(
    self,
    embedding: list[float],
    container: str,
    *,
    agent_id: str = "",  # ADD THIS — caller's agent_id for visibility filtering
    memory_types: list[MemoryType] | None = None,
    top_k: int = 10,
) -> list[MemoryUnit]: ...
```

Also add `agent_id: str = ""` to `list_by_type()` if it exists on the protocol, using the same visibility logic.

## Sub-step 2B: Implement visibility-aware filtering in `InMemoryVectorStore`

File: `backend/arceus/core/hippocampus/backends/in_memory_vector.py`

Add a helper function (module-level or static method):
```python
from arceus.core.hippocampus.types import MemoryVisibility

def _is_accessible(memory: MemoryUnit, agent_id: str) -> bool:
    """Check if a memory is accessible to the given agent.

    Rules (single-startup assumption):
    - Agent's own memories are always accessible
    - Non-PRIVATE memories are accessible to all agents
    - PRIVATE memories from other agents are blocked
    """
    if not agent_id:
        return True  # no agent_id means no filtering (backward compat)
    if memory.agent_id == agent_id:
        return True
    if memory.visibility != MemoryVisibility.PRIVATE:
        return True
    return False
```

Update `search()` to use it:
```python
async def search(
    self,
    embedding: list[float],
    container: str,
    *,
    agent_id: str = "",
    memory_types: list[MemoryType] | None = None,
    top_k: int = 10,
) -> list[MemoryUnit]:
    results: list[tuple[float, MemoryUnit]] = []
    for memory in self._items.values():
        if memory.container != container:
            continue
        if not _is_accessible(memory, agent_id):
            continue
        # ... rest of existing filtering (memory_types, deleted, cosine sim)
```

## Sub-step 2C: Thread `agent_id` from Hippocampus into all `search()` calls

File: `backend/arceus/core/hippocampus/hippocampus.py`

Find every call to `self._vector_store.search(...)` and add `agent_id=self._agent_id`.

There should be calls in:
- `recall()` method
- `search()` method (also remove the dangling `agent_id` parameter from the public signature — this is M13)
- Any other method that calls `_vector_store.search()`

Also update `engines/reasoning_bank.py` — its `retrieve()` method calls `self._vector_store.search()`. Thread `self._agent_id` there too (add `agent_id` to `ReasoningBank.__init__` if not already present).

And update `engines/graph_store.py` if it calls `_vector_store.search()`.

## Sub-step 2D: Clean up L12 — remove unused `pattern_store` from `ReasoningBank`

File: `backend/arceus/core/hippocampus/engines/reasoning_bank.py`

`self._pattern_store` is assigned in `__init__` but never used in any method. Remove:
1. Remove `pattern_store` parameter from `__init__`
2. Remove `self._pattern_store = pattern_store`
3. Update all instantiation sites (in `hippocampus.py` and `factory.py` if applicable) to not pass `pattern_store`

## Sub-step 2E: Update all tests

Update test files that instantiate `InMemoryVectorStore` and call `search()` — they need to pass `agent_id`.

Search for `\.search(` in test files and add the `agent_id` parameter.

Add a NEW test to verify visibility-aware retrieval:

```python
async def test_search_visibility_isolation():
    """Verify tenant isolation: PRIVATE memories hidden from other agents,
    STARTUP_SHARED memories visible to all."""
    store = InMemoryVectorStore(dimensions=3)

    # Agent pm-1 stores a PRIVATE memory
    private_mem = MemoryUnit(
        id="private-1", agent_id="pm-1", content="PM's private note",
        container="startup:acme", visibility=MemoryVisibility.PRIVATE,
        embedding=[1.0, 0.0, 0.0],
    )
    # Agent pm-1 stores a STARTUP_SHARED memory
    shared_mem = MemoryUnit(
        id="shared-1", agent_id="pm-1", content="Enterprise needs security review",
        container="startup:acme", visibility=MemoryVisibility.STARTUP_SHARED,
        embedding=[1.0, 0.0, 0.0],
    )
    await store.upsert(private_mem)
    await store.upsert(shared_mem)

    # pm-1 sees both
    results = await store.search([1.0, 0.0, 0.0], "startup:acme", agent_id="pm-1")
    assert {r.id for r in results} == {"private-1", "shared-1"}

    # cto-1 sees only the shared memory
    results = await store.search([1.0, 0.0, 0.0], "startup:acme", agent_id="cto-1")
    assert {r.id for r in results} == {"shared-1"}
```

Run `uv run pytest tests/ -v` — all tests must pass.
```

---

## Prompt 3: Correctness + Hardening (R3, R5, R6, R7, R8, R9, R10, R11, R12)

```
You are fixing 10 medium-severity issues in the Hippocampus memory system. These are correctness, performance, and hardening fixes.

IMPORTANT RULES:
- All dataclasses are frozen — use `dataclasses.replace()`.
- Minimal changes only — fix each issue, nothing more.
- Add `import logging` and `logger = logging.getLogger(__name__)` where needed for warning logs.

## Fix R3: N+1 sequential async calls in `GraphStore.search`

File: `backend/arceus/core/hippocampus/engines/graph_store.py` (around line 99-102)

Currently loops sequentially over seed nodes calling `await self._backend.get_neighbors()` one at a time.

Fix: Replace the sequential loop with `asyncio.gather()`:
```python
import asyncio

neighbor_lists = await asyncio.gather(
    *[self._backend.get_neighbors(node.id, max_hops) for node in seed_nodes]
)
all_neighbors = [n for sublist in neighbor_lists for n in sublist]
```

Preserve the existing dedup logic that follows the loop.

## Fix R5: `PrimingMemory.update_state` key-errors on partial stored state

File: `backend/arceus/core/hippocampus/tiers/priming.py` (around line 23-27)

Currently uses direct dict key access: `current["confidence"]`. If stored state is missing keys (e.g., from an older schema version), this raises `KeyError`.

Fix: Change all direct key accesses to `.get()` with defaults:
- `current.get("confidence", 0.5)`
- `current.get("caution", 0.3)`
- `current.get("morale", 0.5)`
- `current.get("recent_events", [])`

These defaults match the ones in `get_current_state()`.

## Fix R6: `ProceduralMemory.get_matching_habits` silently drops malformed LLM responses

File: `backend/arceus/core/hippocampus/tiers/procedural.py`

Two issues:
1. If LLM returns unexpected response shape, silently returns empty list
2. If index is not an int (e.g., float `2.0`), silently skipped

Fix:
1. Add `import logging` and `logger = logging.getLogger(__name__)`
2. After extracting `items`, if not a list: `logger.warning("Unexpected LLM response shape in get_matching_habits: %s", type(items).__name__)`
3. Wrap index extraction in try/except: `idx = int(item.get("index", -1))` with `except (TypeError, ValueError)` logging a warning

## Fix R7: `MemoryExtractor.__init__` untyped `hippocampus` parameter

File: `backend/arceus/core/hippocampus/engines/extractor.py`

The `hippocampus` parameter has no type annotation (circular import avoidance).

Fix: Use `TYPE_CHECKING` guard (same pattern as `gc.py`):
```python
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from arceus.core.hippocampus.hippocampus import Hippocampus
```
Then annotate the `__init__` parameter as `hippocampus: Hippocampus`.

## Fix R8: O(N^2) consolidation blocks event loop

File: `backend/arceus/core/hippocampus/engines/reasoning_bank.py`

`consolidate()` loads all memories and does O(N^2) cosine comparisons. For 5000+ memories this blocks the event loop.

Fix: Add a cap at the top of `consolidate()`:
```python
MAX_CONSOLIDATION_MEMORIES = 500

all_memories = await self._vector_store.list_by_type(...)
if len(all_memories) > MAX_CONSOLIDATION_MEMORIES:
    logger.warning(
        "Consolidation capped at %d memories (total: %d). TODO: batch with numpy.",
        MAX_CONSOLIDATION_MEMORIES, len(all_memories),
    )
    # Sort by confidence descending to keep most important
    all_memories = sorted(all_memories, key=lambda m: m.confidence, reverse=True)[:MAX_CONSOLIDATION_MEMORIES]
```

## Fix R9: `_conversation_locks` dict leaks memory

File: `backend/arceus/core/hippocampus/tiers/working.py`

One `asyncio.Lock` per task_id is created and never removed. Long-running processes leak memory.

Fix: In `clear_task()`, after clearing the 3 keys, also clean up the lock:
```python
conv_key = f"{self._prefix}:conv:{task_id}"
self._conversation_locks.pop(conv_key, None)
```

## Fix R10: `_event_log` grows without bound

File: `backend/arceus/core/hippocampus/engines/promotion_engine.py`

`self._event_log: list[MemoryPromotionEvent]` is appended on every `run_promotions()` call, never trimmed.

Fix: Change to `collections.deque(maxlen=200)`:
```python
from collections import deque

# In __init__:
self._event_log: deque[MemoryPromotionEvent] = deque(maxlen=200)
```

Update `get_recent_promotions()` to work with deque (it already uses list slicing which works on deque).

## Fix R11: `_api_key` stored as plain `str` after `get_secret_value()`

File: `backend/arceus/core/hippocampus/backends/azure_openai_llm.py`

`self._api_key = api_key or settings.azure_openai_api_key.get_secret_value()` extracts the secret into a plain string visible in repr/crash dumps.

Fix: Keep as `SecretStr`:
```python
from pydantic import SecretStr

def __init__(self, ...):
    self._api_key: SecretStr = (
        SecretStr(api_key) if api_key
        else settings.azure_openai_api_key
    )

def _get_client(self):
    # Unwrap only at point of use
    api_key_value = (
        self._api_key.get_secret_value()
        if isinstance(self._api_key, SecretStr)
        else self._api_key
    )
```

Also update `has_azure_openai_credentials()` if it accesses `_api_key`.

## Fix R12: `classify()` silently falls back to `options[0]`

File: `backend/arceus/core/hippocampus/backends/azure_openai_llm.py`

When LLM response doesn't match any option, returns `options[0]` with no warning.

Fix: Add a warning log before the fallback return:
```python
logger.warning(
    "classify() could not match LLM response %r to options %r; defaulting to %r",
    normalized, options, options[0],
)
return options[0]
```

Run `uv run pytest tests/ -v` after all changes.
```

---

## Prompt 4: Dashboard — Wire Summary + Pattern Cards (Steps A1, A2)

```
You are implementing dashboard integration for the Hippocampus memory system. This prompt wires up the 3 empty summary fields and adds pattern card projections.

IMPORTANT RULES:
- All dataclasses are frozen — use `dataclasses.replace()`.
- Use `utc_now()` from `arceus.core.hippocampus.utils.time`.
- Follow existing code style.
- Do NOT modify types.py projection dataclasses — they already have the right fields.

## Task 4A: Add `get_top_patterns()` to PatternLearner

File: `backend/arceus/core/hippocampus/engines/pattern_learner.py`

Add a method that returns top patterns sorted by composite score:
```python
async def get_top_patterns(self, limit: int = 5) -> list[Pattern]:
    all_patterns = await self._store.list_all(agent_id=self._agent_id)
    active = [p for p in all_patterns if p.status is PatternStatus.ACTIVE]
    ranked = sorted(
        active,
        key=lambda p: p.success_rate * math.log(max(p.usage_count, 1) + 1),
        reverse=True,
    )
    return ranked[:limit]
```

## Task 4B: Add `get_recent()` to DynamicMemory

File: `backend/arceus/core/hippocampus/tiers/dynamic.py`

Add a method to get recent dynamic memories:
```python
async def get_recent(self, container: str, days: int = 7) -> list[MemoryUnit]:
    """Get dynamic memories created within the last N days."""
    from arceus.core.hippocampus.utils.time import utc_now
    cutoff = utc_now() - timedelta(days=days)
    all_dynamic = await self._vector_store.list_by_type(
        agent_id=self._agent_id,
        memory_type=MemoryType.DYNAMIC,
    )
    recent = [m for m in all_dynamic if m.container == container and m.created_at >= cutoff]
    return sorted(recent, key=lambda m: m.created_at, reverse=True)
```

Add `from datetime import timedelta` at the top.

## Task 4C: Wire `get_summary()` empty fields

File: `backend/arceus/core/hippocampus/hippocampus.py`

Update `get_summary()` to populate `top_patterns`, `recent_learnings`, `recent_promotions`.

The method currently returns `MemorySummaryProjection` with these fields empty. Add:

1. **`recent_promotions`**: Already have `self.promotion_engine` — call `get_recent_promotions(limit=5)` and format as `[f"{e.from_type}→{e.to_type}: {e.reason}" for e in events]`

2. **`recent_learnings`**: Need a `container` parameter. Add `container: str = ""` to `get_summary()`. Then:
   ```python
   recent_learnings = []
   if container and self.dynamic_memory is not None:
       recent = await self.dynamic_memory.get_recent(container, days=7)
       recent_learnings = [m.content for m in recent[:5]]
   ```

3. **`top_patterns`**: Call `self.pattern_learner.get_top_patterns(limit=5)` if available. Format as list of dicts with `description`, `success_rate`, `usage_count`.

Update `ArceusMemoryProjections.get_summary()` in `memory_projections.py` to pass `container` if available.

## Task 4D: Pattern cards projection

File: `backend/arceus/core/memory_projections.py`

Add a new method:
```python
async def get_pattern_cards(
    self, hippocampus: Hippocampus, limit: int = 10
) -> list[dict]:
    if hippocampus.pattern_learner is None:
        return []
    patterns = await hippocampus.pattern_learner.get_top_patterns(limit=limit)
    return [
        {
            "id": p.id,
            "description": p.description,
            "strategy": p.strategy,
            "domain": p.domain,
            "success_rate": round(p.success_rate, 3),
            "usage_count": p.usage_count,
            "status": p.status.value,
        }
        for p in patterns
    ]
```

## Task 4E: Write tests

New file: `backend/tests/adapters/test_dashboard_projections.py`

1. `test_get_summary_includes_recent_promotions` — create Hippocampus, run a promotion, verify `get_summary()` includes it
2. `test_get_summary_includes_top_patterns` — create patterns via PatternLearner, verify they appear in summary
3. `test_get_pattern_cards` — create patterns, call `get_pattern_cards()`, verify structure
4. `test_get_summary_empty_when_no_engines` — verify graceful handling when pattern_learner/promotion_engine are None

Run `uv run pytest tests/ -v` after all changes.
```

---

## Prompt 5: Dashboard — Graph Fixes + Explorer (Steps A3, A4, A5)

```
You are fixing graph visualization and adding memory explorer support for the Hippocampus dashboard.

IMPORTANT RULES:
- All dataclasses are frozen — use `dataclasses.replace()`.
- Minimal changes — fix only what's needed.
- Follow existing code style.

## Task 5A: G2 — Mirror MemoryUnit to GraphEntity nodes

Currently, `StaticMemory` and `DynamicMemory` store memories in the vector store but don't create corresponding `GraphEntity` nodes in the graph store. This means `get_version_history()` returns empty and graph visualization has no nodes.

Files to modify:
- `backend/arceus/core/hippocampus/tiers/static.py`
- `backend/arceus/core/hippocampus/tiers/dynamic.py`

In both `add()` methods, AFTER the vector store upsert, add graph node creation:

```python
from arceus.core.hippocampus.types import GraphEntity

# After: await self._vector_store.upsert(unit)
if self._graph_store is not None:
    entity = GraphEntity(
        id=unit.id,
        name=unit.content[:100],
        entity_type=unit.memory_type.value,
        properties={
            "container": unit.container,
            "agent_id": unit.agent_id,
            "confidence": str(unit.confidence),
        },
    )
    await self._graph_store._backend.upsert_node(entity)
```

Both tiers need access to `graph_store`. Check if they already have it via `self._graph_store`. If not, add it as an optional parameter to `__init__` (default `None`) and wire it in `hippocampus.py`'s `create()` method.

Also in `StaticMemory.update()`, after creating the UPDATES edge, make sure both the old and new `GraphEntity` nodes exist first.

## Task 5B: G4 — `create_edge` should check for missing nodes

File: `backend/arceus/core/hippocampus/backends/neo4j_graph.py`

In `create_edge()`, after the MATCH...CREATE query:
```python
records = [record async for record in result]
if not records:
    raise KeyError(
        f"Cannot create edge: source={source_id} or target={target_id} not found in graph"
    )
```

Also update `InMemoryGraphStoreBackend.create_edge()` in `in_memory_graph.py` to check that both source and target nodes exist:
```python
if source_id not in self._nodes or target_id not in self._nodes:
    raise KeyError(f"Cannot create edge: source={source_id} or target={target_id} not found")
```

## Task 5C: G5 — Preserve real edge types in `get_graph_view()`

File: `backend/arceus/core/memory_projections.py`

Currently `get_graph_view()` hardcodes all edges as `{"type": "related_to", "weight": 1.0}`.

Fix: Use the graph store backend's `get_edges()` to get actual relationships:
```python
# Replace the synthetic edge construction with:
neighbor_ids = {n.id for n in neighbors}
all_edges = await hippocampus.graph_store._backend.get_edges(center.id)
edges = [
    {
        "source": e.source_id,
        "target": e.target_id,
        "type": e.relation_type.value if hasattr(e.relation_type, 'value') else str(e.relation_type),
        "weight": e.weight,
    }
    for e in all_edges
    if e.target_id in neighbor_ids or e.source_id in neighbor_ids
]
```

Check what `get_edges()` returns in the protocol and adjust accordingly. It may return `GraphRelationship` objects — check `types.py` for the shape.

## Task 5D: Memory Explorer

File: `backend/arceus/core/memory_projections.py`

Add a new method for the memory explorer UI:
```python
async def get_memory_explorer(
    self,
    hippocampus: Hippocampus,
    container: str,
    memory_type: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Memory explorer data for dashboard browse/search UI."""
    from arceus.core.hippocampus.types import MemoryType

    results: list[MemoryUnit] = []
    if memory_type:
        mt = MemoryType(memory_type)
        results = await hippocampus._vector_store.list_by_type(
            agent_id=hippocampus._agent_id,
            memory_type=mt,
        )
        results = [m for m in results if m.container == container]
    else:
        for mt in [MemoryType.STATIC, MemoryType.DYNAMIC]:
            batch = await hippocampus._vector_store.list_by_type(
                agent_id=hippocampus._agent_id,
                memory_type=mt,
            )
            results.extend(m for m in batch if m.container == container)

    results = sorted(results, key=lambda m: m.created_at, reverse=True)[:limit]

    return [
        {
            "id": m.id,
            "content": m.content,
            "memory_type": m.memory_type.value,
            "confidence": round(m.confidence, 3),
            "created_at": m.created_at.isoformat(),
            "container": m.container,
            "source_type": m.source_type,
            "is_deleted": m.is_deleted,
        }
        for m in results
    ]
```

## Task 5E: Version History

File: `backend/arceus/core/memory_projections.py`

Add a method to get version chains:
```python
async def get_version_history(
    self,
    hippocampus: Hippocampus,
    memory_id: str,
) -> list[dict]:
    """Version chain for a specific memory (for dashboard detail view)."""
    history = await hippocampus.graph_store.get_version_history(memory_id)
    return [
        {
            "id": node.id,
            "name": node.name,
            "entity_type": node.entity_type,
            "created_at": node.properties.get("created_at", ""),
        }
        for node in history
    ]
```

## Task 5F: Write tests

Add to `backend/tests/adapters/test_memory_projections.py`:

1. `test_get_graph_view_preserves_edge_types` — create nodes + typed edge, verify `get_graph_view()` returns real edge type (not "related_to")
2. `test_get_memory_explorer` — add several memories, call explorer, verify structure and ordering
3. `test_get_memory_explorer_filtered_by_type` — filter by STATIC only, verify no DYNAMIC in results
4. `test_get_version_history` — create two memory versions with UPDATES edge, verify chain

Run `uv run pytest tests/ -v` after all changes.
```

---

## Prompt 6: Test Quality Fixes (RT1-RT9)

```
You are fixing 9 test quality issues found during holistic review of the Hippocampus test suite.

IMPORTANT RULES:
- Fix only what is described. Do not refactor surrounding code.
- Each fix should be minimal and surgical.
- Run tests after ALL changes to verify nothing breaks.

## RT1: `test_gc_runs_all_stages` asserts nothing meaningful

File: `backend/tests/hippocampus/unit/test_gc.py` (around line 29)

Every assertion is `>= 0`. On an empty store all return 0, so this verifies only that `run_gc()` doesn't raise.

Fix: Change all `>= 0` assertions to `== 0`:
```python
assert result.expired_removed == 0
assert result.decayed_removed == 0
assert result.deduped == 0
# ... etc for all fields
```

This documents that the empty-store baseline is exactly zero, not just non-negative.

## RT2: `FakeNeo4jSession` uses fragile `in` checks for query matching

File: `backend/tests/hippocampus/unit/test_backends.py` (around line 56)

The `run()` method matches queries with `"CREATE" in query` style checks. The `SET` branch can match unintended queries.

Fix: Use `query.startswith()` or more specific string matching:
```python
if query.strip().startswith("CREATE CONSTRAINT"):
    # schema creation
elif query.strip().startswith("CREATE (n:GraphEntity"):
    # node creation
elif "MATCH (n:GraphEntity" in query and "SET" in query:
    # node update
elif query.strip().startswith("MATCH (a:GraphEntity"):
    # edge or relationship query
# ... etc
```

Keep the fake working — just make the pattern matching more precise.

## RT3: Neo4j `cypher_query` history assertion encodes fake behavior

File: `backend/tests/hippocampus/unit/test_backends.py` (around line 516)

Add a comment above the assertion:
```python
# NOTE: This assertion verifies the InMemoryGraphStoreBackend's traversal behavior,
# which may differ from real Neo4j. The fake walks UPDATES edges forward and reverses.
# A contract test against real Neo4j should be added when graph becomes load-bearing (Phase 6+).
```

## RT4: Expired memory appears in `search` results without explanation

File: `backend/tests/hippocampus/unit/test_backends.py` (around line 253)

Add a comment above the assertion:
```python
# search() intentionally does NOT filter by expires_at.
# Only find_expired() filters for expiry — search returns all non-deleted memories.
# This is by design: expiry is handled by GC, not by search-time filtering.
```

## RT5: Missing `top_k` truncation test

File: `backend/tests/hippocampus/unit/test_backends.py`

Add a new test after the existing vector store tests:
```python
@pytest.mark.asyncio
async def test_in_memory_vector_store_top_k_truncation():
    store = InMemoryVectorStore()
    # Upsert 10 memories with varying embeddings
    for i in range(10):
        unit = MemoryUnit(
            agent_id="agent-1",
            content=f"memory-{i}",
            embedding=[float(i) / 10] * 32,
            memory_type=MemoryType.DYNAMIC,
            container="test",
        )
        await store.upsert(unit)

    query_emb = [0.5] * 32
    results = await store.search(
        embedding=query_emb, container="test", agent_id="agent-1", top_k=3
    )
    assert len(results) == 3
```

Adjust the embedding/agent_id parameter based on what Prompt 2 changed in the search protocol.

## RT6: No cross-scope dedup test

File: `backend/tests/adapters/test_memory_scope.py`

Add a test where the same content exists in two scope containers:
```python
@pytest.mark.asyncio
async def test_get_memories_deduplicates_across_scopes():
    # Setup hippocampus, store same content in both startup and employee containers
    # Call get_memories_for_agent
    # Assert that the duplicate is deduplicated (only appears once)
```

Check the existing `ArceusMemoryScope._deduplicate_by_priority()` logic to understand what the expected behavior is (it deduplicates by content, keeping the higher-priority one).

## RT7: Missing empty-store promotion test

File: `backend/tests/hippocampus/unit/test_promotion_engine.py`

Add:
```python
@pytest.mark.asyncio
async def test_run_promotions_with_empty_static_store():
    # Setup: dynamic memory with high usage, empty static store
    # Configure LLM double to return "CONTRADICTION" (shouldn't matter — no static to contradict)
    # Run promotions
    # Assert: promotion proceeds (no contradiction possible with empty static)
```

## RT8: `hippocampus_factory` is sync fixture returning async factory

File: `backend/tests/adapters/conftest.py`

Change from `@pytest.fixture` to `@pytest_asyncio.fixture`:
```python
import pytest_asyncio

@pytest_asyncio.fixture
async def hippocampus_factory():
    instances = []
    async def _create(agent_id: str, ...):
        h = await Hippocampus.create(...)
        instances.append(h)
        return h
    yield _create
    for h in instances:
        await h.close()
```

This ensures pytest-asyncio controls the teardown lifecycle.

## RT9: Edge type assertion says "related_to" for USES edge

File: `backend/tests/adapters/test_memory_projections.py` (around line 86)

Add a comment:
```python
# NOTE: The projection layer currently flattens all edge types to "related_to" (tracked as G5).
# When G5 is fixed (Prompt 5C), update this assertion to expect the actual RelationType value.
```

If Prompt 5C (G5 fix) was already applied, update the assertion to expect the actual edge type instead.

Run `uv run pytest tests/ -v` — all tests must pass.
```

---

## Execution Order

1. **Prompt 1** — Security fixes (R1, R2, R4) — must pass before anything else
2. **Prompt 2** — Tenant isolation (C2, D1, M13, L12) — protocol change, wide blast radius
3. **Prompt 3** — Hardening fixes (R3, R5-R12) — independent, can batch
4. **Prompt 4** — Dashboard summary + pattern cards (A1, A2) — feature work
5. **Prompt 5** — Graph fixes + explorer (A3, A4, A5) — depends on tenant isolation being done
6. **Prompt 6** — Test quality (RT1-RT9) — do last since earlier prompts may change test signatures

After all 6 prompts, run the full test suite and Hippocampus_app scenarios.
