# Hippocampus Phase 4: Adaptive Intelligence

> **Spec reference**: hippocampus_design_v6.md Phase 4 (Week 8-9)
> **Branch**: `divo/hippocampus-phase1` (continuing)
> **Exit criteria**: Patterns/habits emerge with proper names, stale memory pruned, ReasoningBank consolidates with LLM-verified contradictions
> **Depends on**: Phase 0-3 (all complete)

---

## What Already Exists (Phase 0-3 Foundation)

Phase 4 has more pre-existing scaffolding than any prior phase. Here's what's ready:

| Component | Status | What Exists |
|-----------|--------|-------------|
| **Types** | COMPLETE | `Habit`, `Pattern`, `PatternStatus`, `HabitFormation`, `Trajectory`, `TrajectoryStep`, `TrajectoryVerdict`, `DistilledMemory`, `RetrievalResult`, `ConsolidationResult`, `GCResult` — all frozen dataclasses in `types.py` |
| **PatternStore protocol** | COMPLETE | `protocols.py:87-96` — `insert()`, `update()`, `find_similar()`, `list_all()`, `update_status()` |
| **RelationalStore protocol** | COMPLETE | Habit CRUD (`insert_habit`, `get_habit`, `list_habits`, `update_habit`) + Pattern CRUD + Priming state CRUD |
| **SQLite implementation** | COMPLETE | All habit/pattern/priming_state tables + full CRUD in `sqlite_relational.py` |
| **Config params** | COMPLETE | `gc_interval_hours`, `distillation_threshold`, `pattern_learning_rate`, `habit_usage_threshold`, `habit_success_threshold`, `mmr_lambda`, `retrieval_k` |
| **LLM protocols** | COMPLETE | `LLMEngine.decide()`, `.analyze()`, `.generate()`, `.classify()` — all used by Phase 4 components |
| **PromotionEngine** | COMPLETE | Phase 3 — used by GC Step 5-7 |
| **`max_marginal_relevance()`** | COMPLETE | `utils/similarity.py` — used by ReasoningBank.retrieve() |
| **CONTRADICTION_CHECK_PROMPT** | COMPLETE | Phase 3 — shared with ReasoningBank.consolidate() |
| **`MemoryType.PROCEDURAL` / `.PRIMING`** | COMPLETE | Enum values defined, boost config ready |
| **`utc_now()` / `parse_utc_iso()`** | COMPLETE | Phase 3 refactor standardized datetime handling |

### What Needs to Be Built

| # | Component | File | Type |
|---|-----------|------|------|
| 1 | **ProceduralMemory** | `tiers/procedural.py` | Tier (kernel) |
| 2 | **PrimingMemory** | `tiers/priming.py` | Tier (kernel) |
| 3 | **InMemoryPatternStore** | `backends/in_memory_pattern.py` | Backend (kernel) |
| 4 | **PatternLearner** | `engines/pattern_learner.py` | Engine (kernel) |
| 5 | **ReasoningBank** | `engines/reasoning_bank.py` | Engine (kernel) |
| 6 | **MemoryGarbageCollector** | `engines/gc.py` | Engine (kernel) |
| 7 | **Phase 4 prompts** | `prompts.py` | Shared |
| 8 | **Wire into Hippocampus** | `hippocampus.py` | Integration |
| 9 | **Update ProfileEngine** | `core/profile_engine.py` | Arceus adapter |
| 10 | **Update MemoryProjections** | `core/memory_projections.py` | Arceus adapter |

---

## Step 1: Add Phase 4 Prompts to `prompts.py`

**File**: `backend/arceus/core/hippocampus/prompts.py`

Append these 5 new prompts (CONTRADICTION_CHECK_PROMPT and PROMOTION_REASON_PROMPT already exist from Phase 3):

```python
TRIGGER_EVALUATION_PROMPT = """
You are evaluating which behavioral habits are relevant to the current context.

Current context:
{context}

Active habits:
{triggers}

For each habit (by index), decide if its trigger condition is relevant to the current context.
Return a JSON array of objects: [{{"index": 0, "relevant": true/false}}, ...]

ONLY mark a habit as relevant if the context clearly matches the trigger condition.
""".strip()

PRIMING_GENERATION_PROMPT = """
You are generating a disposition prompt for an AI agent based on its current emotional state.

Current state metrics:
- Confidence: {confidence} (0=uncertain, 1=confident)
- Caution: {caution} (0=reckless, 1=very cautious)
- Morale: {morale} (0=demoralized, 1=energized)

Recent events:
{recent_events}

Generate a 2-3 sentence disposition that:
1. References specific recent events where relevant
2. Adjusts tone based on the metrics (high caution = more careful, low morale = more encouraging)
3. Does NOT mention the numeric values — describe the disposition naturally

The disposition will be injected into the agent's system prompt.
""".strip()

HABIT_NAMING_PROMPT = """
A behavioral pattern has been used frequently with high success and should become a habit.

Domain: {domain}
Strategy: {strategy}
Usage count: {usage_count}
Success rate: {success_rate}

Generate a trigger condition and action for this habit.
Return JSON: {{"trigger": "when X happens...", "action": "always do Y..."}}

The trigger should be specific enough to avoid false positives but general enough to fire
when the pattern is relevant.
""".strip()

PATTERN_MERGE_PROMPT = """
Two similar patterns in the same domain should be merged into one.

Pattern A:
- Description: {description_a}
- Strategy: {strategy_a}

Pattern B:
- Description: {description_b}
- Strategy: {strategy_b}

Synthesize a merged description and strategy that captures the best of both.
Return JSON: {{"description": "...", "strategy": "..."}}
""".strip()

MEMORY_MERGE_PROMPT = """
Two similar memories should be merged into one comprehensive statement.

Memory A: {memory_a}
Memory B: {memory_b}

Write a single merged statement that captures all information from both memories
without being redundant. Keep it concise — one or two sentences.
""".strip()
```

