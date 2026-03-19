# HippoCampus — Complete Design & Implementation Document

> **Version**: 6.0 | **Date**: 2026-03-19
> **Status**: Final with full implementation + complete LLM integration — ready for coding
> **Role**: Arceus Layer 4 memory subsystem (MVP-first, extractable later)
> **Lineage**: Claude v1.0 → Codex v2.0 → Consolidated v3.0 → Decisions v4.0 → Full impl v5.0 → This (v6.0 with intelligent LLM placement)

---

## Resolved Decisions

| Question | Decision | Rationale |
|----------|----------|-----------|
| **Graph DB** | **Neo4j** (dev + prod) | Kuzu is archived. Neo4j is the only viable option for both environments. Use Neo4j Community for dev, Neo4j Aura or self-hosted for prod. |
| **Extraction frequency** | **Per task + per meeting** | Not per conversation turn. Batch extraction reduces LLM cost and avoids noisy micro-facts. Extract once when a task completes and once when a meeting concludes. |
| **Promotion automation** | **Fully automatic** | Promotions are subconscious — like human memory consolidation. The system promotes automatically when thresholds are met. No agent interruption. |
| **MemSkill** | **Removed** | Skills will be covered separately as part of memory system evolution. |
| **Embedding model** | **all-MiniLM-L6-v2 (sentence-transformers)** | Free, fast, runs locally, good enough for MVP. 384 dimensions. |
| **Cross-startup memory** | **Post-MVP** | Deferred to Phase 6+. See Section 15 for the concept. |
| **Relational DB** | **SQLite** (MVP) | No PostgreSQL required for MVP. SQLite via aiosqlite for habits, priming, patterns, metadata. Migrate to PostgreSQL when scaling. |
| **Vector store** | **InMemoryVectorStore** (MVP) | No pgvector required for MVP. Numpy arrays + cosine similarity in-process. Migrate to pgvector when data exceeds memory. |
| **Working memory** | **DictCacheStore** (MVP) | No Redis required for MVP. In-process dict with TTL tracking. Migrate to Redis for multi-process/distributed. |

---

## v6 Change Summary (from v5)

v5 had only **4 LLM call sites**. v6 adds **7 new LLM touchpoints** and optimizes 1 existing one:

| # | Component | Change | Why |
|---|-----------|--------|-----|
| 1 | PromotionEngine | LLM contradiction verification | Cosine >0.8 alone can't distinguish similar-but-not-contradictory from actual contradictions |
| 2 | PromotionEngine | LLM promotion reason generation | Dashboard needs human-readable explanations, not formatted numbers |
| 3 | ReasoningBank | LLM contradiction verification in consolidate() | Same as #1 but during periodic cleanup |
| 4 | ReasoningBank | LLM memory merge synthesis | Keeping one memory and discarding the other loses nuance |
| 5 | PatternLearner | LLM habit naming | `pattern.description[:100]` truncation is unacceptable for dashboard display |
| 6 | PatternLearner | LLM pattern merge synthesis | Same as #4 but for patterns |
| 7 | PrimingMemory | LLM disposition generation | 3-branch if/else produces flat, generic prompts |
| 8 | ProceduralMemory | LLM-only trigger eval (reverted from embed-first) | LLM evaluates all triggers in single batch call — simpler, accurate |
| 9 | MemoryExtractor | LLM relationship classification | Hardcoded dict misses synonyms and novel relationship types |

**Total LLM call sites in v6: 10** (4 existing + 6 new)

### LLM Cost Discipline

Every new LLM call follows one rule: **use the cheapest model that produces correct output**.

| Call Type | Model | Why This Tier |
|-----------|-------|---------------|
| Fact extraction | gpt-4o | Needs nuanced understanding of conversation context |
| Action decision (ADD/UPDATE/DELETE) | gpt-4o | Needs to compare semantics of new vs existing memories |
| Trajectory analysis | gpt-4o | Qualitative reasoning about execution quality |
| **Contradiction verification** | **gpt-4o-mini** | Binary yes/no classification — cheap model sufficient |
| **Memory merge synthesis** | **gpt-4o-mini** | Short text generation from two inputs |
| **Habit naming** | **gpt-4o-mini** | Short creative text — gpt-4o-mini sufficient |
| **Promotion reasoning** | **gpt-4o-mini** | Short explanatory text for dashboard |
| **Priming prompt generation** | **gpt-4o-mini** | Template-guided text generation |
| **Relationship classification** | **gpt-4o-mini** | Classification into fixed enum — trivial for any model |
| **Trigger evaluation (top-N)** | **gpt-4o-mini** | Binary relevance check on pre-filtered candidates |

New config fields:
```python
# In HippocampusConfig
lightweight_model: str = "gpt-4o-mini"  # For classification, naming, short generation
```

---

## 1. Position

### Repo: Inside Arceus for MVP

HippoCampus lives in `packages/core/hippocampus/` with a clean kernel/adapter split. Extraction to standalone package deferred until:
1. Scope container format is stable
2. Retrieval APIs are stable
3. At least one non-Arceus consumer exists

### Architecture

```
Board / Dashboard
    |
    v
Arceus Orchestrator
    |
    +-- Agent Runtime ──────────┐
    +-- Task Engine ────────────┤  UPSTREAM
    +-- A2A / Delegation ───────┤  (feeds memory)
    +-- Meeting Engine ─────────┤
    +-- Audit / Finance ────────┘
    |
    v
HippoCampus Adapter Layer (Arceus-specific)
    - memory_scope.py
    - delegation_memory.py
    - profile_engine.py
    - memory_projections.py
    |
    v
HippoCampus Kernel (domain-agnostic, extractable)
    - tiers/       (working, static, dynamic, procedural, priming)
    - engines/     (extractor, reasoning_bank, pattern_learner, graph, gc, promotion)
    - backends/    (in-memory vector, Neo4j, dict cache, SQLite)
    |
    v
Storage Layer
    - SQLite                    (relational — habits, priming, patterns, metadata)
    - In-memory vector store    (cosine similarity search, no external DB)
    - Neo4j                     (graph relationships)
    - Dict cache                (working memory — in-process, no Redis)
```

---

## 2. Core Operating Flows

### Flow A: Task Execution Memory Loop

```
1. Agent receives task

2. ReasoningBank.retrieve(query, containers=[startup, employee, task], top_k=3)
   → MMR: lambda=0.7 * relevance + 0.3 * diversity
   → Static boosted 1.5x, task-scoped boosted 1.3x

3. Relevant memories loaded into WorkingMemory (dict cache, TTL=2h)

4. Matching habits retrieved via ProceduralMemory.get_matching_habits(task_context)
   → [LLM-gpt4o-mini] evaluates all active triggers in single batch call
   → Matching habits injected into agent system prompt

5. [LLM-gpt4o-mini] PrimingMemory.generate_priming_prompt()
   → LLM synthesizes recent events into nuanced disposition prompt
   → Disposition injected into agent system prompt

6. Agent executes → trace steps captured as Trajectory

7. ON TASK COMPLETION (not per turn):
   MemoryExtractor.extract(trajectory, mode="agent")
   → [LLM-gpt4o] extracts structured facts from messages
   → For each fact: search existing memories (top 5 by embedding)
   → [LLM-gpt4o] decides action: ADD / UPDATE / DELETE / NONE
   → Execute actions (route to correct tier)

8. Facts routed to correct tier:
   - permanent truth → StaticMemory
   - temporary context → DynamicMemory
   - behavioral rule → ProceduralMemory (Habit)
   - emotional signal → PrimingMemory

9. GraphStore (Neo4j): entities + relationships added/merged
   → Embedding similarity threshold 0.7 for node matching
   → [LLM-gpt4o-mini] classifies relationship type (not hardcoded dict)

10. PatternLearner checks for pattern/habit emergence
    → If habit forms: [LLM-gpt4o-mini] generates trigger + action description

11. PrimingMemory EMA update (lr=0.15) based on task outcome

12. WorkingMemory.clear_task(task_id)
```

### Flow B: Delegation Memory Loop

```
1. CEO delegates "Build auth system" to CTO
2. DelegationMemoryManager queries CEO's HippoCampus:
   ReasoningBank.retrieve("auth system", container=ceo_scope, top_k=10)
3. Arceus adapter filters by org policy (only shareable memories)
4. Memories COPIED into task-scoped container (never reference)
5. CTO executes with injected context (Flow A runs for CTO)
6. On task completion: CTO's extractor processes outcome
7. CEO auto-internalizes CTO's verified learnings into personal or startup-shared memory
```

### Flow C: Meeting Memory Loop

```
1. Meeting transcript captured

2. ON MEETING COMPLETION:
   MemoryExtractor.extract(transcript, mode="meeting")
   → [LLM-gpt4o] extracts decisions, blockers, commitments, learnings, morale signals
   → [LLM-gpt4o] decides ADD/UPDATE/DELETE/NONE for each fact
   → [LLM-gpt4o-mini] classifies relationship types for graph edges

3. Each fact assigned target scope + visibility:
   - startup shared (decision → STARTUP_SHARED visibility)
   - employee private (personal learning → PRIVATE)
   - task-specific (blocker → TASK_SCOPED)

4. ProfileEngine updates relevant employee summaries

5. MemoryPromotionEvent emitted to Dashboard WebSocket (if any promotions triggered)
```

### Flow D: Board Visibility Loop

```
1. Raw memories never exposed directly
2. Projection layer generates typed views:
   - MemorySummaryProjection
   - GraphMemoryView (Neo4j subgraph slice)
   - Version history (UPDATES chain)
   - Pattern cards (with LLM-generated names)
   - MemoryPromotionEvent stream (with LLM-generated reasons)
3. Dashboard APIs:
   GET /api/startups/{id}/agents/{id}/memory         → summary
   GET /api/startups/{id}/agents/{id}/memory/graph    → graph view
   GET /api/startups/{id}/agents/{id}/memory/history  → version chains
```

### Flow E: GC / Consolidation Cycle (Every 6 Hours)

```
1. Expire temporal facts past expiry date

2. Decay-score dynamic memories, remove below 0.1 threshold
   BUT: skip promotion candidates (don't delete what should be promoted)

3. ReasoningBank.consolidate():
   a. Dedup: >95% cosine similarity → keep highest confidence
   b. Contradiction detection:
      → Cosine >0.80 candidates identified
      → [LLM-gpt4o-mini] verifies actual semantic contradiction (yes/no)
      → Confirmed contradictions flagged, lower-quality version soft-deleted
   c. Merge: >90% similarity in same domain
      → [LLM-gpt4o-mini] synthesizes merged text from both memories
   d. Prune: >30 days + <5 uses + confidence <0.3 (skip promotion candidates)

4. PatternLearner.consolidate_patterns():
   a. Merge >90% similar patterns in same domain
      → [LLM-gpt4o-mini] synthesizes merged description
   b. Prune below 20th percentile composite score

5. PromotionEngine.run_promotions():
   a. Scan dynamic memories for promotion thresholds
   b. For each candidate:
      → [LLM-gpt4o-mini] verifies no semantic contradiction with existing static memories
      → Create new static memory (immutable)
      → [LLM-gpt4o-mini] generates human-readable promotion reason for dashboard
      → Mark source as promoted
      → Create PROMOTED_FROM edge in Neo4j
      → Emit MemoryPromotionEvent
   c. Rate limit: max 5 promotions per cycle per agent

6. PromotionEngine.check_probation_demotions():
   → Demote if unused during 7-day probation window

7. PromotionEngine.check_unused_static_demotions():
   → Demote if never accessed for 60+ days
```

---

## 3. Data Model

### 3.1 Core Enums

```python
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional, Protocol


class MemoryType(Enum):
    WORKING = "working"
    STATIC = "static"
    DYNAMIC = "dynamic"
    PROCEDURAL = "procedural"
    PRIMING = "priming"


class MemoryAction(Enum):
    ADD = "add"
    UPDATE = "update"
    DELETE = "delete"
    NONE = "none"


class MemoryVisibility(Enum):
    PRIVATE = "private"
    TASK_SCOPED = "task_scoped"
    STARTUP_SHARED = "shared"
    BOARD_VISIBLE = "board"


class PatternStatus(Enum):
    ACTIVE = "active"
    MERGED = "merged"
    PRUNED = "pruned"
    ARCHIVED = "archived"


class HabitFormation(Enum):
    AUTO = "auto"                # From patterns (usage>10, success>0.8)
    EXPLICIT = "explicit"        # LLM-extracted procedural memory


class ExtractionMode(Enum):
    AGENT = "agent"
    SUB_AGENT = "sub_agent"
    CONVERSATION = "conversation"
    MEETING = "meeting"


class RelationType(Enum):
    UPDATES = "updates"
    EXTENDS = "extends"
    DERIVES = "derives"
    USES = "uses"
    OWNS = "owns"
    DEPENDS_ON = "depends_on"
    RELATED_TO = "related_to"
    PART_OF = "part_of"
    DECIDED_IN = "decided_in"
    PROMOTED_FROM = "promoted_from"
```

### 3.2 MemoryUnit

```python
@dataclass(frozen=True)
class MemoryUnit:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    startup_id: str = ""
    content: str = ""
    embedding: Optional[list[float]] = None       # all-MiniLM-L6-v2 (sentence-transformers), 384d
    memory_type: MemoryType = MemoryType.DYNAMIC
    confidence: float = 0.0                        # 0.0 - 1.0
    relevance_score: float = 1.0                   # Decay-adjusted
    container: str = ""                            # Scope tag
    visibility: MemoryVisibility = MemoryVisibility.PRIVATE
    metadata: dict = field(default_factory=dict)
    source_type: str = ""                          # "task", "meeting", "delegation", "board_action"
    source_id: str = ""
    provenance: str = ""                           # Why this memory exists
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    expires_at: Optional[datetime] = None          # Temporal facts
    version: int = 1
    previous_version_id: Optional[str] = None
    promotion_status: Optional[str] = None         # "promoted", None (automatic — no pending state)
```

