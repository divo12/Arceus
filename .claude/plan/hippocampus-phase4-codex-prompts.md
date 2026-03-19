# Hippocampus Phase 4 — Codex Prompts

> Give these prompts to Codex **in order** (1 → 5). Each prompt builds on the previous one.
> After each prompt, verify the output compiles before moving to the next.
>
> **Design principle**: Each Hippocampus is per-agent. All sub-components (engines, tiers, stores) receive `agent_id` at construction and store it — methods never take `agent_id` as a parameter. Only the low-level protocol layer (`RelationalStore`, `VectorStore`) takes `agent_id` in method signatures because the underlying DB is shared.

---

## Prompt 1: Prompts + PatternStore Backends (Steps 1-2)

```
You are implementing Phase 4 of the Hippocampus memory system. This prompt covers Step 1 (new LLM prompts) and Step 2 (PatternStore backend implementations).

IMPORTANT RULES:
- All dataclasses are frozen — create new instances, NEVER mutate.
- Use `utc_now()` from `arceus.core.hippocampus.utils.time` — NEVER `datetime.utcnow()`.
- Follow existing code style exactly (no docstrings on methods unless the file already has them, use `from __future__ import annotations`).
- Do NOT create any test files in this prompt.

## Task 1A: Add 5 new prompts to `prompts.py`

File: `backend/arceus/core/hippocampus/prompts.py`

Append these 5 prompts after the existing `PROMOTION_REASON_PROMPT`:

1. `TRIGGER_EVALUATION_PROMPT` — Evaluates which behavioral habits are relevant to current context.
   - Placeholders: `{context}`, `{triggers}`
   - Input: numbered list of habit trigger conditions
   - Output instruction: JSON array of `[{"index": 0, "relevant": true/false}, ...]`
   - Rule: ONLY mark relevant if context clearly matches the trigger condition

2. `PRIMING_GENERATION_PROMPT` — Generates a disposition prompt for an AI agent.
   - Placeholders: `{confidence}` (0-1), `{caution}` (0-1), `{morale}` (0-1), `{recent_events}`
   - Output: 2-3 sentence disposition that references recent events, adjusts tone based on metrics
   - Rule: Do NOT mention numeric values — describe naturally

3. `HABIT_NAMING_PROMPT` — Generates trigger condition and action for a habit from a pattern.
   - Placeholders: `{domain}`, `{strategy}`, `{usage_count}`, `{success_rate}`
   - Output instruction: JSON `{"trigger": "when X happens...", "action": "always do Y..."}`
   - Rule: trigger specific enough to avoid false positives, general enough to fire when relevant

4. `PATTERN_MERGE_PROMPT` — Synthesizes two similar patterns into one.
   - Placeholders: `{description_a}`, `{strategy_a}`, `{description_b}`, `{strategy_b}`
   - Output instruction: JSON `{"description": "...", "strategy": "..."}`

5. `MEMORY_MERGE_PROMPT` — Merges two similar memories into one statement.
   - Placeholders: `{memory_a}`, `{memory_b}`
   - Output: single merged statement, 1-2 sentences, concise, no redundancy

All prompts should use `.strip()` at the end, matching existing style.

## Task 1B: Create InMemoryPatternStore

New file: `backend/arceus/core/hippocampus/backends/in_memory_pattern.py`

The `PatternStore` protocol exists in `protocols.py:87-96`:
```python
class PatternStore(Protocol):
    async def insert(self, pattern: Pattern) -> None: ...
    async def update(self, pattern: Pattern) -> None: ...
    async def find_similar(self, embedding: list[float], threshold: float) -> Pattern | None: ...
    async def list_all(self) -> list[Pattern]: ...
    async def update_status(self, pattern_id: str, status: PatternStatus) -> None: ...
