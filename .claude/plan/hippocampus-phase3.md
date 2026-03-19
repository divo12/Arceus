# Hippocampus Phase 3: Delegation + Profiles + Projections + PromotionEngine

> **Spec reference**: hippocampus_design_v6.md lines 3086-3090
> **Branch**: `divo/hippocampus-phase3`
> **Exit criteria**: delegation safe, promotions fire with LLM guardrails, dashboard shows summaries

---

## Phase 0-2 Improvement Suggestions (Do First)

These are quick wins to clean up before starting Phase 3. Each is independent.

### ~~I1. KEEP `max_marginal_relevance()` in `utils/similarity.py`~~
- **Retracted**: ReasoningBank (Phase 4) will use this pure-embedding MMR utility for `retrieve()`. The inlined MMR in `hippocampus.py:recall()` adds tier/scope boosts on top — different purpose. Keep both.

### I2. Inline JSON wrappers, delete `utils/serialization.py`
- **File**: `backend/arceus/core/hippocampus/utils/serialization.py` (11 lines)
- **Action**: In `tiers/working.py`, replace `serialize()`/`deserialize()` with direct `json.dumps()`/`json.loads()`. Delete `serialization.py`.
- **Risk**: None — trivial wrappers used only in working.py

### ~~I3. KEEP `PatternStore` protocol~~
- **Retracted**: The v6 spec uses `PatternStore` as a dedicated protocol for `PatternLearner` and `ReasoningBank` in Phase 4 (spec lines 1612, 1876, 2454). It has `find_similar(embedding, threshold)` which is embedding-based lookup — distinct from the `RelationalStore` pattern methods.
- **Note**: The current `RelationalStore` protocol has overlapping pattern methods (`insert_pattern`, `update_pattern`, etc.) that were added eagerly in Phase 0. In Phase 4, reconcile: `PatternStore` wraps `RelationalStore` and adds `find_similar()` via embedding search. The `RelationalStore` pattern methods may become the underlying storage that `PatternStore` delegates to.

### I4. Add `PROMOTED_FROM` to `RelationType` enum (already done)
- Confirmed: `RelationType.PROMOTED_FROM = "promoted_from"` exists in `types.py:62`

### I5. `GraphStoreBackend.close()` missing from protocol
- **File**: `backend/arceus/core/hippocampus/backends/protocols.py`
- **Action**: Add `async def close(self) -> None: ...` to `GraphStoreBackend` protocol. Both `Neo4jGraphStoreBackend` and `InMemoryGraphStoreBackend` already implement it, but the protocol doesn't declare it.

---

## Phase 3 Implementation Plan

### Overview

Phase 3 adds 4 major components:

| Component | Location | Type |
|-----------|----------|------|
| **PromotionEngine** | `engines/promotion_engine.py` | Kernel |
| **DelegationMemoryManager** | `core/delegation_memory.py` | Arceus Adapter |
| **ArceusProfileEngine** | `core/profile_engine.py` | Arceus Adapter |
| **ArceusMemoryProjections** | `core/memory_projections.py` | Arceus Adapter |

Plus: 2 new prompts, new Hippocampus methods, VectorStore protocol additions, dashboard API stubs, and tests.

---

### Step 1: Add Phase 3 Prompts to `prompts.py`

**File**: `backend/arceus/core/hippocampus/prompts.py`

**Add these two prompts** (from spec sections 6.2 and 6.10):

```python
CONTRADICTION_CHECK_PROMPT = """
You are a contradiction detector. Given two memory statements, determine if they
SEMANTICALLY CONTRADICT each other.

Two statements contradict if they make incompatible claims about the same subject.
Similar statements that ADD detail or REFINE each other are NOT contradictions.

Memory A: {memory_a}
Memory B: {memory_b}

Examples of CONTRADICTIONS:
- "We use REST for APIs" vs "All APIs must use GraphQL"
- "Deploy on Friday" vs "Never deploy on Fridays"

Examples of NOT contradictions:
- "We use Stripe" vs "We use Stripe webhooks for payment notifications"
- "Auth uses JWT" vs "Auth uses JWT with 24h expiry"

Answer ONLY "CONTRADICTION" or "NO_CONTRADICTION".
""".strip()

PROMOTION_REASON_PROMPT = """
A memory has been automatically promoted from dynamic (temporary) to static (permanent).
Generate a clear, human-readable reason for the dashboard.

Memory content: {content}
Times accessed: {access_count}
Confidence score: {confidence}
Age: {age_days} days
Original source: {source_type}

Explain in one sentence why this memory deserves permanent status.
Do not use numbers — describe in natural language.
""".strip()
```

