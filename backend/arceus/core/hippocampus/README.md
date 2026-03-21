# Hippocampus — Adaptive Memory System for Arceus Agents

Hippocampus is the memory kernel that gives every Arceus AI agent persistent, evolving knowledge. Named after the brain region responsible for forming and retrieving memories, it provides five tiers of memory, six processing engines, and a protocol-based backend architecture that separates memory logic from storage infrastructure.

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────────────┐
                        │                  ARCEUS SYSTEM                   │
                        │                                                 │
                        │   Agent (CTO, PM, Engineer, ...)                │
                        │     │                                           │
                        │     ▼                                           │
                        │   ArceusMemoryScope        ←── container naming │
                        │     │  (memory_scope.py)        & multi-scope   │
                        │     │                           retrieval       │
                        │     ▼                                           │
                        │   Hippocampus              ←── one per agent    │
                        │     │                                           │
                        │     ├── DelegationMemoryManager                 │
                        │     │     (delegation_memory.py)                │
                        │     ├── ArceusProfileEngine                     │
                        │     │     (profile_engine.py)                   │
                        │     └── MemoryProjections                       │
                        │           (memory_projections.py)               │
                        └─────────────────────────────────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
              ▼                           ▼                           ▼
   ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
   │   MEMORY TIERS   │      │     ENGINES      │      │    BACKENDS      │
   │                  │      │                  │      │   (protocols)    │
   │ 1. Working       │      │ Extractor        │      │ VectorStore      │
   │ 2. Static        │      │ PromotionEngine  │      │ RelationalStore  │
   │ 3. Dynamic       │      │ ReasoningBank    │      │ GraphStoreBackend│
   │ 4. Procedural    │      │ PatternLearner   │      │ EmbeddingEngine  │
   │ 5. Priming       │      │ GarbageCollector │      │ LLMEngine        │
   │                  │      │ GraphStore       │      │ WorkingMemoryBknd│
   └──────────────────┘      └──────────────────┘      │ PatternStore     │
                                                       └──────────────────┘
```

---

## Memory Tiers

Each tier serves a different role in agent cognition. Together they model how an agent remembers, forgets, and learns.

### Tier 1: Working Memory (`tiers/working.py`)

Short-lived context for the task currently in progress. Think of it as the agent's scratchpad.

- **Storage**: key-value cache (dict in test, Redis in production)
- **Lifetime**: TTL-based, typically minutes to hours
- **Use case**: conversation buffer, in-flight task state, intermediate results
- **Key methods**: `set_context()`, `get_context()`, `append_conversation()`, `clear_task()`

### Tier 2: Static Memory (`tiers/static.py`)

Permanent, high-confidence facts. These are things the agent "knows for sure" — they don't decay.

- **Storage**: vector store with graph provenance
- **Lifetime**: indefinite (version chains track changes)
- **Use case**: "The company uses microservices", "Jane is the CTO", architectural decisions
- **Behavior**: updates create a new version and soft-delete the old one, maintaining a version chain in the graph
- **Key methods**: `add()`, `update()`, `search()`

### Tier 3: Dynamic Memory (`tiers/dynamic.py`)

Contextual, time-decaying observations. Relevance fades unless the memory keeps getting accessed.

- **Storage**: vector store with decay scoring
- **Lifetime**: half-life decay (default 30 days), pruned below threshold
- **Use case**: "The team is working on auth migration this sprint", "Customer X complained about latency"
- **Behavior**: `relevance_score` decays exponentially; each access resets the clock. High-value memories can be promoted to Static.
- **Key methods**: `add()`, `search()`, `get_recent()`

### Tier 4: Procedural Memory (`tiers/procedural.py`)

Learned habits — behavioral patterns the agent has discovered work well.

- **Storage**: relational store (SQLite / PostgreSQL)
- **Lifetime**: active while confidence > 0.2, deactivated otherwise
- **Use case**: "When reviewing PRs, always check for SQL injection", "Start architecture discussions with a diagram"
- **Formation**: automatic (from repeated patterns via PatternLearner) or explicit (from LLM extraction)
- **Key methods**: `add_habit()`, `get_matching_habits()`, `record_usage()`

### Tier 5: Priming Memory (`tiers/priming.py`)

Agent disposition and emotional context. Influences tone and approach.

- **Storage**: relational store (single state record per agent)
- **Lifetime**: continuously updated, no expiry
- **State**: `confidence` (0-1), `caution` (0-1), `morale` (0-1), plus recent events
- **Use case**: after a failed deployment, the agent becomes more cautious; after a string of successes, more confident
- **Key methods**: `update_state()`, `get_current_state()`, `generate_priming_prompt()`

---

## Engines

Engines perform intelligent operations on memories — extraction, consolidation, promotion, and cleanup.

### MemoryExtractor (`engines/extractor.py`)

LLM-driven fact extraction from conversations and meetings.

```
Messages → [LLM: extract facts] → For each fact:
    → [LLM: decide ADD/UPDATE/DELETE/NONE vs existing memories]
    → Route to correct tier (Static / Dynamic / Procedural)
    → Extract entities + relationships → Graph