### 3.3 Pattern

```python
@dataclass(frozen=True)
class Pattern:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    description: str = ""
    strategy: str = ""                             # Extracted action sequence
    embedding: Optional[list[float]] = None
    usage_count: int = 0
    success_rate: float = 0.0                      # EMA-smoothed
    formed_from: tuple[str, ...] = ()              # Source trajectory IDs
    cluster_id: Optional[str] = None
    status: PatternStatus = PatternStatus.ACTIVE
    domain: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
```

### 3.4 Habit

```python
@dataclass(frozen=True)
class Habit:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    trigger_condition: str = ""                    # Natural language
    action: str = ""                               # Injected into prompt
    confidence: float = 0.0
    usage_count: int = 0
    formed_from_id: str = ""                       # Pattern ID
    formation_mode: HabitFormation = HabitFormation.AUTO
    is_active: bool = True
    created_at: datetime = field(default_factory=datetime.utcnow)
```

### 3.6 Trajectory

```python
@dataclass(frozen=True)
class TrajectoryStep:
    step_index: int = 0
    action: str = ""
    observation: str = ""
    reward: float = 0.0
    embedding: Optional[list[float]] = None
    timestamp: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class Trajectory:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    task_id: str = ""
    steps: tuple[TrajectoryStep, ...] = ()
    outcome: str = ""                              # "success" | "failure" | "partial"
    quality: float = 0.0
    created_at: datetime = field(default_factory=datetime.utcnow)
```

### 3.7 Graph Entities

```python
@dataclass(frozen=True)
class GraphEntity:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    entity_type: str = ""                          # "person", "technology", "concept", "task", "decision"
    embedding: Optional[list[float]] = None
    mention_count: int = 1
    container: str = ""
    metadata: dict = field(default_factory=dict)
    is_latest: bool = True                         # For version chains
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class GraphRelationship:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    source_id: str = ""
    target_id: str = ""
    relation_type: RelationType = RelationType.RELATED_TO
    weight: float = 1.0
    metadata: dict = field(default_factory=dict)
    created_at: datetime = field(default_factory=datetime.utcnow)
```

### 3.8 Extraction Results

```python
@dataclass(frozen=True)
class ExtractedFact:
    text: str = ""
    memory_type: MemoryType = MemoryType.DYNAMIC
    confidence: float = 0.0
    is_permanent: bool = False                     # → static memory
    is_procedural: bool = False                    # → procedural memory (habit)
    is_temporal: bool = False                      # Has explicit expiry
    expires_at: Optional[datetime] = None
    entities: tuple[str, ...] = ()                 # Extracted entity names
    relationships: tuple[tuple[str, str, str], ...] = ()  # (source, relation, target)


@dataclass(frozen=True)
class ExtractionResult:
    facts: tuple[ExtractedFact, ...] = ()
    actions: tuple[tuple[MemoryAction, str, str], ...] = ()  # (action, target_id, reason)
```

### 3.9 Reasoning Results

```python
@dataclass(frozen=True)
class RetrievalResult:
    memory: MemoryUnit
    relevance: float
    diversity: float


@dataclass(frozen=True)
class TrajectoryVerdict:
    trajectory_id: str = ""
    quality: float = 0.0
    is_successful: bool = False
    strengths: list = field(default_factory=list)
    weaknesses: list = field(default_factory=list)
    suggestions: list = field(default_factory=list)
    confidence: float = 0.0


@dataclass(frozen=True)
class DistilledMemory:
    agent_id: str = ""
    trajectory_id: str = ""
    strategy: str = ""
    embedding: list = field(default_factory=list)
    quality: float = 0.0
    learnings: list = field(default_factory=list)

    def to_memory_unit(self) -> MemoryUnit:
        return MemoryUnit(
            agent_id=self.agent_id,
            content=self.strategy,
            embedding=self.embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=self.quality,
            source_type="distillation",
            source_id=self.trajectory_id,
            provenance=f"Distilled from trajectory {self.trajectory_id}",
        )


@dataclass(frozen=True)
class ConsolidationResult:
    deduped: int = 0
    contradictions_found: int = 0
    contradictions_resolved: int = 0
    pruned: int = 0
    merged: int = 0


@dataclass(frozen=True)
class GCResult:
    expired_removed: int = 0
    decayed_removed: int = 0
    deduped: int = 0
    pruned: int = 0
    merged: int = 0
    patterns_merged: int = 0
    patterns_pruned: int = 0
    promotions_fired: int = 0
```

### 3.10 Projection Models

```python
@dataclass(frozen=True)
class MemorySummaryProjection:
    agent_id: str = ""
    static_fact_count: int = 0
    dynamic_fact_count: int = 0
    active_habits: list = field(default_factory=list)
    top_patterns: list = field(default_factory=list)
    current_state: dict = field(default_factory=dict)
    recent_learnings: list = field(default_factory=list)
    recent_promotions: list = field(default_factory=list)
    generated_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class GraphMemoryView:
    center_node: Optional[GraphEntity] = None
    nodes: list = field(default_factory=list)
    edges: list = field(default_factory=list)      # {source, target, type, weight}
    depth: int = 2                                 # Max 2 hops


@dataclass(frozen=True)
class MemoryPromotionEvent:
    agent_id: str = ""
    memory_id: str = ""
    from_type: str = ""
    to_type: str = ""
    reason: str = ""                               # LLM-generated human-readable reason (v6)
    status: str = "promoted"                       # Always "promoted" (automatic)
    timestamp: datetime = field(default_factory=datetime.utcnow)
```

---

## 4. Retrieval and Promotion Rules

### Retrieval

```python
TIER_BOOST = {
    MemoryType.STATIC: 1.5,
    MemoryType.DYNAMIC: 1.0,
    MemoryType.PROCEDURAL: 1.2,
}

SCOPE_BOOST = {
    "task": 1.3,
    "employee": 1.0,
    "startup": 0.8,
}

# Final score
score = tier_boost * scope_boost * cosine_sim(query, memory) * decay_factor * mmr_diversity
```

**MMR**: lambda=0.7, over-fetch 3x, prevents near-duplicate recall.

**Decay** (dynamic only): `decay = 0.5 ^ (age_days / 30.0)`, threshold 0.1.

### Promotion Rules (Fully Automatic)

Promotions are **subconscious** — like human memory consolidation. You don't decide to move a fact from short-term to long-term memory; your hippocampus does it while you sleep. Same principle here.

The system promotes automatically when signal thresholds are met. No agent interruption, no approval queue, no prompt injection asking "should I remember this?" The agent's brain (HippoCampus) handles it silently.

#### Why Automatic

1. **Biological fidelity**: Human memory consolidation is unconscious.
2. **No interruption tax**: Agent-permitted promotions would inject approval prompts into task execution, burning LLM tokens and breaking flow.
3. **Signal is sufficient**: If a fact has been accessed 10+ times over 14+ days with 0.8+ confidence, the statistical signal is strong enough.
4. **Board retains override**: The dashboard shows all promotions. The board (user) can demote or delete any promoted memory.

#### Promotion Triggers

v6 change: **contradiction check now uses LLM verification** instead of cosine-only heuristic.

| From | To | Automatic Trigger | Signal Logic |
|------|----|-------------------|-------------|
| Dynamic → Static | Repeated durable truth | `access_count >= 10 AND confidence >= 0.8 AND age_days >= 14 AND [LLM-gpt4o-mini] no contradiction` | High repetition + high confidence + survived decay + LLM-verified no contradiction = durable truth |
| Dynamic → Procedural | Repeatable behavior | `LLM classifies as procedural during extraction` OR `pattern.usage >= 10 AND pattern.success >= 0.8` | LLM recognizes behavioral pattern, or statistical evidence |
| Dynamic → Pattern | Strategic insight | `PatternLearner.extract_pattern() succeeds (quality >= 0.5)` | Trajectory analysis finds a reusable strategy |
| Pattern → Habit | Automatic routine | `usage >= 10 AND success_rate >= 0.8`, [LLM-gpt4o-mini] generates trigger+action | Very frequent application with very high success |
| Sub-agent → Employee | Verified output | `parent_verifier.quality >= 0.6` | Parent verification is the quality gate |
| Employee → Startup shared | Org-relevant decision | `source_type == "meeting" AND visibility == STARTUP_SHARED` OR `confidence >= 0.9 AND access_count >= 20` | Meeting decisions are inherently shared |

#### Safety Mechanisms (replacing approval with guardrails)

| Guardrail | What It Does |
|-----------|-------------|
| **Threshold stacking** | Multiple independent signals must align (access + confidence + age). No single metric can force promotion. |
| **LLM contradiction check** | Before promoting to static, cosine pre-filter (>0.80) then [LLM-gpt4o-mini] verifies actual semantic contradiction. Prevents false positives like "We use Stripe" vs "We use Stripe webhooks". If found, don't promote — flag for consolidation instead. |
| **Rate limiting** | Max 5 promotions per consolidation cycle per agent. Prevents memory avalanche from a single productive session. |
| **Demotion path** | Any promoted memory can be demoted by (a) board override, (b) contradiction detected later, (c) low usage after promotion (if a "static" fact is never accessed for 60 days, demote back to dynamic). |
| **Soft promotion window** | Newly promoted static memories get a 7-day "probation" period. During probation, they can be auto-demoted if contradicted or unused. After probation, they're fully stable. |
| **Board override** | Dashboard shows all recent promotions. Board can click "Demote" or "Delete" on any memory. |

---

## 5. Backend Protocols (Pluggable)

### 5.1 Vector Store Protocol

```python
class VectorStore(Protocol):
    """Backend-agnostic vector storage."""
    async def upsert(self, unit: MemoryUnit) -> None: ...
    async def get(self, memory_id: str) -> Optional[MemoryUnit]: ...
    async def search(
        self, embedding: list[float], container: str,
        memory_types: list[MemoryType] = None, top_k: int = 10,
    ) -> list[MemoryUnit]: ...
    async def list_by_type(
        self, agent_id: str, memory_type: MemoryType = None,
        memory_types: list[MemoryType] = None, container: str = None,
        created_after: datetime = None,
    ) -> list[MemoryUnit]: ...
    async def soft_delete(self, memory_id: str, reason: str = "") -> None: ...
    async def find_expired(
        self, agent_id: str, memory_type: MemoryType, before: datetime,
    ) -> list[MemoryUnit]: ...
```

### 5.2 Graph Store Backend Protocol

```python
class GraphStoreBackend(Protocol):
    """Backend contract for graph storage."""
    async def create_node(self, entity: GraphEntity) -> str: ...
    async def get_node(self, node_id: str) -> Optional[GraphEntity]: ...
    async def update_node(self, node_id: str, updates: dict) -> None: ...
    async def create_edge(self, rel: GraphRelationship) -> str: ...
    async def vector_search(self, embedding: list[float], container: str,
                            top_k: int) -> list[GraphEntity]: ...
    async def get_neighbors(self, node_id: str, max_hops: int,
                            relation_types: Optional[list[str]] = None) -> list[GraphEntity]: ...
    async def cypher_query(self, query: str, params: dict) -> list[dict]: ...
```

### 5.3 Working Memory Backend Protocol

```python
class WorkingMemoryBackend(Protocol):
    """Backend contract for working memory storage."""
    async def get(self, key: str) -> Optional[str]: ...
    async def set(self, key: str, value: str, ttl_seconds: int = 3600): ...
    async def delete(self, key: str): ...
    async def get_all(self, prefix: str) -> dict[str, str]: ...
    async def clear(self, prefix: str): ...
```

### 5.4 Relational Store Protocol

```python
class RelationalStore(Protocol):
    """Backend for relational data (habits, priming, patterns)."""
    async def insert_habit(self, habit: Habit) -> None: ...
    async def get_habit(self, habit_id: str) -> Habit: ...
    async def list_habits(self, agent_id: str, is_active: bool = True) -> list[Habit]: ...
    async def update_habit(self, habit: Habit) -> None: ...
    async def set_priming_state(self, agent_id: str, state: dict) -> None: ...
    async def get_priming_state(self, agent_id: str) -> Optional[dict]: ...
```

### 5.5 Pattern Store Protocol

```python
class PatternStore(Protocol):
    """Backend for pattern storage."""
    async def insert(self, pattern: Pattern) -> None: ...
    async def update(self, pattern: Pattern) -> None: ...
    async def find_similar(self, embedding: list[float], threshold: float) -> Optional[Pattern]: ...
    async def list_all(self, agent_id: str) -> list[Pattern]: ...
    async def update_status(self, pattern_id: str, status: PatternStatus) -> None: ...
```

### 5.6 LLM Engine Protocol

```python
class LLMEngine(Protocol):
    """Backend-agnostic LLM for extraction and reasoning."""
    async def extract_structured(
        self, prompt: str, messages: list[dict], output_schema: type,
    ) -> list: ...
    async def decide(self, prompt: str, **kwargs) -> dict: ...
    async def analyze(self, prompt: str, **kwargs) -> dict: ...
    async def generate(self, prompt: str, **kwargs) -> str: ...
    async def classify(self, prompt: str, options: list[str], **kwargs) -> str: ...
```

Note: `generate()` and `classify()` are new in v6 to support the lightweight LLM calls. Implementations route `generate`/`classify` to the lightweight model (gpt-4o-mini) while `extract_structured`/`decide`/`analyze` use the full model (gpt-4o).

### 5.7 Embedding Engine Protocol