---

### Step 2: PromotionEngine (Kernel Component)

**New file**: `backend/arceus/core/hippocampus/engines/promotion_engine.py`

This is the core Phase 3 deliverable. Implements fully automatic memory promotion with LLM guardrails.

```python
"""
PromotionEngine — fully automatic memory promotion.

v6: LLM contradiction check (gpt-4o-mini) before promotion.
LLM-generated human-readable promotion reasons for dashboard.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    VectorStore,
)
from arceus.core.hippocampus.engines.graph_store import GraphStore
from arceus.core.hippocampus.prompts import (
    CONTRADICTION_CHECK_PROMPT,
    PROMOTION_REASON_PROMPT,
)
from arceus.core.hippocampus.types import (
    GraphRelationship,
    MemoryPromotionEvent,
    MemoryType,
    MemoryUnit,
    RelationType,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity
from arceus.core.hippocampus.utils.time import utc_now


class PromotionEngine:
    MAX_PROMOTIONS_PER_CYCLE = 5
    PROBATION_DAYS = 7
    STATIC_ACCESS_THRESHOLD = 10
    STATIC_CONFIDENCE_THRESHOLD = 0.8
    STATIC_AGE_DAYS_THRESHOLD = 14
    UNUSED_STATIC_DEMOTION_DAYS = 60

    def __init__(
        self,
        vector_store: VectorStore,
        graph_store: GraphStore,
        embedding_engine: EmbeddingEngine,
        llm_light: LLMEngine,
    ) -> None:
        self._vector_store = vector_store
        self._graph_store = graph_store
        self._embedding = embedding_engine
        self._llm = llm_light

    async def run_promotions(self, agent_id: str) -> list[MemoryPromotionEvent]:
        dynamic_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.DYNAMIC,
        )
        events: list[MemoryPromotionEvent] = []
        for mem in dynamic_memories:
            if len(events) >= self.MAX_PROMOTIONS_PER_CYCLE:
                break
            if self._qualifies_for_static(mem):
                has_contradiction = await self._check_contradiction(mem, agent_id)
                if has_contradiction:
                    continue
                event = await self._promote_to_static(mem, agent_id)
                if event:
                    events.append(event)
        return events

    def _qualifies_for_static(self, mem: MemoryUnit) -> bool:
        uses = mem.metadata.get("usage_count", 0)
        age_days = (utc_now() - mem.created_at).total_seconds() / 86400
        return (
            uses >= self.STATIC_ACCESS_THRESHOLD
            and mem.confidence >= self.STATIC_CONFIDENCE_THRESHOLD
            and age_days >= self.STATIC_AGE_DAYS_THRESHOLD
            and mem.promotion_status is None
        )

    async def _check_contradiction(self, mem: MemoryUnit, agent_id: str) -> bool:
        """Two-step: cosine pre-filter >0.80, then LLM verify."""
        static_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.STATIC,
        )
        for static_mem in static_memories:
            if mem.embedding and static_mem.embedding:
                sim = cosine_similarity(mem.embedding, static_mem.embedding)
                if sim > 0.80:
                    verdict = await self._llm.classify(
                        prompt=CONTRADICTION_CHECK_PROMPT.format(
                            memory_a=mem.content,
                            memory_b=static_mem.content,
                        ),
                        options=["CONTRADICTION", "NO_CONTRADICTION"],
                    )
                    if verdict.strip() == "CONTRADICTION":
                        return True
        return False

    async def _promote_to_static(
        self, mem: MemoryUnit, agent_id: str
    ) -> MemoryPromotionEvent | None:
        reason = await self._generate_promotion_reason(mem)
        probation_until = (utc_now() + timedelta(days=self.PROBATION_DAYS)).isoformat()

        promoted = MemoryUnit(
            agent_id=mem.agent_id,
            startup_id=mem.startup_id,
            content=mem.content,
            embedding=mem.embedding,
            memory_type=MemoryType.STATIC,
            confidence=mem.confidence,
            relevance_score=1.0,
            container=mem.container,
            visibility=mem.visibility,
            metadata={
                **mem.metadata,
                "promoted_from": mem.id,
                "probation_until": probation_until,
            },
            source_type=mem.source_type,
            source_id=mem.source_id,
            provenance=f"Auto-promoted from dynamic memory {mem.id}",
            promotion_status="promoted",
        )
        await self._vector_store.upsert(promoted)
        await self._vector_store.soft_delete(mem.id, reason="promoted_to_static")

        edge = GraphRelationship(
            source_id=promoted.id,
            target_id=mem.id,
            relation_type=RelationType.PROMOTED_FROM,
        )
        await self._graph_store.add_relationship(edge)

        return MemoryPromotionEvent(
            agent_id=agent_id,
            memory_id=promoted.id,
            from_type="dynamic",
            to_type="static",
            reason=reason,
            status="promoted",
        )

    async def _generate_promotion_reason(self, mem: MemoryUnit) -> str:
        return await self._llm.generate(
            prompt=PROMOTION_REASON_PROMPT.format(
                content=mem.content,
                access_count=mem.metadata.get("usage_count", 0),
                confidence=f"{mem.confidence:.2f}",
                age_days=f"{self._age_days(mem):.0f}",
                source_type=mem.source_type or "extraction",
            ),
        )

    async def demote(self, memory_id: str, reason: str) -> MemoryUnit | None:
        mem = await self._vector_store.get(memory_id)
        if not mem or mem.memory_type != MemoryType.STATIC:
            return None
        demoted = MemoryUnit(
            agent_id=mem.agent_id,
            startup_id=mem.startup_id,
            content=mem.content,
            embedding=mem.embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=mem.confidence * 0.8,
            relevance_score=0.5,
            container=mem.container,
            visibility=mem.visibility,
            metadata={**mem.metadata, "demoted_from": mem.id, "demotion_reason": reason},
            source_type=mem.source_type,
            source_id=mem.source_id,
            provenance=f"Demoted from static: {reason}",
        )
        await self._vector_store.upsert(demoted)
        await self._vector_store.soft_delete(mem.id, reason=f"demoted: {reason}")
        return demoted

    async def check_probation_demotions(self, agent_id: str) -> list[MemoryUnit]:
        static_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.STATIC,
        )
        demoted: list[MemoryUnit] = []
        now = utc_now()
        for mem in static_memories:
            probation_until = mem.metadata.get("probation_until")
            if not probation_until:
                continue
            from datetime import datetime
            probation_end = datetime.fromisoformat(probation_until)
            if now < probation_end:
                uses_since = mem.metadata.get("usage_count", 0)
                if uses_since == 0:
                    result = await self.demote(mem.id, "unused_during_probation")
                    if result:
                        demoted.append(result)
        return demoted

    async def check_unused_static_demotions(self, agent_id: str) -> list[MemoryUnit]:
        static_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.STATIC,
        )
        demoted: list[MemoryUnit] = []
        now = utc_now()
        for mem in static_memories:
            last_accessed = mem.metadata.get("last_accessed")
            if last_accessed:
                from datetime import datetime
                days_since = (now - datetime.fromisoformat(last_accessed)).total_seconds() / 86400
                if days_since >= self.UNUSED_STATIC_DEMOTION_DAYS:
                    result = await self.demote(mem.id, "unused_static_60d")
                    if result:
                        demoted.append(result)
        return demoted

    def _age_days(self, mem: MemoryUnit) -> float:
        return (utc_now() - mem.created_at).total_seconds() / 86400
```