---

## Step 2: InMemoryPatternStore Backend

**New file**: `backend/arceus/core/hippocampus/backends/in_memory_pattern.py`

The `PatternStore` protocol already exists (`protocols.py:87-96`) but has no implementation. The `RelationalStore` has overlapping pattern methods — `PatternStore` wraps it and adds `find_similar()` via embedding search.

```python
"""
InMemoryPatternStore — implements PatternStore protocol.

For tests and local dev. Production uses SQLitePatternStore (wraps RelationalStore).
"""
from __future__ import annotations

from arceus.core.hippocampus.types import Pattern, PatternStatus
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class InMemoryPatternStore:
    """In-memory PatternStore for tests."""

    def __init__(self) -> None:
        self._patterns: dict[str, Pattern] = {}

    async def insert(self, pattern: Pattern) -> None:
        self._patterns[pattern.id] = pattern

    async def update(self, pattern: Pattern) -> None:
        self._patterns[pattern.id] = pattern

    async def find_similar(
        self, embedding: list[float], threshold: float
    ) -> Pattern | None:
        best: Pattern | None = None
        best_sim = -1.0
        for pattern in self._patterns.values():
            if pattern.status != PatternStatus.ACTIVE or not pattern.embedding:
                continue
            sim = cosine_similarity(embedding, pattern.embedding)
            if sim >= threshold and sim > best_sim:
                best = pattern
                best_sim = sim
        return best

    async def list_all(self, agent_id: str) -> list[Pattern]:
        return [p for p in self._patterns.values() if p.agent_id == agent_id]

    async def update_status(
        self, pattern_id: str, status: PatternStatus
    ) -> None:
        existing = self._patterns.get(pattern_id)
        if existing is None:
            return
        # Frozen dataclass — create new instance
        updated = Pattern(
            id=existing.id,
            agent_id=existing.agent_id,
            description=existing.description,
            strategy=existing.strategy,
            embedding=existing.embedding,
            usage_count=existing.usage_count,
            success_rate=existing.success_rate,
            formed_from=existing.formed_from,
            cluster_id=existing.cluster_id,
            status=status,
            domain=existing.domain,
            created_at=existing.created_at,
            updated_at=existing.updated_at,
        )
        self._patterns[pattern_id] = updated
```

Also create **SQLitePatternStore** that wraps `RelationalStore` and adds `find_similar()`:

```python
"""
SQLitePatternStore — PatternStore implementation backed by SQLiteRelationalStore.
"""
from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import RelationalStore
from arceus.core.hippocampus.types import Pattern, PatternStatus
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class SQLitePatternStore:
    """Wraps RelationalStore and adds embedding-based find_similar()."""

    def __init__(self, relational: RelationalStore, agent_id: str) -> None:
        self._relational = relational
        self._agent_id = agent_id

    async def insert(self, pattern: Pattern) -> None:
        await self._relational.insert_pattern(pattern)

    async def update(self, pattern: Pattern) -> None:
        await self._relational.update_pattern(pattern)

    async def find_similar(
        self, embedding: list[float], threshold: float
    ) -> Pattern | None:
        # Load all active patterns and compare embeddings
        # (acceptable for current scale; optimize with vector index later)
        all_patterns = await self._relational.list_patterns(self._agent_id)
        best: Pattern | None = None
        best_sim = -1.0
        for pattern in all_patterns:
            if pattern.status != PatternStatus.ACTIVE or not pattern.embedding:
                continue
            sim = cosine_similarity(embedding, pattern.embedding)
            if sim >= threshold and sim > best_sim:
                best = pattern
                best_sim = sim
        return best

    async def list_all(self, agent_id: str) -> list[Pattern]:
        return await self._relational.list_patterns(agent_id)

    async def update_status(
        self, pattern_id: str, status: PatternStatus
    ) -> None:
        await self._relational.update_pattern_status(pattern_id, status)
```

---

## Step 3: ProceduralMemory Tier

**New file**: `backend/arceus/core/hippocampus/tiers/procedural.py`