```python
class EmbeddingEngine(Protocol):
    """Backend-agnostic embedding generation.

    Design note — sentence-transformers models are synchronous and CPU-bound.
    The concrete implementation (SentenceTransformerEmbeddingEngine) MUST wrap
    the underlying `model.encode()` call with `asyncio.to_thread()` so the
    event loop is never blocked during embedding computation.
    """
    async def embed(self, text: str) -> list[float]: ...
    async def embed_batch(self, texts: list[str]) -> list[list[float]]: ...
```

### 5.8 MVP Backend Implementations

| Backend | Class | Best For |
|---------|-------|----------|
| In-memory | `InMemoryVectorStore` | MVP — numpy arrays + cosine similarity, no external DB |
| Neo4j | `Neo4jGraphStore` | MVP — graph relationships |
| Dict | `DictCacheStore` | MVP — working memory (in-process, no Redis) |
| SQLite | `SQLiteRelationalStore` | MVP — habits, priming, patterns, metadata |

---

## 6. Prompts

All LLM prompts in one place. Organized by component.

### 6.1 Extraction Prompts (GPT-4o — existing from v5)

```python
AGENT_EXTRACTION_PROMPT = """
You are a memory extraction system. Analyze the following agent interaction
and extract facts worth remembering.

For each fact, classify:
- type: "static" (permanent truth), "dynamic" (temporary context),
        "procedural" (behavioral rule/habit), "priming" (emotional signal)
- confidence: 0.0 to 1.0
- is_temporal: true if the fact has an expiry (e.g., "meeting tomorrow")
- entities: named entities mentioned
- relationships: (source_entity, relationship, target_entity) tuples

ONLY extract facts that would be useful for future tasks.
Do NOT extract obvious/trivial information.
Do NOT extract information that is purely conversational filler.

Return as JSON array of facts.
"""

SUB_AGENT_EXTRACTION_PROMPT = """
You are analyzing a sub-agent's task execution. Extract:
- Tool effectiveness (which tools worked/failed)
- Execution patterns (successful action sequences)
- Error patterns (what went wrong and why)
- Time/cost observations

Classify each as static (always true), dynamic (temporary), or procedural (habit-worthy).
"""

MEETING_EXTRACTION_PROMPT = """
You are analyzing a meeting transcript between agents. Extract:
- Decisions made (static if permanent, dynamic if temporary)
- Action items and assignments
- Blockers identified
- Learnings and insights
- Morale/confidence signals (priming)

Focus on facts that will be useful for future work, not meeting logistics.
"""

MEMORY_ACTION_DECISION_PROMPT = """
Given a new fact and existing memories, decide:
- ADD: New fact, no existing match
- UPDATE: Refines or corrects an existing memory (specify which)
- DELETE: Contradicts an existing memory (specify which)
- NONE: Already captured or not worth storing

Return: {"action": "ADD|UPDATE|DELETE|NONE", "target_id": "...", "reason": "..."}
"""
```

### 6.2 Contradiction Verification Prompt (GPT-4o-mini — NEW in v6)

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
"""
```

### 6.3 Memory Merge Prompt (GPT-4o-mini — NEW in v6)

```python
MEMORY_MERGE_PROMPT = """
Two memories about the same topic need to be merged into one.
Combine the information from both into a single, concise statement
that preserves all unique details from each.

Memory A: {memory_a}
Memory B: {memory_b}

Return a single merged statement. Do not add information that isn't in either memory.
Keep it under 200 characters.
"""
```

### 6.4 Habit Naming Prompt (GPT-4o-mini — NEW in v6)

```python
HABIT_NAMING_PROMPT = """
An AI agent has developed an automatic habit from a frequently used pattern.

Pattern domain: {domain}
Strategy: {strategy}
Usage count: {usage_count}
Success rate: {success_rate}

Generate:
1. A trigger condition (when should this habit activate?) — max 100 chars
2. An action (what should the agent do?) — max 200 chars

The trigger should be expressed as a situation description.
The action should be a clear instruction.

Return as JSON: {"trigger": "...", "action": "..."}
"""
```

### 6.6 Pattern Merge Prompt (GPT-4o-mini — NEW in v6)

```python
PATTERN_MERGE_PROMPT = """
Two similar patterns need to be merged into one.

Pattern A: {description_a}
Strategy A: {strategy_a}

Pattern B: {description_b}
Strategy B: {strategy_b}

Generate a merged description and strategy that combines the best of both.

Return as JSON: {"description": "...", "strategy": "..."}
"""
```

### 6.7 Priming Prompt Generation (GPT-4o-mini — NEW in v6)

```python
PRIMING_GENERATION_PROMPT = """
You are generating a disposition prompt for an AI agent based on their recent emotional state.

Current state:
- Confidence: {confidence} (0.0=none, 1.0=very high)
- Caution: {caution} (0.0=none, 1.0=very cautious)
- Morale: {morale} (0.0=very low, 1.0=very high)

Recent events (most recent first):
{recent_events}

Generate a 1-2 sentence disposition statement that will be injected into the agent's
system prompt. It should subtly influence their behavior without being heavy-handed.

Do NOT use numerical values. Speak in natural language about how the agent is feeling
and what that means for their approach.
"""
```

### 6.8 Relationship Classification Prompt (GPT-4o-mini — NEW in v6)

```python
RELATIONSHIP_CLASSIFICATION_PROMPT = """
Classify the relationship between two entities into one of these types:
- updates: replaces or supersedes
- extends: adds to without replacing
- derives: inferred from
- uses: utilizes
- owns: responsible for
- depends_on: requires
- related_to: general association
- part_of: component of
- decided_in: agreed upon during (meeting/event)

Source entity: {source}
Target entity: {target}
Relationship described as: {relation_text}

Return ONLY the relationship type (one of the above).
"""
```

### 6.9 Trigger Evaluation Prompt (GPT-4o-mini — NEW in v6)

```python
TRIGGER_EVALUATION_PROMPT = """
Given the current task context and a list of habit triggers, determine which
triggers are relevant to the current situation.

Current context: {context}

Candidate triggers:
{triggers}

For each trigger, respond with its index and YES/NO.
Return as JSON array: [{"index": 0, "relevant": true}, ...]
"""
```

### 6.10 Promotion Reason Prompt (GPT-4o-mini — NEW in v6)

```python
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
"""
```

---

## 7. Component Implementations

### 7.1 Working Memory (Tier 1)

No LLM usage. Unchanged from v5.

```python
class WorkingMemory:
    """
    Tier 1: Ephemeral runtime context.
    Backend: dict (in-process). TTL: 2 hours.
    """

    def __init__(self, agent_id: str, backend: WorkingMemoryBackend):
        self._agent_id = agent_id
        self._backend = backend
        self._prefix = f"wm:{agent_id}"

    async def load_task_context(self, task_id: str, context: dict) -> None:
        key = f"{self._prefix}:task:{task_id}"
        await self._backend.set(key, serialize(context), ttl_seconds=7200)

    async def append_conversation(self, task_id: str, message: dict) -> None:
        key = f"{self._prefix}:conv:{task_id}"
        existing = await self._backend.get(key) or "[]"
        messages = deserialize(existing)
        updated = (*messages, message)
        await self._backend.set(key, serialize(updated))

    async def get_current_context(self, task_id: str) -> dict:
        return {
            "task": await self._backend.get(f"{self._prefix}:task:{task_id}"),
            "conversation": await self._backend.get(f"{self._prefix}:conv:{task_id}"),
            "scratchpad": await self._backend.get(f"{self._prefix}:scratch:{task_id}"),
        }

    async def clear_task(self, task_id: str) -> None:
        await self._backend.clear(f"{self._prefix}:task:{task_id}")
        await self._backend.clear(f"{self._prefix}:conv:{task_id}")
        await self._backend.clear(f"{self._prefix}:scratch:{task_id}")
```

### 7.2 Static Memory (Tier 2)

No LLM usage. Unchanged from v5.

```python
class StaticMemory:
    """
    Tier 2: Permanent facts. Highest retrieval priority (1.5x boost).
    Never auto-expires. Updated only via versioned UPDATE.
    """

    def __init__(self, agent_id: str, vector_store: VectorStore, graph_store: "GraphStore"):
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._graph_store = graph_store

    async def add(self, fact: ExtractedFact, container: str) -> MemoryUnit:
        embedding = await self._embed(fact.text)
        unit = MemoryUnit(
            agent_id=self._agent_id,
            content=fact.text,
            embedding=embedding,
            memory_type=MemoryType.STATIC,
            confidence=fact.confidence,
            relevance_score=1.0,
            container=container,
            source_type="extraction",
        )
        await self._vector_store.upsert(unit)
        return unit

    async def search(self, query: str, container: str, top_k: int = 10) -> list[MemoryUnit]:
        query_embedding = await self._embed(query)
        return await self._vector_store.search(
            embedding=query_embedding,
            container=container,
            memory_types=[MemoryType.STATIC],
            top_k=top_k,
        )

    async def update(self, memory_id: str, new_content: str) -> MemoryUnit:
        old = await self._vector_store.get(memory_id)
        new_embedding = await self._embed(new_content)
        updated = MemoryUnit(
            agent_id=old.agent_id,
            content=new_content,
            embedding=new_embedding,
            memory_type=MemoryType.STATIC,
            confidence=old.confidence,
            relevance_score=1.0,
            container=old.container,
            version=old.version + 1,
            previous_version_id=old.id,
            source_type=old.source_type,
        )
        await self._vector_store.upsert(updated)
        await self._graph_store.create_edge(updated.id, old.id, RelationType.UPDATES)
        return updated

    async def get_all(self, container: str) -> list[MemoryUnit]:
        return await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            container=container,
            memory_type=MemoryType.STATIC,
        )
```

### 7.3 Dynamic Memory (Tier 3)

No LLM usage. Unchanged from v5.

```python
class DynamicMemory:
    """
    Tier 3: Episodic, time-decaying memories.
    Half-life: 30 days. Below 0.1 decay → eligible for GC.
    """

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        graph_store: "GraphStore",
        half_life_days: float = 30.0,
        decay_threshold: float = 0.1,
    ):
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._graph_store = graph_store
        self._half_life_days = half_life_days
        self._decay_threshold = decay_threshold

    async def add(self, fact: ExtractedFact, container: str) -> MemoryUnit:
        embedding = await self._embed(fact.text)
        unit = MemoryUnit(
            agent_id=self._agent_id,
            content=fact.text,
            embedding=embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=fact.confidence,
            relevance_score=1.0,
            container=container,
            expires_at=fact.expires_at,
            source_type="extraction",
        )
        await self._vector_store.upsert(unit)
        return unit

    async def search(self, query: str, container: str, top_k: int = 10) -> list[MemoryUnit]:
        query_embedding = await self._embed(query)
        candidates = await self._vector_store.search(
            embedding=query_embedding,
            container=container,
            memory_types=[MemoryType.DYNAMIC],
            top_k=top_k * 3,
        )
        scored = []
        now = datetime.utcnow()
        for mem in candidates:
            age_days = (now - mem.updated_at).total_seconds() / 86400
            decay = 0.5 ** (age_days / self._half_life_days)
            decayed_relevance = mem.relevance_score * decay
            if decayed_relevance >= self._decay_threshold:
                scored.append((mem, decayed_relevance))
        scored.sort(key=lambda x: x[1], reverse=True)
        return [mem for mem, _ in scored[:top_k]]

    async def find_expired(self) -> list[MemoryUnit]:
        return await self._vector_store.find_expired(
            agent_id=self._agent_id,
            memory_type=MemoryType.DYNAMIC,
            before=datetime.utcnow(),
        )

    async def find_decayed(self) -> list[MemoryUnit]:
        all_dynamic = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.DYNAMIC,
        )
        now = datetime.utcnow()
        decayed = []
        for mem in all_dynamic:
            age_days = (now - mem.updated_at).total_seconds() / 86400
            decay = 0.5 ** (age_days / self._half_life_days)
            if mem.relevance_score * decay < self._decay_threshold:
                decayed.append(mem)
        return decayed

    async def get_recent(self, container: str, days: int = 7) -> list[MemoryUnit]:
        cutoff = datetime.utcnow() - timedelta(days=days)
        return await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            container=container,
            memory_type=MemoryType.DYNAMIC,
            created_after=cutoff,
        )
```

### 7.4 Procedural Memory (Tier 4)

```python
class ProceduralMemory:
    """
    Tier 4: Habits and auto-triggered behavior blocks.

    Stores: behavioral rules the agent has learned to follow automatically.
    Injected directly into the system prompt when trigger conditions match.

    Examples:
    - trigger: "before committing code" → action: "always run tests first"
    - trigger: "designing API" → action: "use REST with OpenAPI spec"

    Formation paths:
    1. AUTO: Pattern used >N times with success >threshold → auto-form habit
    2. EXPLICIT: LLM extracts procedure from conversation

    Trigger evaluation: LLM evaluates all active habit triggers against current
    context in a single batch call. No embedding pre-filter.
    """

    def __init__(
        self,
        agent_id: str,
        relational_store: RelationalStore,
        llm_light: LLMEngine,                # Lightweight model for trigger eval
    ):
        self._agent_id = agent_id
        self._store = relational_store
        self._llm = llm_light

    async def add_habit(self, habit: Habit) -> Habit:
        await self._store.insert_habit(habit)
        return habit

    async def get_matching_habits(self, context: str) -> list[Habit]:
        """
        Find habits whose trigger conditions match the current context.
        Uses LLM to evaluate all triggers in a single batch call.
        """
        all_active = await self._store.list_habits(
            agent_id=self._agent_id, is_active=True
        )
        if not all_active:
            return []

        # LLM evaluates all triggers against context in one call
        triggers_text = "\n".join(
            f"{i}. {h.trigger_condition}"
            for i, h in enumerate(all_active)
        )
        result = await self._llm.decide(
            prompt=TRIGGER_EVALUATION_PROMPT.format(
                context=context,
                triggers=triggers_text,
            ),
        )

        matching = []
        for item in result:
            idx = item.get("index", -1)
            if 0 <= idx < len(all_active) and item.get("relevant", False):
                matching.append(all_active[idx])

        return matching

    async def get_active(self) -> list[Habit]:
        return await self._store.list_habits(
            agent_id=self._agent_id, is_active=True
        )

    async def record_usage(self, habit_id: str, was_useful: bool) -> Habit:
        habit = await self._store.get_habit(habit_id)
        new_count = habit.usage_count + 1
        lr = 0.1
        signal = 1.0 if was_useful else 0.0
        new_confidence = habit.confidence * (1 - lr) + signal * lr
        updated = Habit(
            id=habit.id,
            agent_id=habit.agent_id,
            trigger_condition=habit.trigger_condition,
            action=habit.action,
            confidence=new_confidence,
            usage_count=new_count,
            formed_from_id=habit.formed_from_id,
            formation_mode=habit.formation_mode,
            is_active=new_confidence > 0.2,
            created_at=habit.created_at,
        )
        await self._store.update_habit(updated)
        return updated
