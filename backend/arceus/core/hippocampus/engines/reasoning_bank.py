from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    PatternStore,
    VectorStore,
)
from arceus.core.hippocampus.prompts import (
    CONTRADICTION_CHECK_PROMPT,
    MEMORY_MERGE_PROMPT,
    TRAJECTORY_ANALYSIS_PROMPT,
)
from arceus.core.hippocampus.types import (
    ConsolidationResult,
    DistilledMemory,
    MemoryType,
    MemoryUnit,
    RetrievalResult,
    Trajectory,
    TrajectoryStep,
    TrajectoryVerdict,
)
from arceus.core.hippocampus.utils.similarity import (
    cosine_similarity,
    max_marginal_relevance,
)
from arceus.core.hippocampus.utils.time import utc_now


@dataclass(frozen=True)
class ReasoningBankConfig:
    retrieval_k: int = 3
    mmr_lambda: float = 0.7
    distillation_threshold: float = 0.6
    promotion_access_threshold: int = 10
    promotion_confidence_threshold: float = 0.8
    promotion_age_days: int = 14


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

    async def retrieve(
        self,
        query: str,
        container: str,
        top_k: int | None = None,
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

        candidate_embeddings = [candidate.embedding or [] for candidate in candidates]
        selected_indices = max_marginal_relevance(
            query_embedding,
            candidate_embeddings,
            k,
            self._config.mmr_lambda,
        )
        results: list[RetrievalResult] = []
        for index in selected_indices:
            memory = candidates[index]
            relevance = cosine_similarity(query_embedding, memory.embedding or [])
            results.append(
                RetrievalResult(
                    memory=memory,
                    relevance=relevance,
                    diversity=1.0,
                )
            )
        return results

    async def judge(self, trajectory: Trajectory) -> TrajectoryVerdict:
        rewards = [step.reward for step in trajectory.steps]
        avg_reward = sum(rewards) / len(rewards) if rewards else 0.0
        positive_ratio = (
            sum(1 for reward in rewards if reward > 0) / len(rewards)
            if rewards
            else 0.0
        )
        slope = self._compute_slope(rewards)
        quality = (
            0.4 * avg_reward
            + 0.3 * positive_ratio
            + 0.2 * max(slope, 0.0)
            + 0.1 * (1.0 if trajectory.outcome == "success" else 0.0)
        )
        steps_text = " → ".join(step.action for step in trajectory.steps)
        analysis = await self._llm.analyze(
            prompt=TRAJECTORY_ANALYSIS_PROMPT.format(
                outcome=trajectory.outcome,
                steps=steps_text,
            ),
            trajectory=trajectory,
        )
        if not isinstance(analysis, dict):
            analysis = {}

        return TrajectoryVerdict(
            trajectory_id=trajectory.id,
            quality=quality,
            is_successful=(
                quality >= self._config.distillation_threshold and positive_ratio > 0.6
            ),
            strengths=tuple(analysis.get("strengths", ())),
            weaknesses=tuple(analysis.get("weaknesses", ())),
            suggestions=tuple(analysis.get("suggestions", ())),
            confidence=min(avg_reward + 0.3, 1.0),
        )

    async def distill(
        self,
        trajectory: Trajectory,
        verdict: TrajectoryVerdict,
    ) -> DistilledMemory | None:
        if not verdict.is_successful:
            return None

        strategy = " → ".join(step.action for step in trajectory.steps)
        embedding = self._reward_weighted_embedding(trajectory.steps)
        if not embedding:
            return None
        distilled = DistilledMemory(
            agent_id=trajectory.agent_id,
            trajectory_id=trajectory.id,
            strategy=strategy,
            embedding=embedding,
            quality=verdict.quality,
            learnings=(*verdict.strengths, *verdict.suggestions),
        )
        await self._vector_store.upsert(distilled.to_memory_unit())
        return distilled

    async def consolidate(self) -> ConsolidationResult:
        memories = await self._vector_store.list_by_type(
            agent_id=self._agent_id,
            memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
        )
        deleted_ids: set[str] = set()
        deduped = 0
        contradictions_found = 0
        contradictions_resolved = 0
        pruned = 0
        merged = 0

        for left_index, left in enumerate(memories):
            if left.id in deleted_ids:
                continue
            for right in memories[left_index + 1 :]:
                if right.id in deleted_ids:
                    continue
                similarity = cosine_similarity(left.embedding or [], right.embedding or [])
                if similarity <= 0.95:
                    continue

                victim, _ = self._ordered_pair(left, right)
                await self._vector_store.soft_delete(victim.id, reason="dedup")
                deleted_ids.add(victim.id)
                deduped += 1

        for left_index, left in enumerate(memories):
            if left.id in deleted_ids:
                continue
            for right in memories[left_index + 1 :]:
                if right.id in deleted_ids:
                    continue
                similarity = cosine_similarity(left.embedding or [], right.embedding or [])
                if not 0.80 < similarity <= 0.95:
                    continue

                verdict = await self._llm_light.classify(
                    prompt=CONTRADICTION_CHECK_PROMPT.format(
                        memory_a=left.content,
                        memory_b=right.content,
                    ),
                    options=["CONTRADICTION", "NO_CONTRADICTION"],
                )
                if verdict.strip() != "CONTRADICTION":
                    continue

                victim, keeper = self._ordered_pair(left, right)
                await self._vector_store.soft_delete(
                    victim.id,
                    reason=f"contradiction_with_{keeper.id}",
                )
                deleted_ids.add(victim.id)
                contradictions_found += 1
                contradictions_resolved += 1

        for left_index, left in enumerate(memories):
            if left.id in deleted_ids:
                continue
            for right in memories[left_index + 1 :]:
                if right.id in deleted_ids:
                    continue
                similarity = cosine_similarity(left.embedding or [], right.embedding or [])
                if not 0.90 < similarity <= 0.95:
                    continue

                left_domain = self._memory_domain(left)
                right_domain = self._memory_domain(right)
                if not left_domain or left_domain != right_domain:
                    continue

                merged_text = await self._llm_light.generate(
                    prompt=MEMORY_MERGE_PROMPT.format(
                        memory_a=left.content,
                        memory_b=right.content,
                    )
                )
                primary, secondary = self._ordered_pair(left, right, keep_higher=True)
                merged_embedding = await self._embedding.embed(merged_text)
                merged_memory = MemoryUnit(
                    agent_id=primary.agent_id,
                    startup_id=primary.startup_id,
                    content=merged_text,
                    embedding=merged_embedding,
                    memory_type=primary.memory_type,
                    confidence=max(primary.confidence, secondary.confidence),
                    relevance_score=max(primary.relevance_score, secondary.relevance_score),
                    container=primary.container,
                    visibility=primary.visibility,
                    metadata={
                        **secondary.metadata,
                        **primary.metadata,
                        "usage_count": int(primary.metadata.get("usage_count", 0))
                        + int(secondary.metadata.get("usage_count", 0)),
                        "domain": left_domain,
                        "merged_from": [left.id, right.id],
                    },
                    source_type="merge",
                    source_id=primary.id,
                    provenance=f"Merged from {left.id} and {right.id}",
                )
                await self._vector_store.upsert(merged_memory)
                await self._vector_store.soft_delete(left.id, reason="merged")
                await self._vector_store.soft_delete(right.id, reason="merged")
                deleted_ids.add(left.id)
                deleted_ids.add(right.id)
                merged += 1
                break

        cutoff = utc_now() - timedelta(days=30)
        for memory in memories:
            if memory.id in deleted_ids:
                continue
            if self._is_promotion_candidate(memory):
                continue
            usage_count = int(memory.metadata.get("usage_count", 0))
            if (
                memory.created_at < cutoff
                and usage_count < 5
                and memory.confidence < 0.3
            ):
                await self._vector_store.soft_delete(memory.id, reason="stale_prune")
                deleted_ids.add(memory.id)
                pruned += 1

        return ConsolidationResult(
            deduped=deduped,
            contradictions_found=contradictions_found,
            contradictions_resolved=contradictions_resolved,
            pruned=pruned,
            merged=merged,
        )

    def _compute_slope(self, rewards: list[float]) -> float:
        if len(rewards) < 2:
            return 0.0

        count = len(rewards)
        x_values = list(range(count))
        x_mean = sum(x_values) / count
        y_mean = sum(rewards) / count
        numerator = sum(
            (x_value - x_mean) * (reward - y_mean)
            for x_value, reward in zip(x_values, rewards, strict=False)
        )
        denominator = sum((x_value - x_mean) ** 2 for x_value in x_values)
        if denominator == 0.0:
            return 0.0
        return numerator / denominator

    def _reward_weighted_embedding(self, steps: tuple[TrajectoryStep, ...]) -> list[float]:
        weighted_steps = [step for step in steps if step.embedding]
        if not weighted_steps:
            return []

        total_reward = sum(max(step.reward, 0.01) for step in weighted_steps)
        embedding = [0.0] * len(weighted_steps[0].embedding or [])
        for step in weighted_steps:
            weight = max(step.reward, 0.01) / total_reward
            for index, value in enumerate(step.embedding or []):
                embedding[index] += value * weight
        return embedding

    def _ordered_pair(
        self,
        left: MemoryUnit,
        right: MemoryUnit,
        keep_higher: bool = False,
    ) -> tuple[MemoryUnit, MemoryUnit]:
        if keep_higher:
            if left.confidence >= right.confidence:
                return left, right
            return right, left
        if left.confidence >= right.confidence:
            return right, left
        return left, right

    def _memory_domain(self, memory: MemoryUnit) -> str:
        domain = str(memory.metadata.get("domain", "")).strip()
        return domain.lower()

    def _is_promotion_candidate(self, memory: MemoryUnit) -> bool:
        usage_count = int(memory.metadata.get("usage_count", 0))
        age_days = (utc_now() - memory.created_at).total_seconds() / 86400
        return (
            memory.memory_type is MemoryType.DYNAMIC
            and usage_count >= self._config.promotion_access_threshold
            and memory.confidence >= self._config.promotion_confidence_threshold
            and age_days >= self._config.promotion_age_days
            and memory.promotion_status is None
        )