```

- Uses full LLM (gpt-4.1) for extraction, lightweight LLM (gpt-4.1-mini) for classification
- Supports modes: `AGENT`, `SUB_AGENT`, `CONVERSATION`, `MEETING`
- Creates graph entities and edges for extracted relationships

### ReasoningBank (`engines/reasoning_bank.py`)

Four-step pipeline for learning from agent actions:

1. **RETRIEVE** — MMR-ranked memory retrieval (cosine + diversity balancing)
2. **JUDGE** — evaluate trajectory quality (reward-weighted scoring + LLM analysis)
3. **DISTILL** — extract successful strategies into distilled memories
4. **CONSOLIDATE** — dedup (>95% similar), detect contradictions (LLM-verified), merge related facts (LLM-synthesized), prune stale memories

### PromotionEngine (`engines/promotion_engine.py`)

Automatic lifecycle management for memories:

- **Promotion**: Dynamic → Static when `access_count >= 10`, `confidence >= 0.8`, `age >= 14 days`
- **Contradiction check**: LLM verifies no semantic conflict with existing static facts before promoting
- **Demotion**: Static → Dynamic when unused for 60+ days or manually triggered
- **Probation**: newly promoted memories have a 7-day probation period
- **Reason generation**: LLM produces human-readable promotion reasons for the dashboard

### PatternLearner (`engines/pattern_learner.py`)

Discovers behavioral patterns from successful trajectories:

- **Extract**: create or evolve patterns from trajectory outcomes
- **Habit formation**: when a pattern reaches 10+ uses and 80%+ success rate, LLM generates a trigger/action pair → saved as a Procedural Habit
- **Consolidation**: merge similar patterns, prune low-performers (bottom 20th percentile)
- **Clustering**: assigns patterns to clusters (production: k-means)

### GraphStore (`engines/graph_store.py`)

Knowledge graph facade over the graph backend:

- **Entity matching**: embedding-based similarity search (threshold 0.7)
- **Node merging**: increment mention count, merge metadata
- **Edge creation**: by ID or by name (embedding lookup)
- **Version chains**: `UPDATES` edges link old → new memory versions
- **Graph search**: vector seed → neighbor expansion (configurable hops) → cosine ranking

### GarbageCollector (`engines/gc.py`)

Periodic cleanup:

- Remove expired working memory entries
- Prune decayed dynamic memories below threshold
- Demote probation-failed static memories
- Soft-delete with reason tracking for auditability

---

## Backend Protocols

All storage is accessed through Python `Protocol` classes (`backends/protocols.py`). This means every backend can be swapped independently — test backends in development, production backends in deployment.

| Protocol | Test Backend | Production Target |
|----------|-------------|-------------------|
| `VectorStore` | `InMemoryVectorStore` | Qdrant / pgvector / Pinecone |
| `RelationalStore` | `SQLiteRelationalStore` | PostgreSQL |
| `GraphStoreBackend` | `InMemoryGraphStoreBackend` | `Neo4jGraphStoreBackend` |
| `WorkingMemoryBackend` | `DictCacheStore` | Redis / Valkey |
| `EmbeddingEngine` | `MockEmbeddingEngine` | `SentenceTransformerEmbeddingEngine` |
| `LLMEngine` | `NoopLLMEngine` | `AzureOpenAILLMEngine` |
| `PatternStore` | `InMemoryPatternStore` | `SQLitePatternStore` |

Backend selection is handled by factory functions in `backends/factory.py`, driven by `HippocampusConfig`.

---

## Arceus Integration Layer

Hippocampus is a general-purpose memory system. These adapter modules connect it to Arceus-specific concepts.

### ArceusMemoryScope (`core/memory_scope.py`)

Maps Arceus domain concepts to Hippocampus containers:

```
startup:acme                        → shared startup knowledge
startup:acme:emp:jane-cto           → Jane's private memories
startup:acme:task:auth-migration    → task-scoped context
startup:acme:task:auth-migration:sub:researcher → sub-agent scope
```

`get_memories_for_agent()` searches all applicable scopes (startup + employee + task) and deduplicates by priority (Static > Dynamic > Working).

### DelegationMemoryManager (`core/delegation_memory.py`)

When an agent delegates a task to a sub-agent, this manager copies relevant memories from the parent's Hippocampus to the child's, scoped to the new task container.

### ArceusProfileEngine (`core/profile_engine.py`)

Generates agent personality profiles by aggregating:
- Static facts (permanent knowledge)
- Dynamic facts (recent observations)
- Active habits (behavioral patterns)
- Priming state (current disposition)

Used to inject agent context into LLM system prompts.

### MemoryProjections (`core/memory_projections.py`)

Dashboard-oriented views of agent memory:
- `get_memory_explorer()` — paginated memory browser with type/container filters
- `get_graph_view()` — entity-relationship visualization data
- `get_version_history()` — memory version chain timeline
- `get_pattern_cards()` — pattern summaries with success rates

---

## Data Flow: How It All Connects

### Flow A: Agent Completes a Task

```
1. Task completes → trajectory recorded
2. Hippocampus.process_trajectory():
   a. ReasoningBank.judge()       → quality score + LLM analysis
   b. ReasoningBank.distill()     → save successful strategy
   c. PatternLearner.extract()    → create/evolve pattern
   d. PatternLearner.check_habit()→ form habit if threshold met
   e. PrimingMemory.update_state()→ adjust agent disposition