```

### 7.5 Priming Memory (Tier 5) — UPDATED: LLM-generated disposition

```python
class PrimingMemory:
    """
    Tier 5: Agent state and emotional context.

    v6 change: generate_priming_prompt() uses LLM to synthesize a nuanced
    disposition from recent events, instead of 3-branch if/elif/else.
    """

    def __init__(
        self,
        agent_id: str,
        relational_store: RelationalStore,
        llm_light: LLMEngine,                # NEW in v6
    ):
        self._agent_id = agent_id
        self._store = relational_store
        self._llm = llm_light

    async def update_state(self, stimulus: str, signal: float, source: str) -> dict:
        current = await self.get_current_state()
        lr = 0.15
        new_state = {
            "confidence": current.get("confidence", 0.5) * (1 - lr) + max(signal, 0) * lr,
            "caution": current.get("caution", 0.3) * (1 - lr) + max(-signal, 0) * lr,
            "morale": current.get("morale", 0.5) * (1 - lr) + (signal * 0.5 + 0.5) * lr,
            "recent_events": [
                *current.get("recent_events", [])[-9:],
                {"stimulus": stimulus, "signal": signal, "source": source,
                 "timestamp": datetime.utcnow().isoformat()},
            ],
        }
        await self._store.set_priming_state(self._agent_id, new_state)
        return new_state

    async def get_current_state(self) -> dict:
        return await self._store.get_priming_state(self._agent_id) or {
            "confidence": 0.5,
            "caution": 0.3,
            "morale": 0.5,
            "recent_events": [],
        }

    async def generate_priming_prompt(self) -> str:
        """
        [LLM-gpt4o-mini] Generate a nuanced disposition prompt from current state.

        v5 used 3-branch if/else. v6 uses LLM for richer, context-aware prompts
        that reference specific recent events.
        """
        state = await self.get_current_state()

        recent_events_text = "\n".join(
            f"- {e['stimulus']} (source: {e['source']}, signal: {'positive' if e['signal'] > 0 else 'negative'})"
            for e in state.get("recent_events", [])[-5:]  # Last 5 events
        ) or "No recent events."

        disposition = await self._llm.generate(
            prompt=PRIMING_GENERATION_PROMPT.format(
                confidence=f"{state['confidence']:.2f}",
                caution=f"{state['caution']:.2f}",
                morale=f"{state['morale']:.2f}",
                recent_events=recent_events_text,
            ),
        )
        return disposition
```

### 7.6 Memory Extractor — UPDATED: LLM relationship classification

```python
class MemoryExtractor:
    """
    LLM-driven automatic fact extraction.

    v6 change: _map_relation() uses LLM classification instead of hardcoded dict.
    This catches synonyms ("relies on" → depends_on) and novel relationship types
    that the hardcoded dict would miss.
    """

    def __init__(
        self,
        llm: LLMEngine,                      # Full model (gpt-4o) for extraction
        llm_light: LLMEngine,                # Lightweight model (gpt-4o-mini) for classification
        embedding_engine: EmbeddingEngine,
        hippocampus: "Hippocampus",
    ):
        self._llm = llm
        self._llm_light = llm_light
        self._embedding = embedding_engine
        self._hippocampus = hippocampus

    async def extract(
        self,
        messages: list[dict],
        agent_id: str,
        container: str,
        mode: ExtractionMode = ExtractionMode.AGENT,
    ) -> ExtractionResult:
        """
        Full extraction pipeline:
        1. Select prompt based on mode
        2. [LLM-gpt4o] extracts structured facts
        3. For each fact: search existing memories (top 5 by embedding)
        4. [LLM-gpt4o] decides action: ADD / UPDATE / DELETE / NONE
        5. Execute actions (route to correct tier)
        6. Extract entities + relationships → Neo4j
           → [LLM-gpt4o-mini] classifies relationship types
        """
        prompt = self._get_prompt(mode)

        facts = await self._llm.extract_structured(
            prompt=prompt,
            messages=messages,
            output_schema=list[ExtractedFact],
        )

        actions = []
        for fact in facts:
            existing = await self._hippocampus.search(
                query=fact.text,
                agent_id=agent_id,
                container=container,
                top_k=5,
            )

            action = await self._decide_action(fact, existing)
            actions.append(action)

            match action[0]:
                case MemoryAction.ADD:
                    await self._add_to_tier(fact, agent_id, container)
                case MemoryAction.UPDATE:
                    await self._update_memory(action[1], fact, agent_id, container)
                case MemoryAction.DELETE:
                    await self._soft_delete(action[1], reason=fact.text)

            if fact.entities or fact.relationships:
                await self._update_graph(fact, container)

        return ExtractionResult(facts=tuple(facts), actions=tuple(actions))

    async def _decide_action(
        self, fact: ExtractedFact, existing: list[MemoryUnit]
    ) -> tuple[MemoryAction, str, str]:
        if not existing:
            return (MemoryAction.ADD, "", "no existing match")

        decision = await self._llm.decide(
            prompt=MEMORY_ACTION_DECISION_PROMPT,
            fact=fact.text,
            existing_memories=[
                {"id": m.id, "content": m.content, "type": m.memory_type.value}
                for m in existing
            ],
        )
        return decision

    async def _add_to_tier(
        self, fact: ExtractedFact, agent_id: str, container: str
    ) -> Optional[MemoryUnit]:
        if fact.is_permanent:
            return await self._hippocampus.static_memory.add(fact, container)
        elif fact.is_procedural:
            habit = Habit(
                agent_id=agent_id,
                trigger_condition=fact.text.split("→")[0].strip() if "→" in fact.text else "",
                action=fact.text.split("→")[1].strip() if "→" in fact.text else fact.text,
                confidence=fact.confidence,
                formation_mode=HabitFormation.EXPLICIT,
            )
            await self._hippocampus.procedural_memory.add_habit(habit)
            return None
        else:
            return await self._hippocampus.dynamic_memory.add(fact, container)

    async def _update_graph(self, fact: ExtractedFact, container: str) -> None:
        for entity_name in fact.entities:
            embedding = await self._embedding.embed(entity_name)
            entity = GraphEntity(
                name=entity_name,
                entity_type="auto",
                embedding=embedding,
                container=container,
            )
            existing = await self._hippocampus.graph_store.find_similar_node(
                embedding, threshold=0.7, container=container
            )
            if existing:
                await self._hippocampus.graph_store.merge_node(existing, entity)
            else:
                await self._hippocampus.graph_store.create_node(entity)

        for source, relation, target in fact.relationships:
            rel_type = await self._classify_relation(source, target, relation)
            await self._hippocampus.graph_store.create_edge_by_name(
                source, target, rel_type, container=container
            )

    async def _classify_relation(
        self, source: str, target: str, relation_text: str
    ) -> RelationType:
        """
        [LLM-gpt4o-mini] Classify relationship into RelationType enum.

        v5 used a hardcoded dict that missed synonyms.
        v6 uses LLM classification — handles "relies on" → DEPENDS_ON,
        "is built with" → USES, etc.
        """
        result = await self._llm_light.classify(
            prompt=RELATIONSHIP_CLASSIFICATION_PROMPT.format(
                source=source,
                target=target,
                relation_text=relation_text,
            ),
            options=[rt.value for rt in RelationType],
        )
        try:
            return RelationType(result.strip().lower())
        except ValueError:
            return RelationType.RELATED_TO  # Safe fallback

    def _get_prompt(self, mode: ExtractionMode) -> str:
        return {
            ExtractionMode.AGENT: AGENT_EXTRACTION_PROMPT,
            ExtractionMode.SUB_AGENT: SUB_AGENT_EXTRACTION_PROMPT,
            ExtractionMode.CONVERSATION: AGENT_EXTRACTION_PROMPT,
            ExtractionMode.MEETING: MEETING_EXTRACTION_PROMPT,
        }[mode]
```

### 7.7 Graph Store (Neo4j)

No LLM usage. Unchanged from v5.

```python
class GraphStore:
    """
    Knowledge graph for entity-relationship memory.
    Embedding-based node matching, hybrid search, version chains.
    """

    def __init__(self, backend: GraphStoreBackend, embedding_engine: EmbeddingEngine):
        self._backend = backend
        self._embedding = embedding_engine

    async def find_similar_node(
        self, embedding: list[float], threshold: float = 0.7, container: str = ""
    ) -> Optional[GraphEntity]:
        candidates = await self._backend.vector_search(embedding, container, top_k=5)
        for candidate in candidates:
            similarity = cosine_similarity(embedding, candidate.embedding)
            if similarity >= threshold:
                return candidate
        return None

    async def merge_node(self, existing: GraphEntity, new: GraphEntity) -> GraphEntity:
        await self._backend.update_node(existing.id, {
            "mention_count": existing.mention_count + 1,
            "metadata": {**existing.metadata, **new.metadata},
        })
        return existing

    async def create_node(self, entity: GraphEntity) -> str:
        return await self._backend.create_node(entity)

    async def create_edge(
        self, source_id: str, target_id: str, rel_type: RelationType,
        metadata: dict = None
    ) -> str:
        rel = GraphRelationship(
            source_id=source_id,
            target_id=target_id,
            relation_type=rel_type,
            metadata=metadata or {},
        )
        return await self._backend.create_edge(rel)

    async def create_edge_by_name(
        self, source_name: str, target_name: str, rel_type: RelationType,
        container: str = ""
    ) -> Optional[str]:
        src_emb = await self._embedding.embed(source_name)
        tgt_emb = await self._embedding.embed(target_name)
        src_node = await self.find_similar_node(src_emb, container=container)
        tgt_node = await self.find_similar_node(tgt_emb, container=container)
        if src_node and tgt_node:
            return await self.create_edge(src_node.id, tgt_node.id, rel_type)
        return None

    async def search(
        self, query: str, container: str, top_k: int = 10, max_hops: int = 2
    ) -> list[dict]:
        query_embedding = await self._embedding.embed(query)
        seed_nodes = await self._backend.vector_search(
            query_embedding, container, top_k=top_k * 3
        )
        expanded = set()
        for node in seed_nodes:
            neighbors = await self._backend.get_neighbors(node.id, max_hops)
            expanded.update(n.id for n in neighbors)
            expanded.add(node.id)
        all_nodes = [await self._backend.get_node(nid) for nid in expanded]
        all_nodes = [n for n in all_nodes if n is not None]
        ranked = bm25_rerank(query, [n.name for n in all_nodes], all_nodes)
        return ranked[:top_k]

    async def version_memory(
        self, old_memory_id: str, new_fact: str, container: str
    ) -> GraphEntity:
        embedding = await self._embedding.embed(new_fact)
        new_node = GraphEntity(
            name=new_fact,
            entity_type="memory_version",
            embedding=embedding,
            container=container,
            is_latest=True,
        )
        new_id = await self._backend.create_node(new_node)
        await self.create_edge(new_id, old_memory_id, RelationType.UPDATES)
        await self._backend.update_node(old_memory_id, {"is_latest": False})
        return new_node

    async def get_version_history(self, memory_id: str) -> list[GraphEntity]:
        return await self._backend.cypher_query(
            "MATCH (n)-[:UPDATES*]->(root) WHERE n.id = $id RETURN root ORDER BY root.created_at",
            {"id": memory_id},
        )
```

### 7.8 ReasoningBank — UPDATED: LLM contradiction + merge in consolidate()

```python
class ReasoningBankConfig:
    retrieval_k: int = 3
    mmr_lambda: float = 0.7
    distillation_threshold: float = 0.6