```python
"""
ProceduralMemory — Tier 4: Habits and auto-triggered behavior blocks.

Stores behavioral rules the agent has learned to follow automatically.
Injected into system prompt when trigger conditions match.

Trigger evaluation: LLM evaluates all active habit triggers against current
context in a single batch call. No embedding pre-filter.
"""
from __future__ import annotations

import json

from arceus.core.hippocampus.backends.protocols import LLMEngine, RelationalStore
from arceus.core.hippocampus.prompts import TRIGGER_EVALUATION_PROMPT
from arceus.core.hippocampus.types import Habit


class ProceduralMemory:

    def __init__(
        self,
        agent_id: str,
        relational_store: RelationalStore,
        llm_light: LLMEngine,
    ) -> None:
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

        # result is a dict from decide() — extract list if nested
        items = result if isinstance(result, list) else result.get("items", [])
        matching: list[Habit] = []
        for item in items:
            if not isinstance(item, dict):
                continue
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

**Key notes for Codex**:
- `RelationalStore` protocol already has all needed Habit CRUD methods — implemented in `sqlite_relational.py`
- LLM `decide()` returns a dict; handle both dict and list formats from different LLM backends
- Confidence update uses EMA with `lr=0.1`
- Auto-deactivate habit when confidence drops below 0.2
- `Habit` is frozen — create new instances for updates

---

## Step 4: PrimingMemory Tier

**New file**: `backend/arceus/core/hippocampus/tiers/priming.py`

```python
"""
PrimingMemory — Tier 5: Agent state and emotional context.

v6: generate_priming_prompt() uses LLM to synthesize nuanced disposition.
"""
from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import LLMEngine, RelationalStore
from arceus.core.hippocampus.prompts import PRIMING_GENERATION_PROMPT
from arceus.core.hippocampus.utils.time import utc_now