```

### Flow B: Agent Processes a Conversation

```
1. Conversation ends → messages captured
2. Hippocampus.extract_from_conversation():
   a. LLM extracts structured facts
   b. For each fact: search existing → LLM decides action
   c. ADD/UPDATE/DELETE routed to correct tier
   d. Entities + relationships → GraphStore
```

### Flow C: Agent Needs Context

```
1. Agent starts new task → needs relevant memory
2. ArceusMemoryScope.get_memories_for_agent():
   a. Search startup container (shared knowledge)
   b. Search employee container (private knowledge)
   c. Search task container (task-specific)
   d. Deduplicate by priority
3. Hippocampus.recall():
   a. Static + Dynamic vector search
   b. MMR reranking (relevance × diversity)
   c. Tier boosting (Static 1.5×, Procedural 1.2×)
   d. Task scope boosting (1.3× for task containers)
   e. Graph expansion for entity context
   f. Usage tracking (updates access counts)
```

### Flow D: Background Maintenance

```
Periodic (every ~6 hours):
1. Hippocampus.run_promotions()  → promote qualifying memories
2. Hippocampus.run_gc()          → clean expired/decayed memories
3. ReasoningBank.consolidate()   → dedup, resolve contradictions, merge
4. PatternLearner.consolidate()  → merge similar patterns, prune weak ones
```

---

## Container Scoping & Visibility

Memories are scoped by two orthogonal dimensions:

**Container** — *where* the memory belongs logically:
- `startup:{id}` — shared org knowledge
- `startup:{id}:emp:{employee_id}` — agent-private
- `startup:{id}:task:{task_id}` — task-specific

**Visibility** — *who* can retrieve it:
- `PRIVATE` — only the owning agent
- `TASK_SCOPED` — agents working on the same task
- `STARTUP_SHARED` — all agents in the startup
- `BOARD_VISIBLE` — visible to board/oversight

The `InMemoryVectorStore` implements visibility-aware retrieval via `_is_accessible()`:
- Own agent's memories are always accessible
- Non-PRIVATE memories are accessible to other agents in the same scope
- PRIVATE cross-agent access is blocked

---

## Configuration

All tuning knobs live in `HippocampusConfig` (`config.py`):

```python
config = HippocampusConfig(
    # Backends
    vector_store_backend="in_memory",     # or future: "qdrant", "pgvector"
    graph_store_backend="neo4j",          # or "in_memory" for tests
    cache_backend="dict",                 # or future: "redis"
    relational_backend="sqlite",          # or future: "postgresql"

    # Memory tuning
    dynamic_memory_half_life_days=30.0,   # how fast dynamic memories decay
    decay_threshold=0.1,                  # below this → eligible for GC

    # Retrieval
    mmr_lambda=0.7,                       # relevance vs diversity tradeoff
    static_boost=1.5,                     # static memories ranked higher
    task_scope_boost=1.3,                 # task-scoped memories ranked higher

    # LLM
    extraction_model="gpt-4.1",           # full model for extraction
    lightweight_model="gpt-4.1-mini",     # fast model for classification

    # Embeddings
    embedding_model="all-MiniLM-L6-v2",  # local sentence-transformers
    embedding_dimensions=384,
)
```

---

## Instantiation

```python
from arceus.core.hippocampus import Hippocampus, HippocampusConfig

