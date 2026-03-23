from __future__ import annotations

import math
from dataclasses import dataclass, replace

from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    PatternStore,
)
from arceus.core.hippocampus.prompts import (
    HABIT_NAMING_PROMPT,
    PATTERN_MERGE_PROMPT,
)
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
        if existing is not None:
            return await self.evolve_pattern(existing, trajectory.quality)

        strategy = " → ".join(step.action for step in trajectory.steps)
        domain = (
            trajectory.steps[0].action.split(":", 1)[0]
            if trajectory.steps
            else ""
        )
        pattern = Pattern(
            agent_id=self._agent_id,
            description=trajectory.outcome,
            strategy=strategy,
            embedding=embedding,
            usage_count=1,
            success_rate=trajectory.quality,
            formed_from=(trajectory.id,),
            domain=domain,
        )
        await self._store.insert(pattern)
        return pattern

    async def evolve_pattern(self, pattern: Pattern, quality: float) -> Pattern:
        lr = self._config.learning_rate
        new_rate = pattern.success_rate * (1 - lr) + quality * lr
        updated = replace(
            pattern,
            usage_count=pattern.usage_count + 1,
            success_rate=new_rate,
            updated_at=utc_now(),
        )
        await self._store.update(updated)
        return updated

    async def check_habit_formation(self, pattern: Pattern) -> Habit | None:
        if pattern.usage_count < self._config.habit_usage_threshold:
            return None
        if pattern.success_rate < self._config.habit_success_threshold:
            return None

        naming = await self._llm.decide(
            prompt=HABIT_NAMING_PROMPT.format(
                domain=pattern.domain,
                strategy=pattern.strategy,
                usage_count=pattern.usage_count,
                success_rate=f"{pattern.success_rate:.2f}",
            )
        )
        if not isinstance(naming, dict):
            naming = {}

        return Habit(
            agent_id=self._agent_id,
            trigger_condition=naming.get("trigger", pattern.domain),
            action=naming.get("action", pattern.strategy),
            confidence=pattern.success_rate,
            usage_count=pattern.usage_count,
            formed_from_id=pattern.id,
            formation_mode=HabitFormation.AUTO,
        )

    async def consolidate_patterns(self) -> dict:
        patterns = await self._store.list_all()
        merged_ids: set[str] = set()
        merged = 0

        for left_index, left in enumerate(patterns):
            if left.id in merged_ids or left.status is not PatternStatus.ACTIVE:
                continue
            if not left.embedding:
                continue
            for right in patterns[left_index + 1 :]:
                if right.id in merged_ids or right.status is not PatternStatus.ACTIVE:
                    continue
                if not right.embedding:
                    continue
                if left.domain != right.domain:
                    continue
                if cosine_similarity(left.embedding, right.embedding) <= 0.9:
                    continue

                await self._merge_patterns(left, right)
                merged_ids.add(right.id)
                merged += 1
                break

        refreshed_patterns = await self._store.list_all()
        active_patterns = [
            pattern
            for pattern in refreshed_patterns
            if pattern.status is PatternStatus.ACTIVE
        ]
        prune_count = len(active_patterns) // 5
        ranked_patterns = sorted(
            active_patterns,
            key=lambda pattern: (
                pattern.success_rate * math.log(max(pattern.usage_count, 1) + 1)
            ),
        )
        pruned = 0
        for pattern in ranked_patterns[:prune_count]:
            await self._store.update_status(pattern.id, PatternStatus.PRUNED)
            pruned += 1

        return {"merged": merged, "pruned": pruned, "split": 0}

    async def get_top_patterns(self, limit: int = 5) -> list[Pattern]:
        all_patterns = await self._store.list_all()
        active = [
            pattern
            for pattern in all_patterns
            if pattern.status is PatternStatus.ACTIVE
        ]
        ranked = sorted(
            active,
            key=lambda pattern: (
                pattern.success_rate * math.log(max(pattern.usage_count, 1) + 1)
            ),
            reverse=True,
        )
        return ranked[:limit]

    async def _merge_patterns(self, pa: Pattern, pb: Pattern) -> None:
        merged_data = await self._llm.decide(
            prompt=PATTERN_MERGE_PROMPT.format(
                description_a=pa.description,
                strategy_a=pa.strategy,
                description_b=pb.description,
                strategy_b=pb.strategy,
            )
        )
        if not isinstance(merged_data, dict):
            merged_data = {}

        total_usage = pa.usage_count + pb.usage_count
        merged_description = merged_data.get("description", pa.description)
        merged_strategy = merged_data.get("strategy", pa.strategy)
        merged_pattern = replace(
            pa,
            description=merged_description,
            strategy=merged_strategy,
            embedding=await self._embedding.embed(merged_description),
            usage_count=total_usage,
            success_rate=(
                (
                    pa.success_rate * pa.usage_count
                    + pb.success_rate * pb.usage_count
                )
                / total_usage
                if total_usage > 0
                else pa.success_rate
            ),
            formed_from=tuple(dict.fromkeys((*pa.formed_from, *pb.formed_from))),
            cluster_id=pa.cluster_id or pb.cluster_id,
            status=PatternStatus.ACTIVE,
            updated_at=utc_now(),
        )
        await self._store.update(merged_pattern)
        await self._store.update_status(pb.id, PatternStatus.MERGED)