class PrimingMemory:

    def __init__(
        self,
        agent_id: str,
        relational_store: RelationalStore,
        llm_light: LLMEngine,
    ) -> None:
        self._agent_id = agent_id
        self._store = relational_store
        self._llm = llm_light

    async def update_state(
        self, stimulus: str, signal: float, source: str
    ) -> dict:
        current = await self.get_current_state()
        lr = 0.15
        new_state = {
            "confidence": current.get("confidence", 0.5) * (1 - lr)
                + max(signal, 0) * lr,
            "caution": current.get("caution", 0.3) * (1 - lr)
                + max(-signal, 0) * lr,
            "morale": current.get("morale", 0.5) * (1 - lr)
                + (signal * 0.5 + 0.5) * lr,
            "recent_events": [
                *current.get("recent_events", [])[-9:],
                {
                    "stimulus": stimulus,
                    "signal": signal,
                    "source": source,
                    "timestamp": utc_now().isoformat(),
                },
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
        """LLM generates nuanced disposition from current state."""
        state = await self.get_current_state()

        recent_events_text = "\n".join(
            f"- {e['stimulus']} (source: {e['source']}, "
            f"signal: {'positive' if e['signal'] > 0 else 'negative'})"
            for e in state.get("recent_events", [])[-5:]
        ) or "No recent events."

        return await self._llm.generate(
            prompt=PRIMING_GENERATION_PROMPT.format(
                confidence=f"{state['confidence']:.2f}",
                caution=f"{state['caution']:.2f}",
                morale=f"{state['morale']:.2f}",
                recent_events=recent_events_text,
            ),
        )
```

**Key notes for Codex**:
- `RelationalStore` already has `set_priming_state()` / `get_priming_state()` — implemented in `sqlite_relational.py` with `priming_state` table
- Keep only last 10 events (`[-9:]` + new = 10 max)
- EMA with `lr=0.15` for state updates
- Use `utc_now()` from `utils/time.py` (NOT `datetime.utcnow()`)
- Default state: `confidence=0.5, caution=0.3, morale=0.5`

---

## Step 5: ReasoningBank Engine

**New file**: `backend/arceus/core/hippocampus/engines/reasoning_bank.py`

This is the most complex Phase 4 component. 4-step pipeline: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE.

```python
"""
ReasoningBank — 4-step pipeline: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE.

v6: CONSOLIDATE uses LLM-gpt4o-mini for contradiction verification and merge synthesis.
"""
from __future__ import annotations

from dataclasses import dataclass

from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    PatternStore,
    VectorStore,
)
from arceus.core.hippocampus.prompts import (
    CONTRADICTION_CHECK_PROMPT,
    MEMORY_MERGE_PROMPT,
)
from arceus.core.hippocampus.types import (
    ConsolidationResult,
    DistilledMemory,
    MemoryType,
    MemoryUnit,
    RetrievalResult,
    Trajectory,
    TrajectoryVerdict,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity, max_marginal_relevance
from arceus.core.hippocampus.utils.time import utc_now


@dataclass(frozen=True)
class ReasoningBankConfig:
    retrieval_k: int = 3
    mmr_lambda: float = 0.7
    distillation_threshold: float = 0.6


class ReasoningBank:

    def __init__(
        self,
        agent_id: str,
        vector_store: VectorStore,
        pattern_store: PatternStore,
        llm: LLMEngine,
        llm_light: LLMEngine,
        embedding_engine: EmbeddingEngine,
        config: ReasoningBankConfig | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._vector_store = vector_store
        self._pattern_store = pattern_store
        self._llm = llm
        self._llm_light = llm_light
        self._embedding = embedding_engine
        self._config = config or ReasoningBankConfig()

    # ── STEP 1: RETRIEVE ──

    async def retrieve(
        self, query: str, container: str, top_k: int | None = None
    ) -> list[RetrievalResult]:
        k = top_k or self._config.retrieval_k
        query_embedding = await self._embedding.embed(query)
        candidates = await self._vector_store.search(
            embedding=query_embedding,
            container=container,
            memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
            top_k=k * 3,
        )
        if not candidates:
            return []

        candidate_embeddings = [c.embedding or [] for c in candidates]
        selected_indices = max_marginal_relevance(
            query_embedding, candidate_embeddings, k, self._config.mmr_lambda
        )

        results: list[RetrievalResult] = []
        for idx in selected_indices:
            mem = candidates[idx]
            relevance = cosine_similarity(query_embedding, mem.embedding or [])
            diversity = 1.0  # MMR already handles diversity
            results.append(RetrievalResult(memory=mem, relevance=relevance, diversity=diversity))
        return results

    # ── STEP 2: JUDGE ──

    async def judge(self, trajectory: Trajectory) -> TrajectoryVerdict:
        rewards = [step.reward for step in trajectory.steps]
        avg_reward = sum(rewards) / len(rewards) if rewards else 0
        positive_ratio = (
            sum(1 for r in rewards if r > 0) / len(rewards) if rewards else 0
        )
        slope = self._compute_slope(rewards) if len(rewards) > 1 else 0

        quality = (
            0.4 * avg_reward
            + 0.3 * positive_ratio
            + 0.2 * max(slope, 0)
            + 0.1 * (1.0 if trajectory.outcome == "success" else 0.0)
        )

        analysis = await self._llm.analyze(
            prompt="Analyze this trajectory. What were the strengths, weaknesses, and key learnings?",
            trajectory=trajectory,
        )

        return TrajectoryVerdict(
            trajectory_id=trajectory.id,
            quality=quality,
            is_successful=(
                quality >= self._config.distillation_threshold
                and positive_ratio > 0.6
            ),
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
        numerator = sum(
            (i - x_mean) * (r - y_mean) for i, r in enumerate(rewards)
        )
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        return numerator / denominator if denominator != 0 else 0.0

    # ── STEP 3: DISTILL ──

    async def distill(
        self, trajectory: Trajectory, verdict: TrajectoryVerdict
    ) -> DistilledMemory | None:
        if not verdict.is_successful:
            return None

        strategy = " → ".join(step.action for step in trajectory.steps)

        total_reward = sum(max(s.reward, 0.01) for s in trajectory.steps)
        dim = len(trajectory.steps[0].embedding or []) if trajectory.steps else 0
        weighted_emb = [0.0] * dim
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

    # ── STEP 4: CONSOLIDATE ──

    async def consolidate(self) -> ConsolidationResult:
        """
        v6: Contradiction detection via cosine >0.80 → LLM verify.
        Merge via cosine >0.90 same domain → LLM synthesize.
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
        deleted_ids: set[str] = set()

        # 1. Dedup (>95% similar → keep highest confidence)
        for i, mem_a in enumerate(all_memories):
            if mem_a.id in deleted_ids:
                continue
            for mem_b in all_memories[i + 1 :]:
                if mem_b.id in deleted_ids or not mem_a.embedding or not mem_b.embedding:
                    continue
                sim = cosine_similarity(mem_a.embedding, mem_b.embedding)
                if sim > 0.95:
                    victim = mem_b if mem_a.confidence >= mem_b.confidence else mem_a
                    await self._vector_store.soft_delete(victim.id, reason="dedup")
                    deleted_ids.add(victim.id)
                    deduped += 1

        # 2. Contradiction detection (0.80 < sim <= 0.95 → LLM verifies)
        for i, mem_a in enumerate(all_memories):
            if mem_a.id in deleted_ids:
                continue
            for mem_b in all_memories[i + 1 :]:
                if mem_b.id in deleted_ids or not mem_a.embedding or not mem_b.embedding:
                    continue
                sim = cosine_similarity(mem_a.embedding, mem_b.embedding)
                if 0.80 < sim <= 0.95:
                    verdict = await self._llm_light.classify(
                        prompt=CONTRADICTION_CHECK_PROMPT.format(
                            memory_a=mem_a.content,
                            memory_b=mem_b.content,
                        ),
                        options=["CONTRADICTION", "NO_CONTRADICTION"],
                    )
                    if verdict.strip() == "CONTRADICTION":
                        contradictions_found += 1
                        victim = mem_b if mem_a.confidence >= mem_b.confidence else mem_a
                        await self._vector_store.soft_delete(
                            victim.id,
                            reason=f"contradiction_with_{(mem_a if victim == mem_b else mem_b).id}",
                        )
                        deleted_ids.add(victim.id)
                        contradictions_resolved += 1

        # 3. Merge (0.90 < sim <= 0.95, same domain → LLM synthesizes)
        for i, mem_a in enumerate(all_memories):
            if mem_a.id in deleted_ids:
                continue
            for mem_b in all_memories[i + 1 :]:
                if mem_b.id in deleted_ids or not mem_a.embedding or not mem_b.embedding:
                    continue
                sim = cosine_similarity(mem_a.embedding, mem_b.embedding)
                domain_a = mem_a.metadata.get("domain", "")
                domain_b = mem_b.metadata.get("domain", "")
                if 0.90 < sim <= 0.95 and domain_a == domain_b and domain_a:
                    merged_text = await self._llm_light.generate(
                        prompt=MEMORY_MERGE_PROMPT.format(
                            memory_a=mem_a.content,
                            memory_b=mem_b.content,
                        ),
                    )
                    merged_embedding = await self._embedding.embed(merged_text.strip())
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
                    deleted_ids.add(mem_a.id)
                    deleted_ids.add(mem_b.id)
                    merged += 1

        # 4. Prune (>30d, <5 uses, conf <0.3, not a promotion candidate)
        now = utc_now()
        for mem in all_memories:
            if mem.id in deleted_ids:
                continue
            age_days = (now - mem.created_at).total_seconds() / 86400
            uses = mem.metadata.get("usage_count", 0)
            if age_days > 30 and uses < 5 and mem.confidence < 0.3:
                await self._vector_store.soft_delete(mem.id, reason="stale_prune")
                deleted_ids.add(mem.id)
                pruned += 1

        return ConsolidationResult(
            deduped=deduped,
            contradictions_found=contradictions_found,
            contradictions_resolved=contradictions_resolved,
            pruned=pruned,
            merged=merged,
        )
```

**Key notes for Codex**:
- Uses `max_marginal_relevance()` from `utils/similarity.py` for Step 1 (RETRIEVE) — distinct from inlined MMR in `hippocampus.py:recall()`
- `CONTRADICTION_CHECK_PROMPT` already exists from Phase 3 — shared
- Track `deleted_ids` set to avoid double-processing in consolidate loops
- `DistilledMemory.to_memory_unit()` already exists in `types.py`
- Quality formula: `0.4 * avg_reward + 0.3 * positive_ratio + 0.2 * slope + 0.1 * outcome_bonus`

---

## Step 6: PatternLearner Engine

**New file**: `backend/arceus/core/hippocampus/engines/pattern_learner.py`

```python
"""
PatternLearner — Pattern discovery + evolution with clustering.

v6: LLM generates habit trigger/action, LLM synthesizes merged patterns.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    PatternStore,
)
from arceus.core.hippocampus.prompts import HABIT_NAMING_PROMPT, PATTERN_MERGE_PROMPT
from arceus.core.hippocampus.types import (
    Habit,
    HabitFormation,
    Pattern,
    PatternStatus,
    Trajectory,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity
from arceus.core.hippocampus.utils.time import utc_now


@dataclass(frozen=True)
class PatternLearnerConfig:
    learning_rate: float = 0.1
    habit_usage_threshold: int = 10
    habit_success_threshold: float = 0.8


class PatternLearner:

    def __init__(
        self,
        agent_id: str,
        pattern_store: PatternStore,
        embedding_engine: EmbeddingEngine,
        llm_light: LLMEngine,
        config: PatternLearnerConfig | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._store = pattern_store
        self._embedding = embedding_engine
        self._llm = llm_light
        self._config = config or PatternLearnerConfig()

    async def extract_pattern(self, trajectory: Trajectory) -> Pattern | None:
        if trajectory.quality < 0.5:
            return None

        embedding = await self._embedding.embed(trajectory.outcome)

        existing = await self._store.find_similar(embedding, threshold=0.95)
        if existing:
            return await self.evolve_pattern(existing, trajectory.quality)

        domain = (
            trajectory.steps[0].action.split(":")[0]
            if trajectory.steps
            else ""
        )
        pattern = Pattern(
            agent_id=self._agent_id,
            description=trajectory.outcome,
            strategy=" → ".join(s.action for s in trajectory.steps),
            embedding=embedding,
            usage_count=1,
            success_rate=trajectory.quality,
            formed_from=(trajectory.id,),
            domain=domain,
        )
        await self._store.insert(pattern)
        return pattern

    async def evolve_pattern(
        self, pattern: Pattern, quality: float
    ) -> Pattern:
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
            updated_at=utc_now(),
        )
        await self._store.update(updated)
        return updated

    async def check_habit_formation(self, pattern: Pattern) -> Habit | None:
        """LLM generates trigger + action for emerging habit."""
        if (
            pattern.usage_count < self._config.habit_usage_threshold
            or pattern.success_rate < self._config.habit_success_threshold
        ):
            return None

        naming = await self._llm.decide(
            prompt=HABIT_NAMING_PROMPT.format(
                domain=pattern.domain,
                strategy=pattern.strategy,
                usage_count=pattern.usage_count,
                success_rate=f"{pattern.success_rate:.2f}",
            ),
        )

        return Habit(
            agent_id=pattern.agent_id,
            trigger_condition=naming.get("trigger", pattern.domain),
            action=naming.get("action", pattern.strategy),
            confidence=pattern.success_rate,
            usage_count=pattern.usage_count,
            formed_from_id=pattern.id,
            formation_mode=HabitFormation.AUTO,
        )

    async def consolidate_patterns(self) -> dict:
        all_patterns = await self._store.list_all(agent_id=self._agent_id)
        merged_count, pruned_count = 0, 0

        # Merge similar (>90% sim, same domain → LLM synthesizes)
        for i, pa in enumerate(all_patterns):
            for pb in all_patterns[i + 1 :]:
                if (
                    pa.status == PatternStatus.ACTIVE
                    and pb.status == PatternStatus.ACTIVE
                    and pa.embedding
                    and pb.embedding
                ):
                    sim = cosine_similarity(pa.embedding, pb.embedding)
                    if sim > 0.9 and pa.domain == pb.domain:
                        await self._merge_patterns(pa, pb)
                        merged_count += 1

        # Prune: composite score below 20th percentile
        active = [
            p for p in all_patterns if p.status == PatternStatus.ACTIVE
        ]
        scores = [
            (p, p.success_rate * math.log(max(p.usage_count, 1) + 1))
            for p in active
        ]
        if scores:
            scores.sort(key=lambda x: x[1])
            cutoff_idx = len(scores) // 5
            for pattern, _ in scores[:cutoff_idx]:
                await self._store.update_status(pattern.id, PatternStatus.PRUNED)
                pruned_count += 1

        return {"merged": merged_count, "pruned": pruned_count, "split": 0}

    async def _merge_patterns(self, pa: Pattern, pb: Pattern) -> None:
        """LLM synthesizes merged description + strategy."""
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
            (pa.success_rate * pa.usage_count + pb.success_rate * pb.usage_count)
            / total_usage
            if total_usage > 0
            else 0
        )

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
            updated_at=utc_now(),
        )
        await self._store.update(merged)
        await self._store.update_status(pb.id, PatternStatus.MERGED)
```

---

## Step 7: MemoryGarbageCollector Engine

**New file**: `backend/arceus/core/hippocampus/engines/gc.py`

```python
"""
MemoryGarbageCollector — orchestrates cleanup + consolidation + promotions.

Runs every 6 hours (gc_interval_hours config).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
from arceus.core.hippocampus.types import GCResult

if TYPE_CHECKING:
    from arceus.core.hippocampus.hippocampus import Hippocampus


class MemoryGarbageCollector:

    def __init__(
        self,
        hippocampus: Hippocampus,
        promotion_engine: PromotionEngine,
    ) -> None:
        self._hippocampus = hippocampus
        self._promotion_engine = promotion_engine

    async def run(self) -> GCResult:
        # 1. Expire temporal facts
        expired = await self._hippocampus.dynamic_memory.find_expired()
        for mem in expired:
            await self._hippocampus.soft_delete(mem.id, reason="temporal_expiry")

        # 2. Decay-based cleanup (skip promotion candidates)
        decayed = await self._hippocampus.dynamic_memory.find_decayed()
        actually_removed: list = []
        for mem in decayed:
            if not self._promotion_engine._qualifies_for_static(mem):
                await self._hippocampus.soft_delete(mem.id, reason="relevance_decay")
                actually_removed.append(mem)

        # 3. ReasoningBank consolidation (LLM contradiction check + merge)
        consolidation_result = None
        if self._hippocampus.reasoning_bank is not None:
            consolidation_result = await self._hippocampus.reasoning_bank.consolidate()

        # 4. Pattern consolidation (LLM merge synthesis)
        pattern_result = {"merged": 0, "pruned": 0}
        if self._hippocampus.pattern_learner is not None:
            pattern_result = await self._hippocampus.pattern_learner.consolidate_patterns()

        # 5. Automatic promotions (LLM contradiction check + reason generation)
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
            deduped=consolidation_result.deduped if consolidation_result else 0,
            pruned=consolidation_result.pruned if consolidation_result else 0,
            merged=consolidation_result.merged if consolidation_result else 0,
            patterns_merged=pattern_result["merged"],
            patterns_pruned=pattern_result["pruned"],
            promotions_fired=len(promotions),
        )
```

---

## Step 8: Wire Everything into Hippocampus

**File**: `backend/arceus/core/hippocampus/hippocampus.py`

### 8a. New imports
```python
from arceus.core.hippocampus.backends.in_memory_pattern import InMemoryPatternStore
from arceus.core.hippocampus.backends.sqlite_pattern import SQLitePatternStore
from arceus.core.hippocampus.engines.gc import MemoryGarbageCollector
from arceus.core.hippocampus.engines.pattern_learner import PatternLearner, PatternLearnerConfig
from arceus.core.hippocampus.engines.reasoning_bank import ReasoningBank, ReasoningBankConfig
from arceus.core.hippocampus.tiers.procedural import ProceduralMemory
from arceus.core.hippocampus.tiers.priming import PrimingMemory
```

### 8b. Add new fields to `__init__`
```python
def __init__(
    self,
    # ... existing params ...
    procedural_memory: ProceduralMemory | None = None,
    priming_memory: PrimingMemory | None = None,
    reasoning_bank: ReasoningBank | None = None,
    pattern_learner: PatternLearner | None = None,
    gc: MemoryGarbageCollector | None = None,
) -> None:
    # ... existing ...
    self.procedural_memory = procedural_memory
    self.priming_memory = priming_memory
    self.reasoning_bank = reasoning_bank
    self.pattern_learner = pattern_learner
    self._gc = gc
```

### 8c. Build Phase 4 components in `create()`
After building `promotion_engine`, before building `instance`:

```python
# Phase 4: PatternStore
if config.relational_backend == "sqlite":
    pattern_store = SQLitePatternStore(relational_store)
else:
    pattern_store = InMemoryPatternStore()

# Phase 4: Tiers
procedural_memory = ProceduralMemory(agent_id, relational_store, llm_light)
priming_memory = PrimingMemory(agent_id, relational_store, llm_light)

# Phase 4: Engines
reasoning_bank = ReasoningBank(
    agent_id=agent_id,
    vector_store=vector_store,
    pattern_store=pattern_store,
    llm=llm_engine,
    llm_light=llm_light,
    embedding_engine=embedding_engine,
    config=ReasoningBankConfig(
        retrieval_k=config.retrieval_k,
        mmr_lambda=config.mmr_lambda,
        distillation_threshold=config.distillation_threshold,
    ),
)
pattern_learner = PatternLearner(
    agent_id=agent_id,
    pattern_store=pattern_store,
    embedding_engine=embedding_engine,
    llm_light=llm_light,
    config=PatternLearnerConfig(
        learning_rate=config.pattern_learning_rate,
        habit_usage_threshold=config.habit_usage_threshold,
        habit_success_threshold=config.habit_success_threshold,
    ),
)
```

Pass all new components to `cls(...)`. After creating instance:
```python
instance._gc = MemoryGarbageCollector(instance, promotion_engine)
```

### 8d. Add new high-level API methods
```python
async def run_gc(self) -> GCResult:
    if self._gc is None:
        return GCResult()
    return await self._gc.run()

async def get_matching_habits(self, context: str) -> list[Habit]:
    if self.procedural_memory is None:
        return []
    return await self.procedural_memory.get_matching_habits(context)

async def get_priming_prompt(self) -> str:
    if self.priming_memory is None:
        return ""
    return await self.priming_memory.generate_priming_prompt()
```

### 8e. Update `get_summary()` to include Phase 4 data
```python
async def get_summary(self) -> MemorySummaryProjection:
    # ... existing static/dynamic counts ...
    active_habits = []
    if self.procedural_memory is not None:
        habits = await self.procedural_memory.get_active()
        active_habits = [{"trigger": h.trigger_condition, "action": h.action} for h in habits]

    current_state = {}
    if self.priming_memory is not None:
        current_state = await self.priming_memory.get_current_state()

    return MemorySummaryProjection(
        agent_id=self._agent_id,
        static_fact_count=len(static_results),
        dynamic_fact_count=len(dynamic_results),
        active_habits=active_habits,
        current_state=current_state,
    )
```

### 8f. Update `__init__.py` exports
Add `ProceduralMemory`, `PrimingMemory`, `ReasoningBank`, `PatternLearner`, `MemoryGarbageCollector` to imports and `__all__`.

---

## Step 9: Update Arceus Adapters

### 9a. ArceusProfileEngine — populate `habits` and `state`

**File**: `backend/arceus/core/profile_engine.py`

Update `generate_profile()` to use ProceduralMemory and PrimingMemory:

```python
async def generate_profile(self, hippocampus, agent_id, startup_id, role):
    # ... existing static/dynamic queries ...

    habits = []
    if hippocampus.procedural_memory is not None:
        active_habits = await hippocampus.procedural_memory.get_active()
        habits = [
            {"trigger": h.trigger_condition, "action": h.action, "confidence": h.confidence}
            for h in active_habits
        ]

    state = {}
    if hippocampus.priming_memory is not None:
        state = await hippocampus.priming_memory.get_current_state()

    return EmployeeProfile(
        role=role,
        core_knowledge=[m.content for m in static_facts],
        current_context=[m.content for m in dynamic_facts],
        habits=habits,
        state=state,
    )
```

### 9b. ArceusMemoryProjections — add Phase 4 projections

Update `get_summary()` to forward the enriched summary (already handled by Hippocampus.get_summary()).

---

## Step 10: Tests

### 10a. ProceduralMemory Tests

**New file**: `backend/tests/hippocampus/unit/test_procedural.py`

1. `test_add_and_list_habits` — add habits, list active
2. `test_get_matching_habits_noop_llm` — NoopLLM.decide returns empty → no matches
3. `test_record_usage_increases_count` — usage_count increments
4. `test_record_usage_negative_deactivates` — repeated negative signals drop confidence below 0.2
5. `test_empty_habits_returns_empty` — no habits stored → empty list

### 10b. PrimingMemory Tests

**New file**: `backend/tests/hippocampus/unit/test_priming.py`

1. `test_default_state` — no prior state returns defaults
2. `test_update_state_positive_signal` — positive signal increases confidence/morale
3. `test_update_state_negative_signal` — negative signal increases caution
4. `test_recent_events_capped_at_10` — events list doesn't grow unbounded
5. `test_generate_priming_prompt_noop` — NoopLLM returns placeholder string

### 10c. ReasoningBank Tests

**New file**: `backend/tests/hippocampus/unit/test_reasoning_bank.py`

1. `test_retrieve_with_mmr` — retrieves and deduplicates
2. `test_judge_successful_trajectory` — quality >= threshold → is_successful=True
3. `test_judge_failed_trajectory` — low quality → is_successful=False
4. `test_distill_successful` — creates DistilledMemory and upserts to vector store
5. `test_distill_skips_failed` — returns None for failed trajectory
6. `test_consolidate_dedup` — removes >95% similar duplicates
7. `test_consolidate_contradiction_detection` — detects contradictions in 0.80-0.95 range
8. `test_consolidate_prune_stale` — removes old low-usage low-confidence memories
9. `test_compute_slope` — positive trend → positive slope

### 10d. PatternLearner Tests

**New file**: `backend/tests/hippocampus/unit/test_pattern_learner.py`

1. `test_extract_new_pattern` — creates pattern from trajectory
2. `test_extract_evolves_existing` — similar pattern gets usage_count+1
3. `test_extract_low_quality_skipped` — quality < 0.5 returns None
4. `test_check_habit_formation_qualifies` — high usage + success → Habit
5. `test_check_habit_formation_too_few_uses` — below threshold → None
6. `test_consolidate_merge` — similar patterns merged with LLM
7. `test_consolidate_prune_bottom` — bottom 20% by composite score pruned

### 10e. GarbageCollector Tests

**New file**: `backend/tests/hippocampus/unit/test_gc.py`

1. `test_gc_runs_all_stages` — full GC cycle returns GCResult with counts
2. `test_gc_skips_promotion_candidates` — decayed memories qualifying for promotion are kept
3. `test_gc_with_no_engines` — missing reasoning_bank/pattern_learner → still runs (returns 0 counts)

### 10f. Adapter Tests Updates

**File**: `backend/tests/adapters/test_profile_engine.py`

Add:
1. `test_generate_profile_with_habits_and_state` — profile includes habits + priming state

---

## File Changes Summary

| File | Operation | Description |
|------|-----------|-------------|
| `hippocampus/prompts.py` | Modify | Add 5 new prompts (TRIGGER_EVALUATION, PRIMING_GENERATION, HABIT_NAMING, PATTERN_MERGE, MEMORY_MERGE) |
| `hippocampus/backends/in_memory_pattern.py` | **Create** | InMemoryPatternStore |
| `hippocampus/backends/sqlite_pattern.py` | **Create** | SQLitePatternStore wrapping RelationalStore |
| `hippocampus/tiers/procedural.py` | **Create** | ProceduralMemory tier |
| `hippocampus/tiers/priming.py` | **Create** | PrimingMemory tier |
| `hippocampus/engines/reasoning_bank.py` | **Create** | ReasoningBank 4-step pipeline |
| `hippocampus/engines/pattern_learner.py` | **Create** | PatternLearner + habit formation |
| `hippocampus/engines/gc.py` | **Create** | MemoryGarbageCollector orchestrator |
| `hippocampus/hippocampus.py` | Modify | Wire Phase 4 components, add API methods |
| `hippocampus/__init__.py` | Modify | Add Phase 4 exports |
| `core/profile_engine.py` | Modify | Populate habits + state from ProceduralMemory/PrimingMemory |
| `tests/hippocampus/unit/test_procedural.py` | **Create** | 5 tests |
| `tests/hippocampus/unit/test_priming.py` | **Create** | 5 tests |
| `tests/hippocampus/unit/test_reasoning_bank.py` | **Create** | 9 tests |
| `tests/hippocampus/unit/test_pattern_learner.py` | **Create** | 7 tests |
| `tests/hippocampus/unit/test_gc.py` | **Create** | 3 tests |
| `tests/adapters/test_profile_engine.py` | Modify | Add habits+state test |

## Execution Order

1. Step 1: Prompts (no dependencies)
2. Step 2: InMemoryPatternStore + SQLitePatternStore (needs PatternStore protocol — exists)
3. Step 3: ProceduralMemory (needs RelationalStore, LLMEngine, prompts — all exist)
4. Step 4: PrimingMemory (needs RelationalStore, LLMEngine, prompts — all exist)
5. Step 5: ReasoningBank (needs VectorStore, PatternStore, LLMEngine, EmbeddingEngine, types — all exist)
6. Step 6: PatternLearner (needs PatternStore, EmbeddingEngine, LLMEngine — all exist)
7. Step 7: GarbageCollector (needs Hippocampus, PromotionEngine — exists)
8. Step 8: Wire into Hippocampus
9. Step 9: Update adapters
10. Step 10: All tests
11. Run full test suite: `uv run pytest tests/ -v`

---

## SESSION_ID (for /ccg:execute use)
- CODEX_SESSION: N/A
- GEMINI_SESSION: N/A