**Key design notes for Codex**:
- Uses `utc_now()` from existing utils (not `datetime.utcnow()`) for consistency
- `GraphStore.add_relationship()` needs to exist — see Step 3
- `cosine_similarity` imported from existing utils
- `MemoryUnit` is frozen, so new instances are created (immutability preserved)
- Thresholds match spec exactly: access>=10, confidence>=0.8, age>=14d, cosine>0.80
- Rate limit: max 5 promotions per cycle

---

### Step 3: Wire PromotionEngine into Hippocampus

**File**: `backend/arceus/core/hippocampus/hippocampus.py`

#### 3a. Add import
```python
from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
```

#### 3b. Add `promotion_engine` to `__init__`
```python
def __init__(
    self,
    agent_id: str,
    config: HippocampusConfig,
    working_memory: WorkingMemory,
    static_memory: StaticMemory,
    dynamic_memory: DynamicMemory,
    graph_store: GraphStore,
    memory_extractor: MemoryExtractor | None,
    backends: HippocampusBackends,
    promotion_engine: PromotionEngine | None = None,  # NEW
) -> None:
    # ... existing ...
    self.promotion_engine = promotion_engine
```

#### 3c. Build PromotionEngine in `create()`
After building `graph_store` and before building `instance`:
```python
promotion_engine = PromotionEngine(
    vector_store=vector_store,
    graph_store=graph_store,
    embedding_engine=embedding_engine,
    llm_light=llm_light,
)
```
Pass `promotion_engine=promotion_engine` to `cls(...)`.