class ReasoningBank:
    """
    4-step pipeline: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE.

    v6 changes in CONSOLIDATE:
    - Contradiction detection now uses [LLM-gpt4o-mini] verification after cosine pre-filter
    - Memory merge now uses [LLM-gpt4o-mini] to synthesize combined text
    """

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        pattern_store: PatternStore,
        llm: LLMEngine,                      # Full model (gpt-4o)
        llm_light: LLMEngine,                # Lightweight model (gpt-4o-mini) — NEW in v6
        embedding_engine: EmbeddingEngine,
        config: ReasoningBankConfig = None,
    ):
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._pattern_store = pattern_store
        self._llm = llm
        self._llm_light = llm_light
        self._embedding = embedding_engine
        self._config = config or ReasoningBankConfig()

    # ── STEP 1: RETRIEVE (unchanged) ──

    async def retrieve(
        self, query: str, container: str, top_k: int = None
    ) -> list[RetrievalResult]:
        k = top_k or self._config.retrieval_k
        query_embedding = await self._embedding.embed(query)
        candidates = await self._vector_store.search(
            embedding=query_embedding,
            container=container,
            memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
            top_k=k * 3,
        )
        selected = self._mmr_select(
            query_embedding, candidates, k, self._config.mmr_lambda
        )
        return [
            RetrievalResult(memory=mem, relevance=rel, diversity=div)
            for mem, rel, div in selected
        ]

    def _mmr_select(self, query_emb, candidates, k, lambda_param) -> list[tuple]:
        selected = []
        remaining = list(candidates)
        while len(selected) < k and remaining:
            best = None
            best_score = -float("inf")
            for mem in remaining:
                relevance = cosine_similarity(query_emb, mem.embedding)
                diversity = min(
                    (1 - cosine_similarity(mem.embedding, s[0].embedding))
                    for s in selected
                ) if selected else 1.0
                score = lambda_param * relevance + (1 - lambda_param) * diversity
                if score > best_score:
                    best_score = score
                    best = mem
                    best_rel = relevance
                    best_div = diversity
            if best:
                selected.append((best, best_rel, best_div))
                remaining.remove(best)
        return selected

    # ── STEP 2: JUDGE (unchanged) ──

    async def judge(self, trajectory: Trajectory) -> TrajectoryVerdict:
        rewards = [step.reward for step in trajectory.steps]
        avg_reward = sum(rewards) / len(rewards) if rewards else 0
        positive_ratio = sum(1 for r in rewards if r > 0) / len(rewards) if rewards else 0
        slope = self._compute_slope(rewards) if len(rewards) > 1 else 0

        quality = (
            0.4 * avg_reward +
            0.3 * positive_ratio +
            0.2 * max(slope, 0) +
            0.1 * (1.0 if trajectory.outcome == "success" else 0.0)
        )

        analysis = await self._llm.analyze(
            prompt="Analyze this trajectory. What were the strengths, weaknesses, and key learnings?",
            trajectory=trajectory,
        )

        return TrajectoryVerdict(
            trajectory_id=trajectory.id,
            quality=quality,
            is_successful=quality >= self._config.distillation_threshold and positive_ratio > 0.6,
            strengths=analysis.get("strengths", []),
            weaknesses=analysis.get("weaknesses", []),
            suggestions=analysis.get("suggestions", []),
            confidence=min(avg_reward + 0.3, 1.0),
        )

    def _compute_slope(self, rewards: list[float]) -> float:
        n = len(rewards)
        if n < 2:
            return 0.0
        x_mean = (n - 1) / 2
        y_mean = sum(rewards) / n
        numerator = sum((i - x_mean) * (r - y_mean) for i, r in enumerate(rewards))
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        return numerator / denominator if denominator != 0 else 0.0

    # ── STEP 3: DISTILL (unchanged) ──

    async def distill(
        self, trajectory: Trajectory, verdict: TrajectoryVerdict
    ) -> Optional[DistilledMemory]:
        if not verdict.is_successful:
            return None

        strategy = " → ".join(step.action for step in trajectory.steps)

        total_reward = sum(max(s.reward, 0.01) for s in trajectory.steps)
        weighted_emb = [0.0] * len(trajectory.steps[0].embedding or [])
        for step in trajectory.steps:
            if step.embedding:
                weight = max(step.reward, 0.01) / total_reward
                for i, val in enumerate(step.embedding):
                    weighted_emb[i] += val * weight

        distilled = DistilledMemory(
            agent_id=self._agent_id,
            trajectory_id=trajectory.id,
            strategy=strategy,
            embedding=weighted_emb,
            quality=verdict.quality,
            learnings=verdict.strengths + verdict.suggestions,
        )
        await self._vector_store.upsert(distilled.to_memory_unit())
        return distilled

    # ── STEP 4: CONSOLIDATE (UPDATED in v6) ──

    async def consolidate(self) -> ConsolidationResult:
        """
        v6 changes:
        - Contradiction detection: cosine >0.80 → [LLM-gpt4o-mini] verifies
        - Merge: cosine >0.90 same domain → [LLM-gpt4o-mini] synthesizes merged text
        """
        all_memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
        )

        deduped = 0
        contradictions_found = 0
        contradictions_resolved = 0
        pruned = 0
        merged = 0

        # 1. Dedup (>95% similar → keep highest confidence)
        for i, mem_a in enumerate(all_memories):
            for mem_b in all_memories[i + 1:]:
                if not mem_a.embedding or not mem_b.embedding:
                    continue
                sim = cosine_similarity(mem_a.embedding, mem_b.embedding)
                if sim > 0.95:
                    victim = mem_b if mem_a.confidence >= mem_b.confidence else mem_a
                    await self._vector_store.soft_delete(victim.id)
                    deduped += 1

        # 2. Contradiction detection (>0.80 similar → LLM verifies)
        for i, mem_a in enumerate(all_memories):
            for mem_b in all_memories[i + 1:]:
                if not mem_a.embedding or not mem_b.embedding:
                    continue
                sim = cosine_similarity(mem_a.embedding, mem_b.embedding)
                if 0.80 < sim <= 0.95:
                    # [LLM-gpt4o-mini] verify actual contradiction
                    verdict = await self._llm_light.classify(
                        prompt=CONTRADICTION_CHECK_PROMPT.format(
                            memory_a=mem_a.content,
                            memory_b=mem_b.content,
                        ),
                        options=["CONTRADICTION", "NO_CONTRADICTION"],
                    )
                    if verdict.strip() == "CONTRADICTION":
                        contradictions_found += 1
                        # Keep higher confidence, soft-delete lower
                        victim = mem_b if mem_a.confidence >= mem_b.confidence else mem_a
                        await self._vector_store.soft_delete(
                            victim.id, reason=f"contradiction_with_{(mem_a if victim == mem_b else mem_b).id}"
                        )
                        contradictions_resolved += 1

        # 3. Merge (>0.90 similar, same domain → LLM synthesizes merged text)
        for i, mem_a in enumerate(all_memories):
            for mem_b in all_memories[i + 1:]:
                if not mem_a.embedding or not mem_b.embedding:
                    continue
                sim = cosine_similarity(mem_a.embedding, mem_b.embedding)
                domain_a = mem_a.metadata.get("domain", "")
                domain_b = mem_b.metadata.get("domain", "")
                if 0.90 < sim <= 0.95 and domain_a == domain_b and domain_a:
                    # [LLM-gpt4o-mini] synthesize merged text
                    merged_text = await self._llm_light.generate(
                        prompt=MEMORY_MERGE_PROMPT.format(
                            memory_a=mem_a.content,
                            memory_b=mem_b.content,
                        ),
                    )
                    merged_embedding = await self._embedding.embed(merged_text)
                    merged_unit = MemoryUnit(
                        agent_id=mem_a.agent_id,
                        content=merged_text.strip(),
                        embedding=merged_embedding,
                        memory_type=mem_a.memory_type,
                        confidence=max(mem_a.confidence, mem_b.confidence),
                        relevance_score=max(mem_a.relevance_score, mem_b.relevance_score),
                        container=mem_a.container,
                        source_type="consolidation_merge",
                        provenance=f"Merged from {mem_a.id} + {mem_b.id}",
                        metadata={
                            **mem_a.metadata,
                            "usage_count": mem_a.metadata.get("usage_count", 0)
                                         + mem_b.metadata.get("usage_count", 0),
                        },
                    )
                    await self._vector_store.upsert(merged_unit)
                    await self._vector_store.soft_delete(mem_a.id, reason="merged")
                    await self._vector_store.soft_delete(mem_b.id, reason="merged")
                    merged += 1

        # 4. Prune (>30d, <5 uses, conf <0.3, not a promotion candidate)
        now = datetime.utcnow()
        for mem in all_memories:
            age_days = (now - mem.created_at).total_seconds() / 86400
            uses = mem.metadata.get("usage_count", 0)
            if age_days > 30 and uses < 5 and mem.confidence < 0.3:
                if not self._is_promotion_candidate(mem):
                    await self._vector_store.soft_delete(mem.id)
                    pruned += 1

        return ConsolidationResult(
            deduped=deduped,
            contradictions_found=contradictions_found,
            contradictions_resolved=contradictions_resolved,
            pruned=pruned,
            merged=merged,
        )

    def _is_promotion_candidate(self, mem: MemoryUnit) -> bool:
        uses = mem.metadata.get("usage_count", 0)
        age_days = (datetime.utcnow() - mem.created_at).total_seconds() / 86400
        return uses >= 10 and mem.confidence >= 0.8 and age_days >= 14
```

### 7.9 PatternLearner — UPDATED: LLM naming + merge synthesis

```python
class PatternLearnerConfig:
    learning_rate: float = 0.1
    habit_usage_threshold: int = 10
    habit_success_threshold: float = 0.8


class PatternLearner:
    """
    Pattern discovery + evolution with clustering.

    v6 changes:
    - check_habit_formation() uses [LLM-gpt4o-mini] to generate trigger + action
    - _merge_patterns() uses [LLM-gpt4o-mini] to synthesize merged description
    """

    def __init__(
        self,
        agent_id: str,
        pattern_store: PatternStore,
        embedding_engine: EmbeddingEngine,
        llm_light: LLMEngine,                # NEW in v6
        config: PatternLearnerConfig = None,
    ):
        self._agent_id = agent_id
        self._store = pattern_store
        self._embedding = embedding_engine
        self._llm = llm_light
        self._config = config or PatternLearnerConfig()

    async def extract_pattern(self, trajectory: Trajectory) -> Optional[Pattern]:
        if trajectory.quality < 0.5:
            return None

        embedding = await self._embedding.embed(trajectory.outcome)

        existing = await self._store.find_similar(embedding, threshold=0.95)
        if existing:
            await self.evolve_pattern(existing, trajectory.quality)
            return existing

        pattern = Pattern(
            agent_id=self._agent_id,
            description=trajectory.outcome,
            strategy=" → ".join(s.action for s in trajectory.steps),
            embedding=embedding,
            usage_count=1,
            success_rate=trajectory.quality,
            formed_from=(trajectory.id,),
            domain=trajectory.steps[0].action.split(":")[0] if trajectory.steps else "",
        )
        await self._store.insert(pattern)
        await self._assign_to_cluster(pattern)
        return pattern

    async def evolve_pattern(self, pattern: Pattern, quality: float) -> Pattern:
        lr = self._config.learning_rate
        new_rate = pattern.success_rate * (1 - lr) + quality * lr
        updated = Pattern(
            id=pattern.id,
            agent_id=pattern.agent_id,
            description=pattern.description,
            strategy=pattern.strategy,
            embedding=pattern.embedding,
            usage_count=pattern.usage_count + 1,
            success_rate=new_rate,
            formed_from=pattern.formed_from,
            cluster_id=pattern.cluster_id,
            status=pattern.status,
            domain=pattern.domain,
            created_at=pattern.created_at,
            updated_at=datetime.utcnow(),
        )
        await self._store.update(updated)
        return updated

    async def check_habit_formation(self, pattern: Pattern) -> Optional[Habit]:
        """
        v6: [LLM-gpt4o-mini] generates proper trigger condition + action
        instead of using raw pattern domain/strategy.
        """
        if (pattern.usage_count >= self._config.habit_usage_threshold
                and pattern.success_rate >= self._config.habit_success_threshold):

            naming = await self._llm.decide(
                prompt=HABIT_NAMING_PROMPT.format(
                    domain=pattern.domain,
                    strategy=pattern.strategy,
                    usage_count=pattern.usage_count,
                    success_rate=f"{pattern.success_rate:.2f}",
                ),
            )

            habit = Habit(
                agent_id=pattern.agent_id,
                trigger_condition=naming.get("trigger", pattern.domain),
                action=naming.get("action", pattern.strategy),
                confidence=pattern.success_rate,
                usage_count=pattern.usage_count,
                formed_from_id=pattern.id,
                formation_mode=HabitFormation.AUTO,
            )
            return habit
        return None

    async def consolidate_patterns(self) -> dict:
        all_patterns = await self._store.list_all(agent_id=self._agent_id)
        merged, pruned, split = 0, 0, 0

        # Merge similar (>90% sim, same domain → LLM synthesizes merged description)
        for i, pa in enumerate(all_patterns):
            for pb in all_patterns[i + 1:]:
                if pa.status == PatternStatus.ACTIVE and pb.status == PatternStatus.ACTIVE:
                    if pa.embedding and pb.embedding:
                        sim = cosine_similarity(pa.embedding, pb.embedding)
                        if sim > 0.9 and pa.domain == pb.domain:
                            await self._merge_patterns(pa, pb)
                            merged += 1

        # Prune: composite score below 20th percentile
        import math
        scores = [
            (p, p.success_rate * math.log(max(p.usage_count, 1) + 1))
            for p in all_patterns if p.status == PatternStatus.ACTIVE
        ]
        if scores:
            scores.sort(key=lambda x: x[1])
            cutoff_idx = len(scores) // 5
            for pattern, _ in scores[:cutoff_idx]:
                await self._store.update_status(pattern.id, PatternStatus.PRUNED)
                pruned += 1

        return {"merged": merged, "pruned": pruned, "split": split}

    async def _merge_patterns(self, pa: Pattern, pb: Pattern) -> None:
        """
        v6: [LLM-gpt4o-mini] synthesizes merged description + strategy
        instead of just keeping pa's text and discarding pb's.
        """
        merge_result = await self._llm.decide(
            prompt=PATTERN_MERGE_PROMPT.format(
                description_a=pa.description,
                strategy_a=pa.strategy,
                description_b=pb.description,
                strategy_b=pb.strategy,
            ),
        )

        merged_description = merge_result.get("description", pa.description)
        merged_strategy = merge_result.get("strategy", pa.strategy)
        merged_embedding = await self._embedding.embed(merged_description)

        total_usage = pa.usage_count + pb.usage_count
        merged_rate = (
            pa.success_rate * pa.usage_count + pb.success_rate * pb.usage_count
        ) / total_usage

        merged = Pattern(
            id=pa.id,
            agent_id=pa.agent_id,
            description=merged_description,
            strategy=merged_strategy,
            embedding=merged_embedding,
            usage_count=total_usage,
            success_rate=merged_rate,
            formed_from=pa.formed_from + pb.formed_from,
            cluster_id=pa.cluster_id,
            status=PatternStatus.ACTIVE,
            domain=pa.domain,
            created_at=pa.created_at,
            updated_at=datetime.utcnow(),
        )
        await self._store.update(merged)
        await self._store.update_status(pb.id, PatternStatus.MERGED)

    async def _assign_to_cluster(self, pattern: Pattern) -> None:
        pass  # Production: sklearn.cluster k-means
