"""Hippocampus v6 — 5-tier memory system with adaptive intelligence.

Tiers:
    1. Working   — ephemeral cache for in-flight task context (TTL-based)
    2. Static    — permanent facts with version chains
    3. Dynamic   — time-decaying contextual memory (half-life + relevance)
    4. Procedural— learned habits from repeated successful patterns
    5. Priming   — agent disposition/mood state updated by task outcomes

Engines:
    - MemoryExtractor  — LLM-driven fact extraction from conversations
    - PromotionEngine  — Dynamic-to-Static promotion with contradiction checks
    - ReasoningBank    — trajectory judging, distillation, and consolidation
    - PatternLearner   — pattern extraction, evolution, and habit formation
    - GarbageCollector — expired/decayed memory cleanup and probation demotion

Orchestration:
    - remember()                  — manual write to Static or Dynamic
    - recall()                    — MMR-ranked retrieval across tiers
    - extract_from_conversation() — LLM extraction pipeline
    - process_trajectory()        — Flow A steps 6-11 (judge -> distill -> pattern -> habit -> priming)
    - run_promotions()            — batch promotion cycle
    - run_gc()                    — cleanup cycle
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime

from arceus.core.hippocampus.backends.factory import (
    create_cache,
    create_embedding_engine,
    create_llm_engine,
    create_relational,
    create_vector_store,
)
from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    RelationalStore,
    VectorStore,
    WorkingMemoryBackend,
)
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.engines.extractor import MemoryExtractor
from arceus.core.hippocampus.engines.gc import MemoryGarbageCollector
from arceus.core.hippocampus.engines.pattern_learner import (
    PatternLearner,
    PatternLearnerConfig,
)
from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
from arceus.core.hippocampus.engines.reasoning_bank import (
    ReasoningBank,
    ReasoningBankConfig,
)
from arceus.core.hippocampus.stores.relational_pattern_store import (
    RelationalPatternStore,
)
from arceus.core.hippocampus.tiers.dynamic import DynamicMemory
from arceus.core.hippocampus.tiers.priming import PrimingMemory
from arceus.core.hippocampus.tiers.procedural import ProceduralMemory
from arceus.core.hippocampus.tiers.static import StaticMemory
from arceus.core.hippocampus.tiers.working import WorkingMemory
from arceus.core.hippocampus.types import (
    DistilledMemory,
    ExtractedFact,
    ExtractionMode,
    ExtractionResult,
    GCResult,
    Habit,
    MemoryPromotionEvent,
    MemorySummaryProjection,
    MemoryType,
    MemoryUnit,
    Trajectory,
    TrajectoryVerdict,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity
from arceus.core.hippocampus.utils.usage_tracker import UsageTracker


@dataclass(frozen=True)
class HippocampusBackends:
    """Groups low-level backend instances to keep the Hippocampus constructor lean."""

    embedding: EmbeddingEngine
    llm: LLMEngine
    llm_light: LLMEngine
    cache: WorkingMemoryBackend
    vector_store: VectorStore
    relational_store: RelationalStore


class Hippocampus:
    """Hippocampus v6 container — 5-tier memory with adaptive intelligence."""

    def __init__(
        self,
        agent_id: str,
        config: HippocampusConfig,
        working_memory: WorkingMemory,
        static_memory: StaticMemory,
        dynamic_memory: DynamicMemory,
        memory_extractor: MemoryExtractor | None,
        backends: HippocampusBackends,
        promotion_engine: PromotionEngine | None = None,
        procedural_memory: ProceduralMemory | None = None,
        priming_memory: PrimingMemory | None = None,
        reasoning_bank: ReasoningBank | None = None,
        pattern_learner: PatternLearner | None = None,
        gc: MemoryGarbageCollector | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._config = config
        self.working_memory = working_memory
        self.static_memory = static_memory
        self.dynamic_memory = dynamic_memory
        self.memory_extractor = memory_extractor
        self.promotion_engine = promotion_engine
        self.procedural_memory = procedural_memory
        self.priming_memory = priming_memory
        self.reasoning_bank = reasoning_bank
        self.pattern_learner = pattern_learner
        self._gc = gc
        self._backends = backends
        # Convenience aliases used by recall/search/close
        self._embedding = backends.embedding
        self._vector_store = backends.vector_store
        self._relational_store = backends.relational_store
        self._usage_tracker = UsageTracker(backends.vector_store)

    @classmethod
    async def create(
        cls,
        agent_id: str,
        config: HippocampusConfig,
        shared_backends: "HippocampusBackends | None" = None,
    ) -> Hippocampus:
        if shared_backends is not None:
            vector_store = shared_backends.vector_store
            cache_backend = shared_backends.cache
            relational_store = shared_backends.relational_store
            embedding_engine = shared_backends.embedding
            llm_engine = shared_backends.llm
            llm_light = shared_backends.llm_light
            backends = shared_backends
        else:
            vector_store = create_vector_store(config.vector_store_backend, config)
            initialize_vector = getattr(vector_store, "initialize", None)
            if callable(initialize_vector):
                await initialize_vector()
            cache_backend = create_cache(config.cache_backend, config)
            relational_store = create_relational(config.relational_backend, config)
            await relational_store.initialize()
            strict_embeddings = config.embedding_strict or (
                config.vector_store_backend == "pgvector"
                or config.relational_backend == "postgresql"
                or config.cache_backend == "redis"
            )
            embedding_engine = create_embedding_engine(
                config.embedding_model,
                config.embedding_dimensions,
                device=config.embedding_device,
                strict=strict_embeddings,
            )
            warmup_embedding = getattr(embedding_engine, "warmup", None)
            if callable(warmup_embedding) and (config.embedding_warmup or strict_embeddings):
                await warmup_embedding()
            llm_engine = create_llm_engine(config.extraction_model, config)
            llm_light = create_llm_engine(config.lightweight_model, config)

            backends = HippocampusBackends(
                embedding=embedding_engine,
                llm=llm_engine,
                llm_light=llm_light,
                cache=cache_backend,
                vector_store=vector_store,
                relational_store=relational_store,
            )

        working_memory = WorkingMemory(agent_id=agent_id, backend=cache_backend)
        promotion_engine = PromotionEngine(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
            llm_light=llm_light,
        )
        pattern_store = RelationalPatternStore(relational_store, agent_id)
        procedural_memory = ProceduralMemory(agent_id, relational_store, llm_light)
        priming_memory = PrimingMemory(agent_id, relational_store, llm_light)
        reasoning_bank = ReasoningBank(
            agent_id=agent_id,
            vector_store=vector_store,
            llm=llm_engine,
            llm_light=llm_light,
            embedding_engine=embedding_engine,
            config=ReasoningBankConfig(
                retrieval_k=config.retrieval_k,
                mmr_lambda=config.mmr_lambda,
                distillation_threshold=config.distillation_threshold,
                promotion_access_threshold=config.promotion_access_threshold,
                promotion_confidence_threshold=config.promotion_confidence_threshold,
                promotion_age_days=config.promotion_age_days,
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
        static_memory = StaticMemory(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
        )
        dynamic_memory = DynamicMemory(
            agent_id=agent_id,
            vector_store=vector_store,
            embedding_engine=embedding_engine,
            half_life_days=config.dynamic_memory_half_life_days,
            decay_threshold=config.decay_threshold,
        )

        instance = cls(
            agent_id=agent_id,
            config=config,
            working_memory=working_memory,
            static_memory=static_memory,
            dynamic_memory=dynamic_memory,
            memory_extractor=None,
            backends=backends,
            promotion_engine=promotion_engine,
            procedural_memory=procedural_memory,
            priming_memory=priming_memory,
            reasoning_bank=reasoning_bank,
            pattern_learner=pattern_learner,
        )
        instance.memory_extractor = MemoryExtractor(
            llm=llm_engine,
            llm_light=llm_light,
            embedding_engine=embedding_engine,
            hippocampus=instance,
        )
        instance._gc = MemoryGarbageCollector(instance, promotion_engine)
        return instance

    async def close(self) -> None:
        await self._relational_store.close()
        close_vector = getattr(self._vector_store, "close", None)
        if callable(close_vector):
            await close_vector()
        close_cache = getattr(self._backends.cache, "close", None)
        if callable(close_cache):
            await close_cache()

    async def soft_delete(self, memory_id: str, reason: str = "") -> None:
        await self._vector_store.soft_delete(memory_id, reason=reason)

    async def remember(
        self,
        content: str,
        container: str,
        memory_type: MemoryType = MemoryType.DYNAMIC,
    ) -> MemoryUnit:
        if memory_type is MemoryType.STATIC:
            fact = ExtractedFact(
                text=content,
                memory_type=MemoryType.STATIC,
                confidence=1.0,
                is_permanent=True,
            )
            return await self.static_memory.add(fact, container)
        if memory_type is MemoryType.DYNAMIC:
            fact = ExtractedFact(
                text=content,
                memory_type=MemoryType.DYNAMIC,
                confidence=1.0,
            )
            return await self.dynamic_memory.add(fact, container)
        raise ValueError(f"remember() does not support {memory_type.value}")

    async def recall(
        self,
        query: str,
        container: str,
        top_k: int = 10,
    ) -> list[MemoryUnit]:
        query_embedding = await self._embedding.embed(query)
        static_results = await self.static_memory.search(
            query,
            container,
            top_k=max(top_k * 3, top_k),
        )
        dynamic_results = await self.dynamic_memory.search(
            query,
            container,
            top_k=max(top_k * 3, top_k),
        )

        candidates = static_results + dynamic_results
        if not candidates:
            return []

        selected: list[MemoryUnit] = []
        remaining = candidates[:]
        scope_boost = self._scope_boost(container)

        while remaining and len(selected) < top_k:
            best_index = 0
            best_score = float("-inf")
            best_relevance = 0.0

            for index, candidate in enumerate(remaining):
                relevance = cosine_similarity(query_embedding, candidate.embedding or [])
                tier_boost = self._tier_boost(candidate.memory_type)
                base_score = relevance * tier_boost * scope_boost * candidate.relevance_score
                if not selected:
                    score = base_score
                else:
                    redundancy = max(
                        cosine_similarity(candidate.embedding or [], chosen.embedding or [])
                        for chosen in selected
                    )
                    score = (
                        self._config.mmr_lambda * base_score
                        - (1 - self._config.mmr_lambda) * redundancy
                    )

                if score > best_score:
                    best_score = score
                    best_index = index
                    best_relevance = relevance

            chosen = remaining.pop(best_index)
            if best_relevance <= 0.0:
                continue
            selected.append(replace(chosen, relevance_score=best_relevance))

        selected = await self._usage_tracker.record_access(selected)

        return list(selected)

    async def search(
        self,
        query: str,
        container: str,
        top_k: int = 5,
    ) -> list[MemoryUnit]:
        embedding = await self._embedding.embed(query)
        return await self._vector_store.search(
            embedding=embedding,
            container=container,
            agent_id=self._agent_id,
            top_k=top_k,
        )

    async def list_memories(
        self,
        agent_id: str,
        memory_type: MemoryType | None = None,
        memory_types: list[MemoryType] | None = None,
        container: str | None = None,
        created_after: datetime | None = None,
    ) -> list[MemoryUnit]:
        return await self._vector_store.list_by_type(
            agent_id=agent_id,
            memory_type=memory_type,
            memory_types=memory_types,
            container=container,
            created_after=created_after,
        )

    async def extract_from_conversation(
        self,
        messages: list[dict],
        container: str,
        mode: ExtractionMode = ExtractionMode.AGENT,
    ) -> ExtractionResult:
        if self.memory_extractor is None:
            return ExtractionResult()
        return await self.memory_extractor.extract(
            messages=messages,
            agent_id=self._agent_id,
            container=container,
            mode=mode,
        )

    async def process_trajectory(self, trajectory: Trajectory, container: str = "") -> dict:
        """Orchestrate Flow A steps 6-11: judge → distill → extract_pattern → check_habit → update_state."""
        verdict: TrajectoryVerdict | None = None
        distilled: DistilledMemory | None = None
        pattern = None
        habit: Habit | None = None

        if self.reasoning_bank is not None:
            verdict = await self.reasoning_bank.judge(trajectory)
            distilled = await self.reasoning_bank.distill(
                trajectory,
                verdict,
                container=container,
            )

        if self.pattern_learner is not None:
            pattern = await self.pattern_learner.extract_pattern(trajectory)
            if pattern is not None:
                habit = await self.pattern_learner.check_habit_formation(pattern)
                if habit is not None and self.procedural_memory is not None:
                    await self.procedural_memory.add_habit(habit)

        if self.priming_memory is not None:
            signal = 1.0 if trajectory.quality >= 0.5 else -0.5
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

    async def run_promotions(self) -> list[MemoryPromotionEvent]:
        if self.promotion_engine is None:
            return []
        return await self.promotion_engine.run_promotions()

    async def get_recent_promotions(self, limit: int = 20) -> list[MemoryPromotionEvent]:
        if self.promotion_engine is None:
            return []
        return await self.promotion_engine.get_recent_promotions(limit)

    async def demote_memory(self, memory_id: str, reason: str) -> MemoryUnit | None:
        if self.promotion_engine is None:
            return None
        return await self.promotion_engine.demote(memory_id, reason)

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

    async def get_summary(self, container: str = "") -> MemorySummaryProjection:
        """Generate memory summary projection for dashboard."""
        static_results = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.STATIC,
        )
        dynamic_results = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_type=MemoryType.DYNAMIC,
        )
        active_habits = []
        if self.procedural_memory is not None:
            habits = await self.procedural_memory.get_active()
            active_habits = [
                {
                    "trigger": habit.trigger_condition,
                    "action": habit.action,
                    "confidence": habit.confidence,
                }
                for habit in habits
            ]
        current_state = {}
        if self.priming_memory is not None:
            current_state = await self.priming_memory.get_current_state()
        top_patterns = []
        if self.pattern_learner is not None:
            patterns = await self.pattern_learner.get_top_patterns(limit=5)
            top_patterns = [
                {
                    "description": pattern.description,
                    "success_rate": pattern.success_rate,
                    "usage_count": pattern.usage_count,
                }
                for pattern in patterns
            ]
        recent_learnings = []
        if container:
            recent = await self.dynamic_memory.get_recent(container, days=7)
            recent_learnings = [memory.content for memory in recent[:5]]
        recent_promotions = []
        if self.promotion_engine is not None:
            events = await self.promotion_engine.get_recent_promotions(limit=5)
            recent_promotions = [
                f"{event.from_type}->{event.to_type}: {event.reason}"
                for event in events
            ]
        return MemorySummaryProjection(
            agent_id=self._agent_id,
            static_fact_count=len(static_results),
            dynamic_fact_count=len(dynamic_results),
            active_habits=active_habits,
            top_patterns=top_patterns,
            current_state=current_state,
            recent_learnings=recent_learnings,
            recent_promotions=recent_promotions,
        )

    def _tier_boost(self, memory_type: MemoryType) -> float:
        if memory_type is MemoryType.STATIC:
            return self._config.static_boost
        if memory_type is MemoryType.DYNAMIC:
            return self._config.dynamic_boost
        if memory_type is MemoryType.PROCEDURAL:
            return self._config.procedural_boost
        return 1.0

    def _scope_boost(self, container: str) -> float:
        return self._config.task_scope_boost if ":task:" in container else 1.0