#### 3d. Add high-level API methods
```python
async def run_promotions(self) -> list[MemoryPromotionEvent]:
    if self.promotion_engine is None:
        return []
    return await self.promotion_engine.run_promotions(self._agent_id)

async def demote_memory(self, memory_id: str, reason: str) -> MemoryUnit | None:
    if self.promotion_engine is None:
        return None
    return await self.promotion_engine.demote(memory_id, reason)

async def get_summary(self) -> MemorySummaryProjection:
    """Generate memory summary projection for dashboard."""
    static_results = await self.static_memory.search("", "", top_k=100)
    dynamic_results = await self.dynamic_memory.search("", "", top_k=100)
    return MemorySummaryProjection(
        agent_id=self._agent_id,
        static_fact_count=len(static_results),
        dynamic_fact_count=len(dynamic_results),
    )
```

#### 3e. Update `__init__.py` exports
Add `PromotionEngine` to imports and `__all__`.

---

### Step 4: GraphStore — Add `add_relationship()` Method

**File**: `backend/arceus/core/hippocampus/engines/graph_store.py`

The existing `GraphStore` facade has `add_entity()` and `search()` but no method to create edges. Add:

```python
async def add_relationship(self, relationship: GraphRelationship) -> str:
    """Create an edge between two graph nodes."""
    return await self._backend.create_edge(relationship)
```

Import `GraphRelationship` from types if not already imported.

---

### Step 5: DelegationMemoryManager (Arceus Adapter)

**New file**: `backend/arceus/core/delegation_memory.py`

This adapter handles memory context injection during Employee-to-Employee delegation. It sits in the Arceus adapter layer (not kernel).

```python
"""
DelegationMemoryManager — Arceus adapter for Employee delegation memory flow.

Spec reference: hippocampus_design_v6.md section 8.3 / Flow B
Key principle: memories are COPIED, never referenced.
"""
from __future__ import annotations

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import ExtractedFact, MemoryType, MemoryUnit
from arceus.core.memory_scope import ArceusMemoryScope


class DelegationMemoryManager:
    """
    Handles memory context injection during Employee-to-Employee delegation.
    Knows about delegation authority and org hierarchy (Arceus-domain logic).
    """

    def __init__(self, scope: ArceusMemoryScope | None = None) -> None:
        self._scope = scope or ArceusMemoryScope()

    async def prepare_delegation_context(
        self,
        from_hippocampus: Hippocampus,
        to_hippocampus: Hippocampus,
        from_agent_id: str,
        to_agent_id: str,
        startup_id: str,
        task_id: str,
        task_description: str,
        top_k: int = 10,
    ) -> list[MemoryUnit]:
        """
        Query delegator's hippocampus for task-relevant memories,
        COPY them into the delegatee's task-scoped container.
        Returns the list of copied memories.
        """
        from_container = self._scope.employee_container(startup_id, from_agent_id)
        task_container = self._scope.task_container(startup_id, task_id)

        # Retrieve relevant memories from delegator
        relevant = await from_hippocampus.recall(
            query=task_description,
            container=from_container,
            top_k=top_k,
        )

        # Copy each memory into task-scoped container for delegatee
        copied: list[MemoryUnit] = []
        for mem in relevant:
            # Only copy MemoryUnit instances, not GraphEntity
            if not isinstance(mem, MemoryUnit):
                continue
            copy = MemoryUnit(
                agent_id=to_agent_id,
                startup_id=startup_id,
                content=mem.content,
                embedding=mem.embedding,
                memory_type=MemoryType.DYNAMIC,  # Delegated = always dynamic
                confidence=mem.confidence,
                container=task_container,
                visibility=mem.visibility,
                source_type="delegation",
                source_id=from_agent_id,
                provenance=f"Delegated from {from_agent_id}",
                metadata={"delegated_from": from_agent_id},
            )
            await to_hippocampus.remember(
                content=copy.content,
                container=task_container,
                memory_type=MemoryType.DYNAMIC,
            )
            copied.append(copy)

        return copied

    async def internalize_delegation_result(
        self,
        delegator_hippocampus: Hippocampus,
        delegator_agent_id: str,
        startup_id: str,
        learnings: list[str],
        quality: float,
    ) -> None:
        """
        After delegation completes, internalize verified learnings
        into the delegator's personal memory.
        Quality >= 0.6 = dynamic, >= 0.9 = static.
        """
        if quality < 0.6:
            return

        container = self._scope.employee_container(startup_id, delegator_agent_id)
        for learning in learnings:
            memory_type = MemoryType.STATIC if quality >= 0.9 else MemoryType.DYNAMIC
            await delegator_hippocampus.remember(
                content=learning,
                container=container,
                memory_type=memory_type,
            )
```