```

Implement `InMemoryPatternStore`:
- `__init__(self, agent_id: str = "")`: `self._agent_id = agent_id`, `self._patterns: dict[str, Pattern] = {}`
- `insert`: store by pattern.id
- `update`: replace by pattern.id
- `find_similar`: iterate all ACTIVE patterns with non-None embedding, compute `cosine_similarity(embedding, pattern.embedding)`, return best match above threshold (or None)
- `list_all`: filter by `self._agent_id` (no parameter — agent is set at construction)
- `update_status`: since `Pattern` is frozen, create a NEW Pattern instance with updated status (copy ALL fields from existing, only change `status`)

Import `cosine_similarity` from `arceus.core.hippocampus.utils.similarity`.
Import `Pattern`, `PatternStatus` from `arceus.core.hippocampus.types`.

## Task 1C: Create SQLitePatternStore

New file: `backend/arceus/core/hippocampus/backends/sqlite_pattern.py`

This wraps `RelationalStore` (which already has `insert_pattern`, `update_pattern`, `list_patterns`, `update_pattern_status`) and adds `find_similar()` via embedding search.

```python
class SQLitePatternStore:
    def __init__(self, relational: RelationalStore, agent_id: str) -> None:
        self._relational = relational
        self._agent_id = agent_id
```

Methods:
- `insert` → delegates to `self._relational.insert_pattern(pattern)`
- `update` → delegates to `self._relational.update_pattern(pattern)`
- `find_similar` → loads all patterns via `self._relational.list_patterns("")`, filters ACTIVE with non-None embedding, returns best match above threshold using cosine_similarity (same logic as InMemory)
- `list_all` → delegates to `self._relational.list_patterns(self._agent_id)` (no parameter)
- `update_status` → delegates to `self._relational.update_pattern_status(pattern_id, status)`

Import `RelationalStore` from `arceus.core.hippocampus.backends.protocols`.

## Task 1D: Update `backends/__init__.py`

File: `backend/arceus/core/hippocampus/backends/__init__.py`

Add `InMemoryPatternStore` and `SQLitePatternStore` to imports and `__all__`.

## Existing files for reference:
- `backends/protocols.py` has PatternStore protocol at lines 87-96
- `types.py` has Pattern (frozen dataclass) with fields: id, agent_id, description, strategy, embedding, usage_count, success_rate, formed_from, cluster_id, status, domain, created_at, updated_at
- `utils/similarity.py` has `cosine_similarity(a, b) -> float`
```

---

## Prompt 2: ProceduralMemory + PrimingMemory Tiers (Steps 3-4)

```
You are continuing Phase 4 of the Hippocampus memory system. This prompt implements the two new memory tiers: ProceduralMemory (Tier 4) and PrimingMemory (Tier 5).

IMPORTANT RULES:
- All dataclasses are frozen — create new instances, NEVER mutate.
- Use `utc_now()` from `arceus.core.hippocampus.utils.time` — NEVER `datetime.utcnow()`.
- `Habit` is a frozen dataclass: id, agent_id, trigger_condition, action, confidence, usage_count, formed_from_id, formation_mode, is_active, created_at
- `RelationalStore` protocol already has: `insert_habit`, `get_habit`, `list_habits(agent_id, is_active)`, `update_habit`, `set_priming_state(agent_id, state)`, `get_priming_state(agent_id)`
- `LLMEngine` protocol has: `decide(prompt, **kwargs) -> dict`, `generate(prompt, **kwargs) -> str`
- Do NOT create test files in this prompt.

## Task 2A: Create `tiers/` directory

Create `backend/arceus/core/hippocampus/tiers/__init__.py` (empty, just `from __future__ import annotations`).

Note: `tiers/working.py`, `tiers/static.py`, `tiers/dynamic.py` already exist — do NOT touch them.

## Task 2B: ProceduralMemory

New file: `backend/arceus/core/hippocampus/tiers/procedural.py`

```python
class ProceduralMemory:
    def __init__(self, agent_id: str, relational_store: RelationalStore, llm_light: LLMEngine) -> None:
```

Methods:

1. `async def add_habit(self, habit: Habit) -> Habit`:
   - Insert via `self._store.insert_habit(habit)`, return habit

2. `async def get_matching_habits(self, context: str) -> list[Habit]`:
   - Load all active habits: `await self._store.list_habits(agent_id=self._agent_id, is_active=True)`
   - If empty, return []
   - Build numbered trigger text: `f"{i}. {h.trigger_condition}"` for each
   - Call `self._llm.decide(prompt=TRIGGER_EVALUATION_PROMPT.format(context=context, triggers=triggers_text))`
   - Parse result: `decide()` returns a dict. Extract list from result directly if it's a list, else `result.get("items", [])`
   - For each item dict with `{"index": N, "relevant": true}`, if index valid and relevant=True, add to matching list
   - Return matching habits

3. `async def get_active(self) -> list[Habit]`:
   - Return `await self._store.list_habits(agent_id=self._agent_id, is_active=True)`

4. `async def record_usage(self, habit_id: str, was_useful: bool) -> Habit`:
   - Get habit: `await self._store.get_habit(habit_id)`
   - Increment usage: `new_count = habit.usage_count + 1`
   - EMA confidence update: `lr = 0.1`, `signal = 1.0 if was_useful else 0.0`, `new_confidence = habit.confidence * (1 - lr) + signal * lr`
   - Auto-deactivate if confidence drops below 0.2: `is_active = new_confidence > 0.2`
   - Create NEW Habit instance with all updated fields (frozen — cannot mutate)
   - Update via `self._store.update_habit(updated)`
   - Return updated

Import `TRIGGER_EVALUATION_PROMPT` from `arceus.core.hippocampus.prompts`.

## Task 2C: PrimingMemory

New file: `backend/arceus/core/hippocampus/tiers/priming.py`

```python
class PrimingMemory:
    def __init__(self, agent_id: str, relational_store: RelationalStore, llm_light: LLMEngine) -> None:
```

Methods:

1. `async def update_state(self, stimulus: str, signal: float, source: str) -> dict`:
   - Get current state via `self.get_current_state()`
   - EMA with `lr = 0.15`:
     - `confidence = current["confidence"] * (1 - lr) + max(signal, 0) * lr`
     - `caution = current["caution"] * (1 - lr) + max(-signal, 0) * lr`
     - `morale = current["morale"] * (1 - lr) + (signal * 0.5 + 0.5) * lr`
   - Append to recent_events (keep last 10): `current["recent_events"][-9:]` + new event dict `{"stimulus": stimulus, "signal": signal, "source": source, "timestamp": utc_now().isoformat()}`
   - Save via `self._store.set_priming_state(self._agent_id, new_state)`
   - Return new_state

2. `async def get_current_state(self) -> dict`:
   - `return await self._store.get_priming_state(self._agent_id) or {"confidence": 0.5, "caution": 0.3, "morale": 0.5, "recent_events": []}`

3. `async def generate_priming_prompt(self) -> str`:
   - Get current state
   - Format recent_events as text (last 5): `f"- {e['stimulus']} (source: {e['source']}, signal: {'positive' if e['signal'] > 0 else 'negative'})"` per event, or "No recent events."
   - Call `self._llm.generate(prompt=PRIMING_GENERATION_PROMPT.format(confidence=f"{state['confidence']:.2f}", caution=f"{state['caution']:.2f}", morale=f"{state['morale']:.2f}", recent_events=recent_events_text))`
   - Return result

Import `PRIMING_GENERATION_PROMPT` from `arceus.core.hippocampus.prompts`.
Import `utc_now` from `arceus.core.hippocampus.utils.time`.
```

---

## Prompt 3: ReasoningBank + PatternLearner Engines (Steps 5-6)

```
You are continuing Phase 4 of the Hippocampus memory system. This prompt implements ReasoningBank (4-step pipeline) and PatternLearner (pattern discovery + habit formation).

IMPORTANT RULES:
- All dataclasses are frozen — create new instances, NEVER mutate.
- Use `utc_now()` from `arceus.core.hippocampus.utils.time`.
- `DistilledMemory.to_memory_unit()` already exists in types.py — use it.
- `max_marginal_relevance()` already exists in `utils/similarity.py` — use it.
- `CONTRADICTION_CHECK_PROMPT` already exists in `prompts.py` — reuse it.
- `MEMORY_MERGE_PROMPT`, `HABIT_NAMING_PROMPT`, `PATTERN_MERGE_PROMPT` were added in Prompt 1.
- Do NOT create test files in this prompt.

## Task 3A: ReasoningBank

New file: `backend/arceus/core/hippocampus/engines/reasoning_bank.py`

Config dataclass (frozen):
```python
@dataclass(frozen=True)
class ReasoningBankConfig:
    retrieval_k: int = 3
    mmr_lambda: float = 0.7
    distillation_threshold: float = 0.6