```

### 7.10 Promotion Engine — UPDATED: LLM contradiction check + reason generation

```python
class PromotionEngine:
    """
    Fully automatic memory promotion.

    v6 changes:
    - _check_contradiction() uses [LLM-gpt4o-mini] to verify semantic contradiction
      after cosine pre-filter (cosine alone can't distinguish similar-but-compatible
      from actually-contradictory memories)
    - _generate_promotion_reason() uses [LLM-gpt4o-mini] to produce human-readable
      dashboard explanations instead of formatted number strings
    """

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
        llm_light: LLMEngine,                # NEW in v6
    ):
        self._vector_store = vector_store
        self._graph_store = graph_store
        self._embedding = embedding_engine
        self._llm = llm_light

    async def run_promotions(self, agent_id: str) -> list[MemoryPromotionEvent]:
        dynamic_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.DYNAMIC,
        )

        events = []
        for mem in dynamic_memories:
            if len(events) >= self.MAX_PROMOTIONS_PER_CYCLE:
                break

            if self._qualifies_for_static(mem):
                # [LLM-gpt4o-mini] verify no semantic contradiction
                has_contradiction = await self._check_contradiction(mem, agent_id)
                if has_contradiction:
                    continue

                event = await self._promote_to_static(mem, agent_id)
                if event:
                    events.append(event)

        return events

    def _qualifies_for_static(self, mem: MemoryUnit) -> bool:
        uses = mem.metadata.get("usage_count", 0)
        age_days = (datetime.utcnow() - mem.created_at).total_seconds() / 86400
        return (
            uses >= self.STATIC_ACCESS_THRESHOLD
            and mem.confidence >= self.STATIC_CONFIDENCE_THRESHOLD
            and age_days >= self.STATIC_AGE_DAYS_THRESHOLD
            and mem.promotion_status is None
        )

    async def _check_contradiction(self, mem: MemoryUnit, agent_id: str) -> bool:
        """
        v6: Two-step contradiction check:
        1. Cosine pre-filter: find static memories with >0.80 similarity
        2. [LLM-gpt4o-mini] verify: is this a true semantic contradiction?

        This prevents false positives like "We use Stripe" vs
        "We use Stripe webhooks" (similar embeddings, not contradictory).
        """
        static_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.STATIC,
        )
        for static_mem in static_memories:
            if mem.embedding and static_mem.embedding:
                sim = cosine_similarity(mem.embedding, static_mem.embedding)
                if sim > 0.80:
                    # Step 2: LLM verification
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
    ) -> Optional[MemoryPromotionEvent]:
        # [LLM-gpt4o-mini] generate human-readable reason
        reason = await self._generate_promotion_reason(mem)

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
            metadata={**mem.metadata, "promoted_from": mem.id, "probation_until": (
                datetime.utcnow() + timedelta(days=self.PROBATION_DAYS)
            ).isoformat()},
            source_type=mem.source_type,
            source_id=mem.source_id,
            provenance=f"Auto-promoted from dynamic memory {mem.id}",
        )
        await self._vector_store.upsert(promoted)
        await self._vector_store.soft_delete(mem.id, reason="promoted_to_static")
        await self._graph_store.create_edge(
            promoted.id, mem.id, RelationType.PROMOTED_FROM
        )

        return MemoryPromotionEvent(
            agent_id=agent_id,
            memory_id=promoted.id,
            from_type="dynamic",
            to_type="static",
            reason=reason,
            status="promoted",
        )

    async def _generate_promotion_reason(self, mem: MemoryUnit) -> str:
        """
        [LLM-gpt4o-mini] Generate human-readable promotion reason for dashboard.

        v5 used: f"Threshold met: access={count}, confidence={conf}, age={days}d"
        v6 generates: "This architectural decision has been consistently referenced
        across multiple tasks over two weeks, proving its lasting relevance."
        """
        return await self._llm.generate(
            prompt=PROMOTION_REASON_PROMPT.format(
                content=mem.content,
                access_count=mem.metadata.get("usage_count", 0),
                confidence=f"{mem.confidence:.2f}",
                age_days=f"{self._age_days(mem):.0f}",
                source_type=mem.source_type,
            ),
        )

    async def demote(self, memory_id: str, reason: str) -> Optional[MemoryUnit]:
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
        demoted = []
        now = datetime.utcnow()
        for mem in static_memories:
            probation_until = mem.metadata.get("probation_until")
            if not probation_until:
                continue
            probation_end = datetime.fromisoformat(probation_until)
            if now < probation_end:
                uses_since_promotion = mem.metadata.get("usage_count", 0)
                if uses_since_promotion == 0:
                    result = await self.demote(mem.id, "unused_during_probation")
                    if result:
                        demoted.append(result)
        return demoted

    async def check_unused_static_demotions(self, agent_id: str) -> list[MemoryUnit]:
        static_memories = await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=MemoryType.STATIC,
        )
        demoted = []
        now = datetime.utcnow()
        for mem in static_memories:
            last_accessed = mem.metadata.get("last_accessed")
            if last_accessed:
                days_since = (now - datetime.fromisoformat(last_accessed)).total_seconds() / 86400
                if days_since >= self.UNUSED_STATIC_DEMOTION_DAYS:
                    result = await self.demote(mem.id, "unused_static_60d")
                    if result:
                        demoted.append(result)
        return demoted

    async def get_recent_promotions(self, agent_id: str) -> list[MemoryPromotionEvent]:
        pass  # Queries promotion audit log, returns last 20 events

    def _age_days(self, mem: MemoryUnit) -> float:
        return (datetime.utcnow() - mem.created_at).total_seconds() / 86400
```

### 7.11 Garbage Collector — UPDATED: includes promotions in result

```python
class MemoryGarbageCollector:
    """
    Runs every 6 hours. Orchestrates cleanup + consolidation + promotions.
    """

    def __init__(
        self,
        hippocampus: "Hippocampus",
        promotion_engine: PromotionEngine,
    ):
        self._hippocampus = hippocampus
        self._promotion_engine = promotion_engine

    async def run(self) -> GCResult:
        # 1. Expire temporal facts
        expired = await self._hippocampus.dynamic_memory.find_expired()
        for mem in expired:
            await self._hippocampus._vector_store.soft_delete(
                mem.id, reason="temporal_expiry"
            )

        # 2. Decay-based cleanup (skip promotion candidates)
        decayed = await self._hippocampus.dynamic_memory.find_decayed()
        actually_removed = []
        for mem in decayed:
            if not self._promotion_engine._qualifies_for_static(mem):
                await self._hippocampus._vector_store.soft_delete(
                    mem.id, reason="relevance_decay"
                )
                actually_removed.append(mem)

        # 3. ReasoningBank consolidation (with LLM contradiction check + merge)
        consolidation = await self._hippocampus.reasoning_bank.consolidate()

        # 4. Pattern consolidation (with LLM merge synthesis)
        pattern_result = await self._hippocampus.pattern_learner.consolidate_patterns()

        # 5. Automatic promotions (with LLM contradiction check + reason generation)
        promotions = await self._promotion_engine.run_promotions(
            self._hippocampus._agent_id
        )

        # 6. Probation demotions
        await self._promotion_engine.check_probation_demotions(
            self._hippocampus._agent_id
        )

        # 7. Unused-static demotions
        await self._promotion_engine.check_unused_static_demotions(
            self._hippocampus._agent_id
        )

        return GCResult(
            expired_removed=len(expired),
            decayed_removed=len(actually_removed),
            deduped=consolidation.deduped,
            pruned=consolidation.pruned,
            merged=consolidation.merged,
            patterns_merged=pattern_result["merged"],
            patterns_pruned=pattern_result["pruned"],
            promotions_fired=len(promotions),
        )
```

### 7.12 Hippocampus (Main Container) — UPDATED: wires LLM to all components

```python
@dataclass
class HippocampusConfig:
    # ── Backends ──
    vector_store_backend: str = "in_memory"
    graph_store_backend: str = "neo4j"
    cache_backend: str = "dict"
    relational_backend: str = "sqlite"
    sqlite_path: str = "hippocampus.db"              # SQLite database file path

    # ── Memory tuning ──
    dynamic_memory_half_life_days: float = 30.0
    decay_threshold: float = 0.1
    gc_interval_hours: float = 6.0

    # ── Retrieval ──
    retrieval_k: int = 3
    mmr_lambda: float = 0.7
    static_boost: float = 1.5
    procedural_boost: float = 1.2
    task_scope_boost: float = 1.3

    # ── ReasoningBank ──
    distillation_threshold: float = 0.6

    # ── PatternLearner ──
    pattern_learning_rate: float = 0.1
    habit_usage_threshold: int = 10
    habit_success_threshold: float = 0.8

    # ── Promotion (automatic) ──
    promotion_access_threshold: int = 10
    promotion_confidence_threshold: float = 0.8
    promotion_age_days: int = 14

    # ── Extraction ──
    extraction_frequency: str = "per_task_and_meeting"
    extraction_model: str = "gpt-4o"

    # ── Embedding ──
    embedding_model: str = "all-MiniLM-L6-v2"
    embedding_dimensions: int = 384
    embedding_device: str = "cpu"                      # "cpu" or "cuda"

    # ── Azure OpenAI ──
    azure_openai_endpoint: str = ""                    # e.g., "https://<resource>.openai.azure.com/"
    azure_openai_api_version: str = "2024-12-01-preview"
    azure_openai_deployment_reasoning: str = "gpt-4o"      # Azure deployment name
    azure_openai_deployment_lightweight: str = "gpt-4o-mini"  # Azure deployment name

    # ── LLM ──
    reasoning_model: str = "gpt-4o"
    lightweight_model: str = "gpt-4o-mini"    # NEW in v6