**Design notes for Codex**:
- Uses the existing `ArceusMemoryScope` from `memory_scope.py`
- Uses `hippocampus.recall()` for retrieval (which includes MMR)
- Copies via `hippocampus.remember()` — routes through proper tier logic
- Type-checks for `MemoryUnit` since `recall()` returns `list[MemoryUnit | GraphEntity]`
- `internalize_delegation_result` maps quality thresholds to memory types per spec

---

### Step 6: ArceusProfileEngine (Arceus Adapter)

**New file**: `backend/arceus/core/profile_engine.py`

```python
"""
ArceusProfileEngine — generates EmployeeProfile from Hippocampus tiers.

Spec reference: hippocampus_design_v6.md section 8.2
"""
from __future__ import annotations

from dataclasses import dataclass, field

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType
from arceus.core.memory_scope import ArceusMemoryScope


@dataclass(frozen=True)
class EmployeeProfile:
    role: str = ""
    core_knowledge: list = field(default_factory=list)
    current_context: list = field(default_factory=list)
    habits: list = field(default_factory=list)
    state: dict = field(default_factory=dict)


class ArceusProfileEngine:
    """
    Generates EmployeeProfile from Hippocampus tiers.
    Arceus-domain logic: knows about Employee roles.
    """

    def __init__(self, scope: ArceusMemoryScope | None = None) -> None:
        self._scope = scope or ArceusMemoryScope()

    async def generate_profile(
        self,
        hippocampus: Hippocampus,
        agent_id: str,
        startup_id: str,
        role: str,
    ) -> EmployeeProfile:
        container = self._scope.employee_container(startup_id, agent_id)

        # Static = core knowledge
        static_facts = await hippocampus.static_memory.search(
            query="",
            container=container,
            top_k=50,
        )
        # Dynamic = current context (recent)
        dynamic_facts = await hippocampus.dynamic_memory.search(
            query="",
            container=container,
            top_k=20,
        )

        return EmployeeProfile(
            role=role,
            core_knowledge=[m.content for m in static_facts],
            current_context=[m.content for m in dynamic_facts],
            habits=[],   # Phase 4: populated via ProceduralMemory
            state={},     # Phase 4: populated via PrimingMemory
        )
```

**Note**: `habits` and `state` are empty stubs — ProceduralMemory and PrimingMemory are Phase 4. The profile engine is wired now but will become fully functional in Phase 4.

---

### Step 7: ArceusMemoryProjections (Arceus Adapter)

**New file**: `backend/arceus/core/memory_projections.py`