```

```python
class ReasoningBank:
    def __init__(
        self, agent_id: str, vector_store: VectorStore, pattern_store: PatternStore,
        llm: LLMEngine, llm_light: LLMEngine, embedding_engine: EmbeddingEngine,
        config: ReasoningBankConfig | None = None,
    ) -> None:
```

### STEP 1: RETRIEVE
`async def retrieve(self, query: str, container: str, top_k: int | None = None) -> list[RetrievalResult]`:
- k = top_k or self._config.retrieval_k
- Embed query, search vector_store with memory_types=[STATIC, DYNAMIC], top_k=k*3
- If no candidates, return []
- Get candidate embeddings, call `max_marginal_relevance(query_embedding, candidate_embeddings, k, self._config.mmr_lambda)`
- For each selected index, compute relevance via cosine_similarity, create RetrievalResult(memory=mem, relevance=relevance, diversity=1.0)

### STEP 2: JUDGE
`async def judge(self, trajectory: Trajectory) -> TrajectoryVerdict`:
- Compute: avg_reward, positive_ratio (rewards > 0), slope (linear regression)
- Quality formula: `0.4 * avg_reward + 0.3 * positive_ratio + 0.2 * max(slope, 0) + 0.1 * (1.0 if trajectory.outcome == "success" else 0.0)`
- Call `self._llm.analyze(prompt="Analyze this trajectory...", trajectory=trajectory)` — returns dict with strengths/weaknesses/suggestions
- Return TrajectoryVerdict with is_successful = (quality >= distillation_threshold AND positive_ratio > 0.6)
- confidence = min(avg_reward + 0.3, 1.0)

Helper `_compute_slope(self, rewards: list[float]) -> float`:
- Linear regression slope: standard least-squares formula
- Return 0.0 if < 2 rewards or zero denominator

### STEP 3: DISTILL
`async def distill(self, trajectory: Trajectory, verdict: TrajectoryVerdict) -> DistilledMemory | None`:
- If not verdict.is_successful, return None
- strategy = " → ".join(step.action for step in trajectory.steps)
- Compute reward-weighted embedding: for each step, weight = max(step.reward, 0.01) / total_reward, sum weighted embeddings
- Create DistilledMemory, call `.to_memory_unit()`, upsert to vector_store
- Return the DistilledMemory

### STEP 4: CONSOLIDATE
`async def consolidate(self) -> ConsolidationResult`:
- Load all STATIC + DYNAMIC memories for agent
- Track `deleted_ids: set[str]` to skip already-processed
- **Dedup**: pairs with cosine > 0.95 → keep higher confidence, soft_delete victim with reason="dedup"
- **Contradiction**: pairs with 0.80 < cosine <= 0.95 → LLM classify with CONTRADICTION_CHECK_PROMPT → if CONTRADICTION, soft_delete lower confidence with reason="contradiction_with_{other.id}"
- **Merge**: pairs with 0.90 < cosine <= 0.95, same non-empty domain (from metadata) → LLM generate merged text via MEMORY_MERGE_PROMPT → embed merged text → create new MemoryUnit → upsert, soft_delete both originals
- **Prune**: memories with age > 30 days, usage_count < 5, confidence < 0.3 → soft_delete with reason="stale_prune"
- Return ConsolidationResult with counts

## Task 3B: PatternLearner

New file: `backend/arceus/core/hippocampus/engines/pattern_learner.py`

Config dataclass (frozen):
```python
@dataclass(frozen=True)
class PatternLearnerConfig:
    learning_rate: float = 0.1
    habit_usage_threshold: int = 10
    habit_success_threshold: float = 0.8
```

```python
class PatternLearner:
    def __init__(
        self, agent_id: str, pattern_store: PatternStore,
        embedding_engine: EmbeddingEngine, llm_light: LLMEngine,
        config: PatternLearnerConfig | None = None,
    ) -> None:
```

Methods:

1. `async def extract_pattern(self, trajectory: Trajectory) -> Pattern | None`:
   - If trajectory.quality < 0.5, return None
   - Embed trajectory.outcome
   - Check for similar existing: `self._store.find_similar(embedding, threshold=0.95)`
   - If exists, evolve it (call evolve_pattern)
   - If not, create new Pattern with: agent_id, description=trajectory.outcome, strategy=" → ".join(actions), embedding, usage_count=1, success_rate=trajectory.quality, formed_from=(trajectory.id,), domain=first step action split on ":" [0] or ""
   - Insert and return

2. `async def evolve_pattern(self, pattern: Pattern, quality: float) -> Pattern`:
   - EMA: `new_rate = pattern.success_rate * (1 - lr) + quality * lr`
   - Create NEW Pattern with usage_count+1, new success_rate, updated_at=utc_now()
   - Update in store, return

3. `async def check_habit_formation(self, pattern: Pattern) -> Habit | None`:
   - If usage_count < habit_usage_threshold OR success_rate < habit_success_threshold, return None
   - Call `self._llm.decide(prompt=HABIT_NAMING_PROMPT.format(domain, strategy, usage_count, success_rate))`
   - Create and return Habit with: agent_id, trigger=naming.get("trigger", pattern.domain), action=naming.get("action", pattern.strategy), confidence=pattern.success_rate, usage_count=pattern.usage_count, formed_from_id=pattern.id, formation_mode=HabitFormation.AUTO

4. `async def consolidate_patterns(self) -> dict`:
   - Load all patterns: `await self._store.list_all()` (no agent_id param — store is scoped to agent at construction)
   - **Merge**: pairs both ACTIVE, with embeddings, cosine > 0.9, same domain → call `_merge_patterns(pa, pb)`
   - **Prune**: composite score = `success_rate * math.log(max(usage_count, 1) + 1)`, sort ascending, prune bottom 20% (floor division) by setting status to PRUNED
   - Return `{"merged": N, "pruned": N, "split": 0}`

5. `async def _merge_patterns(self, pa: Pattern, pb: Pattern) -> None`:
   - LLM decide with PATTERN_MERGE_PROMPT → get merged description + strategy
   - Embed merged description
   - Weighted average success_rate by usage_count
   - Create merged Pattern with pa.id, combined usage_count, combined formed_from, status=ACTIVE, updated_at=utc_now()
   - Update merged in store, set pb status to MERGED

Import `math` for `math.log`.
Import `HabitFormation`, `Habit`, `Pattern`, `PatternStatus`, `Trajectory` from types.
```

---

## Prompt 4: GarbageCollector + Wire into Hippocampus + Update Adapters (Steps 7-9)

```
You are continuing Phase 4 of the Hippocampus memory system. This prompt implements the GarbageCollector, wires all Phase 4 components into Hippocampus, and updates adapters.

IMPORTANT RULES:
- All dataclasses are frozen — create new instances, NEVER mutate.
- Do NOT create test files in this prompt.
- When modifying existing files, make MINIMAL changes — do not refactor existing code.

## Task 4A: MemoryGarbageCollector

New file: `backend/arceus/core/hippocampus/engines/gc.py`

```python
from __future__ import annotations
from typing import TYPE_CHECKING
from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
from arceus.core.hippocampus.types import GCResult
if TYPE_CHECKING:
    from arceus.core.hippocampus.hippocampus import Hippocampus

class MemoryGarbageCollector:
    def __init__(self, hippocampus: Hippocampus, promotion_engine: PromotionEngine) -> None:
```

`async def run(self) -> GCResult`:
1. Expire temporal facts: `await self._hippocampus.dynamic_memory.find_expired()` → soft_delete each with reason="temporal_expiry"
2. Decay-based cleanup: `await self._hippocampus.dynamic_memory.find_decayed()` → for each, if NOT `self._promotion_engine._qualifies_for_static(mem)`, soft_delete with reason="relevance_decay"
3. ReasoningBank consolidation: if `self._hippocampus.reasoning_bank is not None`, call `consolidate()`
4. Pattern consolidation: if `self._hippocampus.pattern_learner is not None`, call `consolidate_patterns()`
5. Run promotions: `self._promotion_engine.run_promotions()` (no agent_id — engine stores it)
6. Check probation demotions: `self._promotion_engine.check_probation_demotions()`
7. Check unused static demotions: `self._promotion_engine.check_unused_static_demotions()`
8. Return GCResult with all counts

## Task 4B: Wire Phase 4 into Hippocampus

File: `backend/arceus/core/hippocampus/hippocampus.py`

### New imports:
```python
from arceus.core.hippocampus.backends.in_memory_pattern import InMemoryPatternStore
from arceus.core.hippocampus.backends.sqlite_pattern import SQLitePatternStore
from arceus.core.hippocampus.engines.gc import MemoryGarbageCollector
from arceus.core.hippocampus.engines.pattern_learner import PatternLearner, PatternLearnerConfig
from arceus.core.hippocampus.engines.reasoning_bank import ReasoningBank, ReasoningBankConfig
from arceus.core.hippocampus.tiers.procedural import ProceduralMemory
from arceus.core.hippocampus.tiers.priming import PrimingMemory
from arceus.core.hippocampus.types import GCResult, Habit  # add GCResult, Habit to existing import
```

### Update `__init__` — add new optional parameters after `promotion_engine`:
```python
    procedural_memory: ProceduralMemory | None = None,
    priming_memory: PrimingMemory | None = None,
    reasoning_bank: ReasoningBank | None = None,
    pattern_learner: PatternLearner | None = None,
    gc: MemoryGarbageCollector | None = None,
```
And store them:
```python
    self.procedural_memory = procedural_memory
    self.priming_memory = priming_memory
    self.reasoning_bank = reasoning_bank
    self.pattern_learner = pattern_learner
    self._gc = gc
```

### Update `create()` — build Phase 4 components after `promotion_engine`:
```python
# Phase 4: PatternStore
if config.relational_backend == "sqlite":
    pattern_store = SQLitePatternStore(relational_store, agent_id)
else:
    pattern_store = InMemoryPatternStore(agent_id)

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

Pass `procedural_memory`, `priming_memory`, `reasoning_bank`, `pattern_learner` to `cls(...)`.

After creating instance, set GC:
```python
instance._gc = MemoryGarbageCollector(instance, promotion_engine)
```

### Add new high-level API methods:
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

### Update `get_summary()` to include Phase 4 data:
After existing static/dynamic counts, add:
```python
active_habits = []
if self.procedural_memory is not None:
    habits = await self.procedural_memory.get_active()
    active_habits = [{"trigger": h.trigger_condition, "action": h.action} for h in habits]

current_state = {}
if self.priming_memory is not None:
    current_state = await self.priming_memory.get_current_state()
```
Pass `active_habits=active_habits, current_state=current_state` to `MemorySummaryProjection(...)`.

## Task 4C: Update `__init__.py` exports

File: `backend/arceus/core/hippocampus/__init__.py`

Add imports and `__all__` entries for:
- `ProceduralMemory` (from `tiers.procedural`)
- `PrimingMemory` (from `tiers.priming`)
- `ReasoningBank` (from `engines.reasoning_bank`)
- `PatternLearner` (from `engines.pattern_learner`)
- `MemoryGarbageCollector` (from `engines.gc`)
- `InMemoryPatternStore` (from `backends.in_memory_pattern`)
- `SQLitePatternStore` (from `backends.sqlite_pattern`)

## Task 4D: Update ArceusProfileEngine

File: `backend/arceus/core/profile_engine.py`

Update `generate_profile()` method to populate `habits` and `state`:

After existing static/dynamic queries, add:
```python
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
```

Change the return to pass `habits=habits, state=state` instead of `habits=[], state={}`.

## Existing types for reference:
- `GCResult`: frozen dataclass with expired_removed, decayed_removed, deduped, pruned, merged, patterns_merged, patterns_pruned, promotions_fired (all int, default 0)
- `MemorySummaryProjection`: has active_habits, top_patterns, current_state, recent_learnings, recent_promotions fields (all default empty)
- `Habit`: frozen dataclass with id, agent_id, trigger_condition, action, confidence, usage_count, formed_from_id, formation_mode, is_active, created_at
- `HippocampusConfig` already has: retrieval_k, mmr_lambda, distillation_threshold, pattern_learning_rate, habit_usage_threshold, habit_success_threshold, relational_backend
```

---

## Prompt 5: All Tests (Step 10)

```
You are writing tests for Phase 4 of the Hippocampus memory system. All Phase 4 code is already implemented.