class Hippocampus:
    """
    Complete memory system for an AI agent.

    v6: All components that need LLM intelligence receive appropriate model tier:
    - GPT-4o: extraction, action decision, trajectory analysis (need deep reasoning)
    - GPT-4o-mini: classification, naming, merging, prompting (need speed + low cost)
    """

    def __init__(
        self,
        agent_id: str,
        working_memory: WorkingMemory,
        static_memory: StaticMemory,
        dynamic_memory: DynamicMemory,
        procedural_memory: ProceduralMemory,
        priming_memory: PrimingMemory,
        memory_extractor: MemoryExtractor,
        reasoning_bank: ReasoningBank,
        graph_store: GraphStore,
        pattern_learner: PatternLearner,
        promotion_engine: PromotionEngine,
        gc: MemoryGarbageCollector,
        embedding_engine: EmbeddingEngine,
        llm_engine: LLMEngine,
        llm_light: LLMEngine,
        vector_store: VectorStore,
    ):
        self._agent_id = agent_id
        self.working_memory = working_memory
        self.static_memory = static_memory
        self.dynamic_memory = dynamic_memory
        self.procedural_memory = procedural_memory
        self.priming_memory = priming_memory
        self.memory_extractor = memory_extractor
        self.reasoning_bank = reasoning_bank
        self.graph_store = graph_store
        self.pattern_learner = pattern_learner
        self.promotion_engine = promotion_engine
        self._gc = gc
        self._embedding = embedding_engine
        self._llm = llm_engine
        self._llm_light = llm_light
        self._vector_store = vector_store

    @classmethod
    async def create(cls, agent_id: str, config: HippocampusConfig) -> "Hippocampus":
        """Factory method — builds all components from config."""
        # Initialize backends
        vector_store = create_vector_store(config.vector_store_backend, config)
        graph_backend = create_graph_store(config.graph_store_backend, config)
        cache_backend = create_cache(config.cache_backend, config)
        relational = create_relational(config.relational_backend, config)
        embedding = create_embedding_engine(config.embedding_model, config.embedding_dimensions)
        llm = create_llm_engine(config.extraction_model)
        llm_light = create_llm_engine(config.lightweight_model)    # NEW in v6

        # Build components
        working = WorkingMemory(agent_id, cache_backend)
        graph = GraphStore(graph_backend, embedding)
        static = StaticMemory(agent_id, vector_store, graph)
        dynamic = DynamicMemory(
            agent_id, vector_store, graph,
            config.dynamic_memory_half_life_days,
            config.decay_threshold,
        )
        procedural = ProceduralMemory(
            agent_id, relational,
            llm_light,        # LLM-only trigger evaluation
        )
        priming = PrimingMemory(
            agent_id, relational,
            llm_light,        # NEW in v6
        )
        pattern_store = PatternStore(relational)
        reasoning = ReasoningBank(
            agent_id, vector_store, pattern_store, llm,
            llm_light,        # NEW in v6
            embedding,
            ReasoningBankConfig(
                retrieval_k=config.retrieval_k,
                mmr_lambda=config.mmr_lambda,
                distillation_threshold=config.distillation_threshold,
            ),
        )
        pattern_learner = PatternLearner(
            agent_id, pattern_store, embedding,
            llm_light,        # NEW in v6
            PatternLearnerConfig(
                learning_rate=config.pattern_learning_rate,
                habit_usage_threshold=config.habit_usage_threshold,
                habit_success_threshold=config.habit_success_threshold,
            ),
        )
        promotion = PromotionEngine(
            vector_store, graph, embedding,
            llm_light,        # NEW in v6
        )

        instance = cls(
            agent_id=agent_id,
            working_memory=working,
            static_memory=static,
            dynamic_memory=dynamic,
            procedural_memory=procedural,
            priming_memory=priming,
            memory_extractor=None,
            reasoning_bank=reasoning,
            graph_store=graph,
            pattern_learner=pattern_learner,
            promotion_engine=promotion,
            gc=None,
            embedding_engine=embedding,
            llm_engine=llm,
            llm_light=llm_light,
            vector_store=vector_store,
        )
        instance.memory_extractor = MemoryExtractor(
            llm, llm_light, embedding, instance    # llm_light NEW in v6
        )
        instance._gc = MemoryGarbageCollector(instance, promotion)
        return instance

    # ── HIGH-LEVEL API (unchanged from v5) ──

    async def remember(
        self, content: str, container: str, memory_type: MemoryType = MemoryType.DYNAMIC
    ) -> MemoryUnit:
        match memory_type:
            case MemoryType.STATIC:
                fact = ExtractedFact(text=content, confidence=1.0, is_permanent=True)
                return await self.static_memory.add(fact, container)
            case MemoryType.DYNAMIC:
                fact = ExtractedFact(text=content, confidence=1.0)
                return await self.dynamic_memory.add(fact, container)
            case _:
                raise ValueError(f"Use specific tier API for {memory_type}")

    async def recall(
        self, query: str, container: str, top_k: int = 10, include_graph: bool = True
    ) -> list[MemoryUnit]:
        results = []
        static_results = await self.static_memory.search(query, container, top_k)
        for mem in static_results:
            results.append((mem, 1.5))
        dynamic_results = await self.dynamic_memory.search(query, container, top_k)
        for mem in dynamic_results:
            results.append((mem, 1.0))
        if include_graph:
            graph_results = await self.graph_store.search(query, container, top_k)
            for node_data in graph_results:
                results.append((node_data, 0.8))
        results.sort(key=lambda x: x[1], reverse=True)
        seen = set()
        final = []
        for mem, _ in results:
            key = getattr(mem, "id", id(mem))
            if key not in seen:
                seen.add(key)
                final.append(mem)
            if len(final) >= top_k:
                break
        return final

    async def search(
        self, query: str, agent_id: str, container: str, top_k: int = 5
    ) -> list[MemoryUnit]:
        embedding = await self._embedding.embed(query)
        return await self._vector_store.search(
            embedding=embedding, container=container, top_k=top_k
        )

    async def extract_from_conversation(
        self, messages: list[dict], container: str,
        mode: ExtractionMode = ExtractionMode.AGENT,
    ) -> ExtractionResult:
        return await self.memory_extractor.extract(
            messages=messages,
            agent_id=self._agent_id,
            container=container,
            mode=mode,
        )

    async def process_trajectory(self, trajectory: Trajectory) -> dict:
        verdict = await self.reasoning_bank.judge(trajectory)
        distilled = await self.reasoning_bank.distill(trajectory, verdict)
        pattern = await self.pattern_learner.extract_pattern(trajectory)

        habit = None
        if pattern:
            habit = await self.pattern_learner.check_habit_formation(pattern)
            if habit:
                await self.procedural_memory.add_habit(habit)

        signal = 1.0 if trajectory.outcome == "success" else -0.5
        await self.priming_memory.update_state(
            stimulus=f"Task {trajectory.task_id}: {trajectory.outcome}",
            signal=signal,
            source="task_completion",
        )

        return {
            "verdict": verdict,
            "distilled": distilled,
            "pattern": pattern,
            "habit": habit,
        }

    async def get_active_habits(self, context: str) -> list[Habit]:
        return await self.procedural_memory.get_matching_habits(context)

    async def get_priming_prompt(self) -> str:
        return await self.priming_memory.generate_priming_prompt()

    async def run_promotions(self) -> list[MemoryPromotionEvent]:
        return await self.promotion_engine.run_promotions(self._agent_id)

    async def demote(self, memory_id: str, reason: str) -> Optional[MemoryUnit]:
        return await self.promotion_engine.demote(memory_id, reason)

    async def get_recent_promotions(self) -> list[MemoryPromotionEvent]:
        return await self.promotion_engine.get_recent_promotions(self._agent_id)

    async def get_summary(self) -> MemorySummaryProjection:
        static_facts = await self.static_memory.get_all("")
        dynamic_facts = await self.dynamic_memory.get_recent("", days=7)
        habits = await self.procedural_memory.get_active()
        priming = await self.priming_memory.get_current_state()
        promotions = await self.get_recent_promotions()

        return MemorySummaryProjection(
            agent_id=self._agent_id,
            static_fact_count=len(static_facts),
            dynamic_fact_count=len(dynamic_facts),
            active_habits=[h.action for h in habits],
            current_state=priming,
            recent_learnings=[m.content for m in dynamic_facts[:5]],
            recent_promotions=[f"{p.from_type}→{p.to_type}: {p.reason}" for p in (promotions or [])],
        )

    async def gc(self) -> GCResult:
        return await self._gc.run()
```

---

## 8. Arceus Adapter Implementations

### 8.1 Memory Scope Adapter

```python
# arceus/packages/core/memory_scope.py

class ArceusMemoryScope:
    """
    Maps Arceus domain hierarchy to Hippocampus container tags.

    Hippocampus doesn't know about startups/employees/tasks.
    This adapter translates Arceus's scope rules into container strings.
    """

    @staticmethod
    def startup_container(startup_id: str) -> str:
        return f"startup:{startup_id}"

    @staticmethod
    def employee_container(startup_id: str, employee_id: str) -> str:
        return f"startup:{startup_id}:emp:{employee_id}"

    @staticmethod
    def task_container(startup_id: str, task_id: str) -> str:
        return f"startup:{startup_id}:task:{task_id}"

    @staticmethod
    def sub_agent_container(startup_id: str, task_id: str, agent_id: str) -> str:
        return f"startup:{startup_id}:task:{task_id}:sub:{agent_id}"

    async def get_memories_for_agent(
        self,
        hippocampus: Hippocampus,
        query: str,
        startup_id: str,
        employee_id: str,
        task_id: Optional[str] = None,
        include_shared: bool = True,
    ) -> list[MemoryUnit]:
        """Retrieve with Arceus-specific scope rules."""
        results = []

        # Startup-level shared memories
        if include_shared:
            results += await hippocampus.recall(
                query, self.startup_container(startup_id)
            )

        # Employee's personal memories
        results += await hippocampus.recall(
            query, self.employee_container(startup_id, employee_id)
        )

        # Task-specific memories
        if task_id:
            results += await hippocampus.recall(
                query, self.task_container(startup_id, task_id)
            )

        # Deduplicate (static > dynamic > task-scoped)
        return self._deduplicate_by_priority(results)

    def _deduplicate_by_priority(self, results: list[MemoryUnit]) -> list[MemoryUnit]:
        """Deduplicate by content, preferring higher-tier memories."""
        seen_content = {}
        priority = {MemoryType.STATIC: 3, MemoryType.DYNAMIC: 2, MemoryType.WORKING: 1}
        for mem in results:
            key = mem.content[:100]  # Rough dedup key
            existing_priority = priority.get(seen_content.get(key, {}).get("type"), 0)
            current_priority = priority.get(mem.memory_type, 0)
            if current_priority > existing_priority:
                seen_content[key] = {"mem": mem, "type": mem.memory_type}
        return [v["mem"] for v in seen_content.values()]