```python
"""
ArceusMemoryProjections — dashboard-facing projection layer.

Spec reference: hippocampus_design_v6.md section 8.4
Generates typed views for the board UI without exposing raw memory.
"""
from __future__ import annotations

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import (
    GraphMemoryView,
    MemoryPromotionEvent,
    MemorySummaryProjection,
)


class ArceusMemoryProjections:
    """Dashboard-facing projection layer."""

    async def get_summary(
        self,
        hippocampus: Hippocampus,
    ) -> MemorySummaryProjection:
        return await hippocampus.get_summary()

    async def get_graph_view(
        self,
        hippocampus: Hippocampus,
        query: str,
        container: str,
        depth: int = 2,
    ) -> GraphMemoryView:
        """Generate graph neighborhood view for dashboard."""
        graph_results = await hippocampus.graph_store.search(
            query=query,
            container=container,
            top_k=1,
        )
        if not graph_results:
            return GraphMemoryView()

        center = graph_results[0]
        neighbors = await hippocampus.graph_store._backend.get_neighbors(
            center.id, max_hops=depth
        )

        edges = []
        for neighbor in neighbors:
            edges.append({
                "source": center.id,
                "target": neighbor.id,
                "type": "related_to",
                "weight": 1.0,
            })

        return GraphMemoryView(
            center_node=center,
            nodes=[center] + neighbors,
            edges=edges,
            depth=depth,
        )

    async def get_promotion_stream(
        self,
        hippocampus: Hippocampus,
    ) -> list[MemoryPromotionEvent]:
        return await hippocampus.run_promotions()
```

---

### Step 8: Tests

#### 8a. PromotionEngine Unit Tests

**New file**: `backend/tests/hippocampus/unit/test_promotion_engine.py`

Test these scenarios:
1. **`test_qualifies_for_static`** — memory with usage>=10, confidence>=0.8, age>=14d qualifies
2. **`test_does_not_qualify_low_usage`** — usage<10 does not qualify
3. **`test_does_not_qualify_low_confidence`** — confidence<0.8 does not qualify
4. **`test_does_not_qualify_young`** — age<14d does not qualify
5. **`test_does_not_qualify_already_promoted`** — promotion_status not None skips
6. **`test_run_promotions_happy_path`** — mock LLM returns NO_CONTRADICTION, mock generate returns reason string. Assert MemoryPromotionEvent created, old memory soft-deleted, new memory is STATIC.
7. **`test_run_promotions_contradiction_blocks`** — mock LLM returns CONTRADICTION. Assert no promotion event.
8. **`test_run_promotions_rate_limit`** — 10 qualifying memories, only 5 promoted (MAX_PROMOTIONS_PER_CYCLE)
9. **`test_demote_static_to_dynamic`** — demote() creates dynamic copy with 0.8x confidence
10. **`test_demote_non_static_returns_none`** — demote on dynamic memory returns None
11. **`test_probation_demotion`** — memory in probation with 0 usage gets demoted
12. **`test_unused_static_demotion_60d`** — static memory unused for 60d gets demoted
13. **`test_graph_edge_created_on_promotion`** — PROMOTED_FROM edge created between new and old

**Test fixtures**: Use `InMemoryVectorStore`, `InMemoryGraphStoreBackend`, `MockEmbeddingEngine`, `NoopLLMEngine` (override `classify`/`generate` returns via monkeypatch or subclass).

**Important**: The `NoopLLMEngine.classify()` and `NoopLLMEngine.generate()` must return usable values for tests. Check current noop implementation — may need to make `classify` return the first option and `generate` return a non-empty string.

#### 8b. DelegationMemoryManager Tests

**New file**: `backend/tests/adapters/test_delegation_memory.py`

1. **`test_prepare_delegation_context`** — add memories to from_hippocampus, call prepare, verify copies exist in to_hippocampus's task container
2. **`test_delegation_copies_not_references`** — verify copied memories have different IDs than originals
3. **`test_delegation_sets_source_type`** — verify source_type="delegation"
4. **`test_internalize_high_quality`** — quality>=0.9 creates static memories
5. **`test_internalize_medium_quality`** — quality>=0.6 creates dynamic memories
6. **`test_internalize_low_quality_skipped`** — quality<0.6 creates nothing

#### 8c. ArceusProfileEngine Tests

**New file**: `backend/tests/adapters/test_profile_engine.py`

1. **`test_generate_profile_with_facts`** — populate static+dynamic, verify profile fields
2. **`test_generate_profile_empty`** — empty hippocampus returns empty lists/dicts

#### 8d. ArceusMemoryProjections Tests