config = HippocampusConfig(
    graph_store_backend="in_memory",  # no Neo4j needed for dev
    extraction_model="noop",          # no Azure OpenAI needed for dev
    lightweight_model="noop",
    embedding_model="simple",         # deterministic mock embeddings
)

hippocampus = await Hippocampus.create(agent_id="cto-1", config=config)

# Write
await hippocampus.remember("We use PostgreSQL for all services", container="startup:acme")

# Read
results = await hippocampus.recall("database technology", container="startup:acme")

# Extract from conversation
result = await hippocampus.extract_from_conversation(
    messages=[{"role": "user", "content": "We decided to use Redis for caching"}],
    container="startup:acme",
)

# Cleanup
await hippocampus.close()
```

---

## Directory Structure

```
arceus/core/hippocampus/
├── hippocampus.py           # Main orchestrator class
├── config.py                # HippocampusConfig dataclass
├── types.py                 # All data types (MemoryUnit, Habit, Pattern, etc.)
├── prompts.py               # LLM prompt templates
├── __init__.py              # Public exports
│
├── tiers/                   # Memory tier implementations
│   ├── working.py           # Tier 1: ephemeral cache
│   ├── static.py            # Tier 2: permanent facts
│   ├── dynamic.py           # Tier 3: time-decaying observations
│   ├── procedural.py        # Tier 4: learned habits
│   └── priming.py           # Tier 5: agent disposition
│
├── engines/                 # Processing engines
│   ├── extractor.py         # LLM fact extraction
│   ├── reasoning_bank.py    # Retrieve/Judge/Distill/Consolidate
│   ├── promotion_engine.py  # Dynamic→Static lifecycle
│   ├── pattern_learner.py   # Pattern discovery + habit formation
│   ├── graph_store.py       # Knowledge graph facade
│   └── gc.py                # Garbage collection
│
├── backends/                # Swappable storage implementations
│   ├── protocols.py         # Protocol definitions (7 protocols)
│   ├── factory.py           # Backend creation from config
│   ├── in_memory_vector.py  # Test vector store
│   ├── in_memory_graph.py   # Test graph store
│   ├── in_memory_pattern.py # Test pattern store
│   ├── dict_cache.py        # Test cache store
│   ├── sqlite_relational.py # SQLite relational store
│   ├── sqlite_pattern.py    # SQLite pattern store
│   ├── neo4j_graph.py       # Neo4j graph backend
│   ├── azure_openai_llm.py  # Azure OpenAI LLM backend
│   ├── sentence_transformers_embedding.py  # Local embeddings
│   ├── simple_embedding.py  # Mock embeddings for tests
│   └── noop_llm.py          # No-op LLM for tests
│
└── utils/                   # Shared utilities
    ├── similarity.py        # cosine_similarity, max_marginal_relevance
    ├── time.py              # utc_now()
    └── usage_tracker.py     # Access count tracking

arceus/core/                 # Arceus adapter layer
├── memory_scope.py          # Container naming + multi-scope retrieval
├── delegation_memory.py     # Memory copying on task delegation
├── profile_engine.py        # Agent profile generation
└── memory_projections.py    # Dashboard views
```

---

## Tests

```
tests/hippocampus/           # Hippocampus kernel tests (135 passing)
├── unit/                    # Unit tests for tiers, engines, backends
└── integration/             # Cross-component integration tests

tests/adapters/              # Arceus adapter tests
├── test_delegation_memory.py
├── test_memory_projections.py
└── test_profile_engine.py
```

Run all tests:
```bash
cd backend
uv run pytest tests/hippocampus tests/adapters -v
```