```

### 8.2 Profile Engine Adapter

```python
# arceus/packages/core/profile_engine.py

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
    This is Arceus-domain logic — it knows about Employee roles.
    """

    async def generate_profile(
        self, employee, scope: ArceusMemoryScope
    ) -> EmployeeProfile:
        hippo = employee.hippocampus
        container = scope.employee_container(
            employee.startup_id, employee.agent_id
        )

        static_facts = await hippo.static_memory.get_all(container)
        dynamic_facts = await hippo.dynamic_memory.get_recent(container, days=7)
        habits = await hippo.procedural_memory.get_active()
        priming = await hippo.priming_memory.get_current_state()

        return EmployeeProfile(
            role=employee.employee_role,
            core_knowledge=static_facts,
            current_context=dynamic_facts,
            habits=habits,
            state=priming,
        )
```

### 8.3 Delegation Memory Manager

```python
# arceus/packages/core/delegation_memory.py

class DelegationMemoryManager:
    """
    Handles memory context injection during Employee-to-Employee delegation.
    Arceus-specific: knows about delegation authority and org hierarchy.
    """

    async def prepare_delegation_context(
        self,
        from_employee,
        to_employee,
        task,
        scope: ArceusMemoryScope,
    ) -> list[MemoryUnit]:
        """
        Select relevant memories from delegator's Hippocampus
        to share with the delegatee's task scope.
        """
        hippo = from_employee.hippocampus
        query = f"{task.title} {task.description}"
        container = scope.employee_container(
            from_employee.startup_id, from_employee.agent_id
        )

        # Use ReasoningBank for top-k retrieval
        relevant = await hippo.reasoning_bank.retrieve(query, container, top_k=10)

        # Copy memories into task-scoped container (not reference!)
        task_container = scope.task_container(
            from_employee.startup_id, task.task_id
        )
        for result in relevant:
            copied = MemoryUnit(
                agent_id=to_employee.agent_id,
                content=result.memory.content,
                embedding=result.memory.embedding,
                memory_type=MemoryType.DYNAMIC,  # Delegated context is always dynamic
                confidence=result.memory.confidence,
                container=task_container,
                source_type="delegation",
                source_id=from_employee.agent_id,
                provenance=f"Delegated from {from_employee.agent_id}",
                metadata={"delegated_from": from_employee.agent_id},
            )
            await to_employee.hippocampus._vector_store.upsert(copied)

        return [r.memory for r in relevant]

    async def internalize_delegation_result(
        self,
        delegator,
        result,
        scope: ArceusMemoryScope,
    ) -> None:
        """
        After delegation completes, internalize verified learnings
        into the delegator's personal or startup-shared memory.
        """
        if result.quality >= 0.6:
            container = scope.employee_container(
                delegator.startup_id, delegator.agent_id
            )
            for learning in result.learnings:
                fact = ExtractedFact(
                    text=learning,
                    confidence=result.quality,
                    is_permanent=result.quality >= 0.9,
                )
                if fact.is_permanent:
                    await delegator.hippocampus.static_memory.add(fact, container)
                else:
                    await delegator.hippocampus.dynamic_memory.add(fact, container)
```

### 8.4 Memory Projections Adapter

```python
# arceus/packages/core/memory_projections.py

class ArceusMemoryProjections:
    """
    Dashboard-facing projection layer.
    Generates typed views for the board UI without exposing raw memory.
    """

    async def get_summary(
        self, hippocampus: Hippocampus, agent_id: str
    ) -> MemorySummaryProjection:
        """Generate memory summary for dashboard."""
        return await hippocampus.get_summary()

    async def get_graph_view(
        self, hippocampus: Hippocampus, query: str, container: str, depth: int = 2
    ) -> GraphMemoryView:
        """Generate graph neighborhood view for dashboard."""
        query_embedding = await hippocampus._embedding.embed(query)
        center = await hippocampus.graph_store.find_similar_node(query_embedding, container=container)
        if not center:
            return GraphMemoryView()

        neighbors = await hippocampus.graph_store._backend.get_neighbors(
            center.id, max_hops=depth
        )

        # Build edge list
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
        self, hippocampus: Hippocampus, agent_id: str
    ) -> list[MemoryPromotionEvent]:
        """Get promotion event stream for dashboard WebSocket."""
        return await hippocampus.get_recent_promotions()
```

---

## 9. Utility Functions

```python
def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def bm25_rerank(query: str, documents: list[str], objects: list) -> list:
    query_terms = set(query.lower().split())
    scored = []
    for doc, obj in zip(documents, objects):
        doc_terms = set(doc.lower().split())
        overlap = len(query_terms & doc_terms)
        score = overlap / (len(query_terms) + 1)
        scored.append((score, obj))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [obj for _, obj in scored]


def serialize(data) -> str:
    import json
    return json.dumps(data, default=str)


def deserialize(data: str):
    import json
    return json.loads(data)
```

---

## 10. LLM Touchpoint Map

Complete inventory of every LLM call in HippoCampus, organized by when they fire.

### During Task Execution (Flow A)

| Step | Component | Method | Model | What It Does |
|------|-----------|--------|-------|-------------|
| 4 | ProceduralMemory | get_matching_habits() | gpt-4o-mini | Evaluates all habit triggers in single batch call |
| 5 | PrimingMemory | generate_priming_prompt() | gpt-4o-mini | Synthesizes disposition from recent events |
| 7a | MemoryExtractor | extract() | gpt-4o | Extracts structured facts from messages |
| 7b | MemoryExtractor | _decide_action() | gpt-4o | Decides ADD/UPDATE/DELETE/NONE per fact |
| 9 | MemoryExtractor | _classify_relation() | gpt-4o-mini | Classifies entity relationship type |
| 10 | PatternLearner | check_habit_formation() | gpt-4o-mini | Names emerging habit trigger + action |

### During Trajectory Processing

| Step | Component | Method | Model | What It Does |
|------|-----------|--------|-------|-------------|
| 1 | ReasoningBank | judge() | gpt-4o | Qualitative trajectory analysis |

### During GC Cycle (Flow E, every 6h)

| Step | Component | Method | Model | What It Does |
|------|-----------|--------|-------|-------------|
| 3b | ReasoningBank | consolidate() | gpt-4o-mini | Verifies contradictions (binary classification) |
| 3c | ReasoningBank | consolidate() | gpt-4o-mini | Synthesizes merged memory text |
| 5b | PromotionEngine | _check_contradiction() | gpt-4o-mini | Verifies contradiction before promotion |
| 5b | PromotionEngine | _generate_promotion_reason() | gpt-4o-mini | Human-readable promotion reason |
| 4a | PatternLearner | _merge_patterns() | gpt-4o-mini | Synthesizes merged pattern description |

### Cost Summary Per Cycle

| Model | Calls per task | Calls per GC | Cost Tier |
|-------|---------------|-------------|-----------|
| GPT-4o | 2-3 (extract + decide + judge) | 0 | High |
| GPT-4o-mini | 2-4 (triggers + priming + relations + habit naming) | 5-15 (contradictions + merges + promotions) | Low |

---

## 11. File Layout

```text
arceus/
├── packages/core/
│   ├── hippocampus/
│   │   ├── __init__.py
│   │   ├── hippocampus.py
│   │   ├── config.py
│   │   ├── types.py
│   │   │
│   │   ├── tiers/
│   │   │   ├── working.py
│   │   │   ├── static.py
│   │   │   ├── dynamic.py
│   │   │   ├── procedural.py
│   │   │   └── priming.py
│   │   │
│   │   ├── engines/
│   │   │   ├── extractor.py
│   │   │   ├── reasoning_bank.py
│   │   │   ├── pattern_learner.py
│   │   │   ├── graph_store.py
│   │   │   ├── gc.py
│   │   │   └── promotion_engine.py
│   │   │
│   │   ├── backends/
│   │   │   ├── protocols.py
│   │   │   ├── in_memory_vector.py            # numpy + cosine similarity
│   │   │   ├── neo4j.py
│   │   │   ├── dict_cache.py                  # MVP working memory (no Redis)
│   │   │   ├── sqlite_relational.py           # SQLite via aiosqlite
│   │   │   ├── sentence_transformers_embedding.py  # Local, no API
│   │   │   ├── azure_openai_llm.py        # GPT-4o implementation
│   │   │   ├── azure_openai_llm_light.py  # GPT-4o-mini implementation
│   │   │   └── factory.py
│   │   │
│   │   ├── prompts/
│   │   │   ├── extraction_agent.txt
│   │   │   ├── extraction_sub_agent.txt
│   │   │   ├── extraction_meeting.txt
│   │   │   ├── memory_action_decision.txt
│   │   │   ├── contradiction_check.txt     # NEW in v6
│   │   │   ├── memory_merge.txt            # NEW in v6
│   │   │   ├── habit_naming.txt            # NEW in v6
│   │   │   ├── pattern_merge.txt           # NEW in v6
│   │   │   ├── priming_generation.txt      # NEW in v6
│   │   │   ├── relationship_classify.txt   # NEW in v6
│   │   │   ├── trigger_evaluation.txt      # NEW in v6
│   │   │   └── promotion_reason.txt        # NEW in v6
│   │   │
│   │   └── utils/
│   │       ├── similarity.py
│   │       └── serialization.py
│   │
│   ├── memory_scope.py
│   ├── delegation_memory.py
│   ├── profile_engine.py
│   └── memory_projections.py
│
└── tests/
    ├── hippocampus/
    │   ├── unit/
    │   └── integration/
    └── adapters/
```

---

## 12. Boundary Contracts

```python
# ── KERNEL EXPORTS ──

class HippocampusKernel(Protocol):
    async def remember(self, content, container, memory_type) -> MemoryUnit: ...
    async def recall(self, query, container, top_k, include_graph) -> list[MemoryUnit]: ...
    async def extract_from_messages(self, messages, container, mode) -> ExtractionResult: ...
    async def process_trajectory(self, trajectory) -> dict: ...
    async def get_active_habits(self, context) -> list[Habit]: ...
    async def get_priming_prompt(self) -> str: ...
    async def gc(self) -> GCResult: ...
    async def get_graph_neighborhood(self, query, container, depth) -> GraphMemoryView: ...
    async def run_promotions(self) -> list[MemoryPromotionEvent]: ...
    async def demote(self, memory_id, reason) -> MemoryUnit: ...
    async def get_recent_promotions(self) -> list[MemoryPromotionEvent]: ...
    async def get_summary(self) -> MemorySummaryProjection: ...


# ── ARCEUS ADAPTERS ──

class MemoryScopeAdapter(Protocol):
    def startup_container(self, startup_id) -> str: ...
    def employee_container(self, startup_id, employee_id) -> str: ...
    def task_container(self, startup_id, task_id) -> str: ...

class DelegationContextAdapter(Protocol):
    async def prepare_delegation_context(self, from_emp, to_emp, task) -> list[MemoryUnit]: ...
    async def internalize_delegation_result(self, delegator, result) -> None: ...

class ProfileProjectionAdapter(Protocol):
    async def generate_profile(self, employee) -> "EmployeeProfile": ...

class MemoryProjectionAdapter(Protocol):
    async def get_summary(self, agent_id) -> MemorySummaryProjection: ...
    async def get_graph_view(self, agent_id, query) -> GraphMemoryView: ...
    async def get_promotion_stream(self, startup_id) -> list[MemoryPromotionEvent]: ...
```

---

## 13. Implementation Phases (Aligned to Arceus)

### Phase 0: Schema + Contracts (Week 1)
- `types.py`, `protocols.py`, `config.py`, `memory_scope.py`
- SQLite schema (habits, priming, patterns, metadata), Neo4j schema, InMemoryVectorStore, DictCacheStore
- **Exit**: canonical MemoryUnit, canonical scope format

### Phase 1: Core Tiers + Retrieval (Week 2-3)
- WorkingMemory, StaticMemory, DynamicMemory
- Retrieval with tier/scope boost + MMR
- `hippocampus.py` with `create()`, `remember()`, `recall()`
- **Exit**: agent recalls scoped memories, no cross-scope leakage

### Phase 2: Extraction + Graph + Versioning (Week 4-5)
- MemoryExtractor (3 modes) with all prompts
- LLM relationship classification (gpt-4o-mini)
- Neo4j entity extraction + version chains
- **Exit**: task/meeting outputs → structured memories with version history

### Phase 3: Delegation + Profiles + Projections (Week 6-7)
- Adapters: delegation, profiles, projections
- PromotionEngine with LLM contradiction check + reason generation
- Dashboard API endpoints
- **Exit**: delegation safe, promotions fire with LLM guardrails, dashboard shows summaries

### Phase 4: Adaptive Intelligence (Week 8-9)
- ReasoningBank (4-step with LLM consolidation)
- PatternLearner (with LLM naming + merge)
- ProceduralMemory (LLM-only trigger eval)
- PrimingMemory (LLM disposition generation)
- GarbageCollector
- **Exit**: patterns/habits emerge with proper names, stale memory pruned

### Phase 5: Dashboard Integration (Week 10)
- Memory explorer, graph visualization
- Pattern cards (LLM-named)
- Promotion stream with human-readable reasons
- **Exit**: board inspects agent beliefs via projections

---

## 14. Design Decisions (Locked)

| # | Decision | Status |
|---|----------|--------|
| 1 | Inside Arceus for MVP | LOCKED |
| 2 | Kernel/adapter split | LOCKED |
| 3 | Immutable data classes (frozen=True) | LOCKED |
| 4 | Protocol-based backends | LOCKED |
| 5 | Neo4j for graph | LOCKED |
| 6 | LLM decides memory actions (mem0 pattern) | LOCKED |
| 7 | Extraction per task + per meeting | LOCKED |
| 8 | Fully automatic promotions | LOCKED |
| 9 | all-MiniLM-L6-v2 sentence-transformers (free, local, 384d) | LOCKED |
| 10 | Skills covered separately as part of memory evolution | LOCKED |
| 11 | Cross-startup memory deferred | LOCKED |
| 12 | Visibility + provenance on every MemoryUnit | LOCKED |
| 13 | Dashboard projections as typed contracts | LOCKED |
| 14 | Soft deletes everywhere | LOCKED |
| 15 | GC checks promotions before pruning | LOCKED |
| 16 | Two-tier LLM: gpt-4o for reasoning, gpt-4o-mini for classification/naming (Azure OpenAI) | LOCKED (NEW) |
| 17 | LLM-only trigger evaluation (batch call) | LOCKED (REVISED) |
| 18 | LLM contradiction verification before promotion | LOCKED (NEW) |
| 19 | SQLite for relational storage (MVP) — migrate to PostgreSQL later | LOCKED (NEW) |
| 20 | InMemoryVectorStore for vectors (MVP) — migrate to pgvector later | LOCKED (NEW) |
| 21 | DictCacheStore for working memory (MVP) — migrate to Redis later | LOCKED (NEW) |

---

## 15. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Memory bloat | Slow retrieval | Tiering, decay, dedup, GC every 6h |
| Scope leakage | Privacy failure | Strict container tags, copy-based delegation |
| Over-extraction | Noisy low-value memory | Batch extraction, LLM action gating |
| Neo4j ops overhead | Infra complexity | Neo4j Aura for prod, Docker for dev |
| **InMemoryVectorStore data loss** | **All vectors lost on restart** | **Persist to disk via pickle/numpy save on shutdown, reload on startup. Migrate to pgvector before production.** |
| **SQLite concurrency** | **Write locks under concurrent agents** | **WAL mode + connection pooling. Single-writer is fine for MVP. Migrate to PostgreSQL for multi-agent prod.** |
| **In-memory vector scale** | **RAM grows with memory count** | **Fine for MVP (<100k memories). Monitor RSS. Migrate to pgvector when approaching limits.** |
| LLM extraction cost | Budget drain | Per task not per turn, gpt-4o only where needed |
| Bad auto-promotion | Wrong fact permanent | LLM contradiction check, threshold stacking, probation, board override |
| Graph query latency | Slow dashboard | Container partitioning, 2-hop max, indexed properties |
| **GPT-4o-mini call volume** | **Cost creep from new LLM touchpoints** | **8 new gpt-4o-mini calls are all lightweight. Trigger eval sends all habits in one batch call. Monitor cost per GC cycle.** |
| **Local embedding model memory** | **CPU/memory pressure on host** | **all-MiniLM-L6-v2 is ~80MB. Load once at startup, share across agents. Use `asyncio.to_thread()` for non-blocking inference.** |
| **Azure OpenAI quota/availability** | **API failures, rate limits** | **Retry with exponential backoff. Configure multiple Azure deployments across regions if needed.** |
| **Cosine threshold calibration** | **384d embeddings may behave differently than 1536d** | **Post-migration: re-tune thresholds (0.5, 0.7, 0.8, 0.9, 0.95) with the new embedding model.** |
| **LLM hallucination in naming** | **Bad habit names** | **Names are display-only, not used in retrieval logic. Bad names are cosmetic, not functional. Board can see and correct.** |

---

## 16. Cross-Startup Memory (Post-MVP Concept)

### What It Is

Cross-startup memory is **knowledge transfer between different startups** created by the same user (or across the Arceus platform).

The idea: if Startup A's CTO learned that "Stripe webhook verification is critical for payment reliability," and Startup B is now building payments, that learning should be available to Startup B without re-discovering it.

### Why It Matters

- Users run multiple startups on Arceus
- Agent learnings in Startup A are wasted if siloed
- Patterns like "always validate webhook signatures" are universal truths, not startup-specific
- Learnings like "proficient at Next.js auth" transfer across projects

### The Problem

Memory is scoped to `startup:{id}`. Cross-startup sharing breaks isolation guarantees and risks:
- **Data leakage**: Startup A's proprietary strategy leaking to Startup B
- **Context pollution**: Startup A's domain-specific decisions being applied incorrectly in Startup B
- **Privacy**: different startups may have different users/viewers

### Preliminary Design (Phase 6+)

```
User Account
  └── Cross-Startup Knowledge Base (NEW layer)
       │
       ├── Universal Patterns
       │   "Always validate webhook signatures"
       │   "Use parameterized queries for SQL"
       │   → applicable everywhere
       │
       ├── Domain Patterns
       │   tagged by domain: "fintech", "saas", "marketplace"
       │   → applicable when domain matches
       │
       └── NOT transferred:
           - Startup-specific decisions ("We use MongoDB" is Startup A only)
           - Task-specific context
           - Employee-private memories
           - Budget/financial data

Startup A                          Startup B
  └── HippoCampus                    └── HippoCampus
       │                                  │
       └── PROMOTE to cross-startup       └── IMPORT from cross-startup
           (user/board approval)              (filtered by domain + tech match)
```

**Safety rules**:
1. Only **patterns** are eligible for cross-startup promotion (not raw memories)
2. Cross-startup promotion requires **board (user) approval** (unlike intra-agent promotions which are automatic)
3. Importing startup filters by **domain tag** and **tech stack overlap**
4. Imported knowledge enters as **dynamic memory** (not static) — must prove itself
5. Each startup's **proprietary decisions** are never exported
6. **Audit trail**: every cross-startup transfer is logged with source/destination

**Implementation approach**:
- New scope layer: `user:{user_id}:universal`
- PatternLearner gains `promote_to_universal()` method
- New `CrossStartupRetriever` that queries universal scope during task context loading
- Board dashboard gains "Knowledge Library" view showing universal patterns

This is purely post-MVP. The kernel/adapter split means the retrieval system already supports multiple containers — adding a `universal` container is mechanically simple once the policy layer is designed.

---

## SESSION_ID (for /ccg:execute use)
- CODEX_SESSION: N/A
- GEMINI_SESSION: N/A