**New file**: `backend/tests/adapters/test_memory_projections.py`

1. **`test_get_summary`** — verify MemorySummaryProjection populated
2. **`test_get_graph_view`** — verify GraphMemoryView with center + neighbors
3. **`test_get_graph_view_empty`** — no graph results returns empty GraphMemoryView

---

### Step 9: Update `__init__.py` Exports

**File**: `backend/arceus/core/hippocampus/__init__.py`

Add to imports:
```python
from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
```

Add `"PromotionEngine"` to `__all__`.

---

### Step 10: NoopLLMEngine — Ensure `classify` and `generate` Work

**File**: `backend/arceus/core/hippocampus/backends/noop_llm.py`

Check that `classify()` returns the first option from the `options` list, and `generate()` returns a non-empty placeholder string. If not, update:

```python
async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
    return options[0] if options else ""

async def generate(self, prompt: str, **kwargs) -> str:
    return "Noop LLM response"
```

---

## File Changes Summary

| File | Operation | Description |
|------|-----------|-------------|
| `hippocampus/prompts.py` | Modify | Add CONTRADICTION_CHECK_PROMPT, PROMOTION_REASON_PROMPT |
| `hippocampus/engines/promotion_engine.py` | **Create** | Full PromotionEngine with promote/demote/probation |
| `hippocampus/engines/graph_store.py` | Modify | Add `add_relationship()` method |
| `hippocampus/hippocampus.py` | Modify | Add promotion_engine param, run_promotions(), demote_memory(), get_summary() |
| `hippocampus/__init__.py` | Modify | Add PromotionEngine to exports |
| `hippocampus/backends/noop_llm.py` | Modify | Ensure classify/generate return usable values |
| `core/delegation_memory.py` | **Create** | DelegationMemoryManager adapter |
| `core/profile_engine.py` | **Create** | ArceusProfileEngine + EmployeeProfile dataclass |
| `core/memory_projections.py` | **Create** | ArceusMemoryProjections adapter |
| `tests/hippocampus/unit/test_promotion_engine.py` | **Create** | 13 promotion engine tests |
| `tests/adapters/test_delegation_memory.py` | **Create** | 6 delegation tests |
| `tests/adapters/test_profile_engine.py` | **Create** | 2 profile tests |
| `tests/adapters/test_memory_projections.py` | **Create** | 3 projection tests |

## Cleanup (from Phase 0-2 improvements — do first)

| File | Operation | Description |
|------|-----------|-------------|
| `hippocampus/utils/serialization.py` | **Delete** | Inline json calls in working.py |
| `hippocampus/tiers/working.py` | Modify | Replace serialize/deserialize with json directly |
| `hippocampus/backends/protocols.py` | Modify | Add `close()` to GraphStoreBackend protocol |

## Execution Order

1. Phase 0-2 cleanup (I1-I5) — independent, can be done in any order
2. Step 1: Prompts
3. Step 10: NoopLLMEngine updates (needed for tests)
4. Step 4: GraphStore.add_relationship()
5. Step 2: PromotionEngine
6. Step 3: Wire into Hippocampus
7. Step 9: Update exports
8. Step 5: DelegationMemoryManager
9. Step 6: ArceusProfileEngine
10. Step 7: ArceusMemoryProjections
11. Step 8: All tests
12. Run full test suite: `uv run pytest backend/tests/ -v`

## Dashboard API Endpoints (Stubs Only for Phase 3)

Per spec, Phase 3 exit criteria includes "dashboard shows summaries." These are FastAPI route stubs — the actual dashboard integration is Phase 5, but the routes should be wired:

```
GET /api/startups/{startup_id}/agents/{agent_id}/memory         → ArceusMemoryProjections.get_summary()
GET /api/startups/{startup_id}/agents/{agent_id}/memory/graph   → ArceusMemoryProjections.get_graph_view()
GET /api/startups/{startup_id}/agents/{agent_id}/memory/history → (Phase 5 — stub 501)
```

If the FastAPI router structure doesn't exist yet, create stubs in `backend/arceus/api/memory.py` or defer to Phase 5 depending on the existing API layout.

---

## SESSION_ID (for /ccg:execute use)
- CODEX_SESSION: N/A
- GEMINI_SESSION: N/A