IMPORTANT RULES:
- Use `pytest` and `pytest.mark.asyncio` for async tests.
- Use the existing `hippocampus_factory` fixture from `tests/adapters/conftest.py` for adapter tests.
- For unit tests, construct components directly with in-memory backends.
- `NoopLLMEngine.classify()` returns `options[0]`, `NoopLLMEngine.decide()` returns `{"action": "NONE", "target_id": "", "reason": ""}`, `NoopLLMEngine.generate()` returns `"Noop LLM response"`, `NoopLLMEngine.analyze()` returns `{}`.
- `MockEmbeddingEngine(dim)` generates deterministic hash-based embeddings — different texts get different embeddings with low cosine similarity.
- All data types (MemoryUnit, Habit, Pattern, Trajectory, etc.) are frozen dataclasses with sensible defaults.
- Import existing backends: `MockEmbeddingEngine` from `backends.mock_embedding`, `NoopLLMEngine` from `backends.noop_llm`, `InMemoryVectorStore` from `backends.in_memory_vector`, `InMemoryPatternStore` from `backends.in_memory_pattern`
- Import `SQLiteRelationalStore` from `backends.sqlite_relational` (call `await store.initialize()` after creation).
- `utc_now()` from `arceus.core.hippocampus.utils.time`.

## Test File 1: `tests/hippocampus/unit/test_procedural.py`

5 tests:

1. `test_add_and_list_habits` — Create ProceduralMemory with SQLiteRelationalStore + NoopLLMEngine. Add 2 habits via `add_habit()`. Call `get_active()`. Assert 2 results with correct trigger_conditions.

2. `test_get_matching_habits_noop_llm` — Add habits. Call `get_matching_habits("some context")`. NoopLLM.decide() returns `{"action": "NONE", ...}` which has no "items" key and isn't a list, so result should be empty.

3. `test_record_usage_increases_count` — Add habit with usage_count=0, confidence=0.5. Call `record_usage(habit.id, was_useful=True)`. Assert usage_count=1 and confidence increased.

4. `test_record_usage_negative_deactivates` — Add habit with confidence=0.2. Call `record_usage(habit.id, was_useful=False)` repeatedly (3 times). Assert is_active becomes False when confidence drops below 0.2.

5. `test_empty_habits_returns_empty` — Create ProceduralMemory with no habits. Call `get_active()` and `get_matching_habits("anything")`. Both return [].

## Test File 2: `tests/hippocampus/unit/test_priming.py`

5 tests:

1. `test_default_state` — Create PrimingMemory. Call `get_current_state()`. Assert defaults: confidence=0.5, caution=0.3, morale=0.5, recent_events=[].

2. `test_update_state_positive_signal` — Call `update_state("success", signal=1.0, source="test")`. Assert confidence > 0.5 and morale > 0.5.

3. `test_update_state_negative_signal` — Call `update_state("failure", signal=-1.0, source="test")`. Assert caution > 0.3.

4. `test_recent_events_capped_at_10` — Call `update_state()` 12 times. Assert `len(state["recent_events"]) == 10`.

5. `test_generate_priming_prompt_noop` — Call `generate_priming_prompt()`. Assert result is non-empty string (NoopLLM returns "Noop LLM response").

## Test File 3: `tests/hippocampus/unit/test_reasoning_bank.py`

9 tests:

Use `InMemoryVectorStore`, `InMemoryPatternStore`, `MockEmbeddingEngine(dim=32)`, `NoopLLMEngine()`.

1. `test_retrieve_with_mmr` — Store 3 memories in vector store. Call `retrieve(query, container)`. Assert results are RetrievalResult list.

2. `test_judge_successful_trajectory` — Create trajectory with high rewards (all > 0.5), outcome="success". Call `judge()`. Assert quality >= distillation_threshold and is_successful=True.

3. `test_judge_failed_trajectory` — Create trajectory with low/negative rewards, outcome="failure". Assert is_successful=False.

4. `test_distill_successful` — Create trajectory + successful verdict. Call `distill()`. Assert returns DistilledMemory and vector store has a new memory.

5. `test_distill_skips_failed` — Verdict with is_successful=False. Call `distill()`. Assert returns None.

6. `test_consolidate_dedup` — Store 2 memories with IDENTICAL embeddings (cosine=1.0 > 0.95). Call `consolidate()`. Assert deduped=1.

7. `test_consolidate_contradiction_detection` — Store 2 memories with identical embeddings (so cosine=1.0 which is > 0.80). NoopLLM.classify returns options[0] = "CONTRADICTION". Call `consolidate()`. Assert contradictions_found >= 1.

8. `test_consolidate_prune_stale` — Store memory with created_at = 60 days ago, metadata={"usage_count": 1}, confidence=0.1. Call `consolidate()`. Assert pruned >= 1.

9. `test_compute_slope` — Test `_compute_slope([0.1, 0.3, 0.5, 0.7])` returns positive slope. Test `_compute_slope([0.7, 0.5, 0.3, 0.1])` returns negative slope.

## Test File 4: `tests/hippocampus/unit/test_pattern_learner.py`

7 tests:

Use `InMemoryPatternStore`, `MockEmbeddingEngine(dim=32)`, `NoopLLMEngine()`.

1. `test_extract_new_pattern` — Create trajectory with quality=0.8, outcome="auth strategy". Call `extract_pattern()`. Assert returns Pattern with usage_count=1.

2. `test_extract_evolves_existing` — Insert a pattern, then create trajectory with identical outcome (so find_similar matches). Call `extract_pattern()`. Assert returned pattern has usage_count=2.

3. `test_extract_low_quality_skipped` — Trajectory with quality=0.3. Call `extract_pattern()`. Assert returns None.

4. `test_check_habit_formation_qualifies` — Create Pattern with usage_count=15, success_rate=0.9. Call `check_habit_formation()`. Assert returns Habit with formed_from_id=pattern.id.

5. `test_check_habit_formation_too_few_uses` — Pattern with usage_count=3. Assert returns None.

6. `test_consolidate_merge` — Insert 2 patterns with identical embeddings, same domain, both ACTIVE. Call `consolidate_patterns()`. Assert merged >= 1.

7. `test_consolidate_prune_bottom` — Insert 6 patterns with varying success_rate and usage_count. Call `consolidate_patterns()`. Assert pruned >= 1 (bottom 20%).

## Test File 5: `tests/hippocampus/unit/test_gc.py`

3 tests:

1. `test_gc_runs_all_stages` — Create full Hippocampus via hippocampus_factory (or build manually). Call `run_gc()`. Assert returns GCResult (all counts >= 0).

2. `test_gc_skips_promotion_candidates` — Add a dynamic memory that qualifies for promotion (high usage, confidence, age). Add another that doesn't. Call `run_gc()`. Assert the qualifying one is NOT removed.

3. `test_gc_with_no_engines` — Create Hippocampus with reasoning_bank=None, pattern_learner=None. Call `run_gc()`. Assert runs without error, returns GCResult with 0 counts for reasoning/pattern fields.

## Test File 6: Update `tests/adapters/test_profile_engine.py`

Add 1 new test:

`test_generate_profile_with_habits_and_state` — Use hippocampus_factory. Add a habit via `hippocampus.procedural_memory.add_habit(Habit(...))`. Update priming state via `hippocampus.priming_memory.update_state("success", 1.0, "test")`. Call `generate_profile()`. Assert `profile.habits` has 1 entry and `profile.state` has confidence/morale/caution keys.

## Shared test setup:

For unit tests that need SQLiteRelationalStore, use `tmp_path` fixture:
```python
@pytest.fixture
async def relational_store(tmp_path):
    store = SQLiteRelationalStore(str(tmp_path / "test.db"))
    await store.initialize()
    return store
```

Run all tests with: `uv run pytest tests/ -v`
```

---

## Execution Instructions

1. Give Codex **Prompt 1**, verify no import errors
2. Give Codex **Prompt 2**, verify no import errors
3. Give Codex **Prompt 3**, verify no import errors
4. Give Codex **Prompt 4**, verify `uv run python -c "from arceus.core.hippocampus import Hippocampus"` works
5. Give Codex **Prompt 5**, run `uv run pytest tests/ -v` and fix any failures
