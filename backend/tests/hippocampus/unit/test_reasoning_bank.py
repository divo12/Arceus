from __future__ import annotations

from datetime import timedelta

import pytest

from arceus.core.hippocampus.engines.reasoning_bank import (
    ReasoningBank,
    ReasoningBankConfig,
)
from arceus.core.hippocampus.types import (
    DistilledMemory,
    MemoryType,
    MemoryUnit,
    RetrievalResult,
    Trajectory,
    TrajectoryStep,
    TrajectoryVerdict,
)
from arceus.core.hippocampus.utils.time import utc_now
from tests.hippocampus.support.fakes.in_memory_vector import InMemoryVectorStore
from tests.hippocampus.support.fakes.mock_embedding import MockEmbeddingEngine
from tests.hippocampus.support.fakes.noop_llm import NoopLLMEngine


class ReasoningLLMDouble(NoopLLMEngine):
    def __init__(
        self,
        *,
        classify_result: str = "NO_CONTRADICTION",
        generated_text: str = "Merged reasoning memory",
    ) -> None:
        super().__init__(model_name="noop")
        self.classify_result = classify_result
        self.generated_text = generated_text

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
        del prompt, kwargs
        assert self.classify_result in options
        return self.classify_result

    async def generate(self, prompt: str, **kwargs) -> str:
        del prompt, kwargs
        return self.generated_text


def _create_reasoning_bank(
    config: ReasoningBankConfig | None = None,
    *,
    llm_light: NoopLLMEngine | None = None,
) -> tuple[ReasoningBank, InMemoryVectorStore, MockEmbeddingEngine]:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    bank = ReasoningBank(
        agent_id="agent-1",
        vector_store=vector_store,
        llm=NoopLLMEngine(model_name="noop"),
        llm_light=llm_light or NoopLLMEngine(model_name="noop"),
        embedding_engine=embedding,
        config=config,
    )
    return bank, vector_store, embedding


async def _memory(
    embedding: MockEmbeddingEngine,
    *,
    memory_id: str,
    content: str,
    container: str = "startup:1:emp:agent-1",
    memory_type: MemoryType = MemoryType.DYNAMIC,
    confidence: float = 0.8,
    metadata: dict | None = None,
    created_at=None,
    updated_at=None,
    embedding_override: list[float] | None = None,
) -> MemoryUnit:
    return MemoryUnit(
        id=memory_id,
        agent_id="agent-1",
        content=content,
        embedding=embedding_override or await embedding.embed(content),
        memory_type=memory_type,
        confidence=confidence,
        container=container,
        metadata=metadata or {},
        created_at=created_at or utc_now(),
        updated_at=updated_at or utc_now(),
    )


async def _trajectory(
    embedding: MockEmbeddingEngine,
    *,
    rewards: list[float],
    outcome: str,
    actions: list[str] | None = None,
    quality: float = 0.8,
) -> Trajectory:
    trajectory_actions = actions or [f"step-{index}" for index in range(len(rewards))]
    steps = []
    for index, (action, reward) in enumerate(zip(trajectory_actions, rewards, strict=False)):
        steps.append(
            TrajectoryStep(
                step_index=index,
                action=action,
                reward=reward,
                embedding=await embedding.embed(action),
            )
        )
    return Trajectory(
        agent_id="agent-1",
        task_id="task-1",
        steps=tuple(steps),
        outcome=outcome,
        quality=quality,
    )


@pytest.mark.asyncio
async def test_retrieve_with_mmr() -> None:
    bank, vector_store, embedding = _create_reasoning_bank()
    for index, content in enumerate(
        [
            "JWT authentication strategy",
            "Refresh token rotation guide",
            "Incident response checklist",
        ]
    ):
        await vector_store.upsert(
            await _memory(embedding, memory_id=f"mem-{index}", content=content)
        )

    results = await bank.retrieve("authentication", "startup:1:emp:agent-1")

    assert results
    assert all(isinstance(result, RetrievalResult) for result in results)


@pytest.mark.asyncio
async def test_judge_successful_trajectory() -> None:
    bank, _, embedding = _create_reasoning_bank()
    trajectory = await _trajectory(
        embedding,
        rewards=[0.8, 0.9, 0.85],
        outcome="success",
    )

    verdict = await bank.judge(trajectory)

    assert verdict.quality >= bank._config.distillation_threshold
    assert verdict.is_successful is True


@pytest.mark.asyncio
async def test_judge_failed_trajectory() -> None:
    bank, _, embedding = _create_reasoning_bank()
    trajectory = await _trajectory(
        embedding,
        rewards=[-0.3, -0.1, 0.0],
        outcome="failure",
    )

    verdict = await bank.judge(trajectory)

    assert verdict.is_successful is False


@pytest.mark.asyncio
async def test_distill_successful() -> None:
    bank, vector_store, embedding = _create_reasoning_bank()
    trajectory = await _trajectory(
        embedding,
        rewards=[0.8, 0.9, 0.85],
        outcome="success",
        actions=["inspect", "compare", "fix"],
    )
    verdict = await bank.judge(trajectory)

    distilled = await bank.distill(trajectory, verdict)
    memories = await vector_store.list_by_type(
        agent_id="agent-1",
        memory_type=MemoryType.DYNAMIC,
    )

    assert isinstance(distilled, DistilledMemory)
    assert len(memories) == 1
    assert memories[0].content == "inspect → compare → fix"


@pytest.mark.asyncio
async def test_distill_skips_failed() -> None:
    bank, _, embedding = _create_reasoning_bank()
    trajectory = await _trajectory(
        embedding,
        rewards=[-0.2, 0.0, 0.1],
        outcome="failure",
    )
    verdict = TrajectoryVerdict(
        trajectory_id=trajectory.id,
        quality=0.2,
        is_successful=False,
    )

    distilled = await bank.distill(trajectory, verdict)

    assert distilled is None


@pytest.mark.asyncio
async def test_consolidate_dedup() -> None:
    bank, vector_store, embedding = _create_reasoning_bank()
    duplicate_embedding = [1.0, 0.0]
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="mem-a",
            content="JWT auth rule",
            confidence=0.9,
            embedding_override=duplicate_embedding,
        )
    )
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="mem-b",
            content="JWT auth rule variant",
            confidence=0.7,
            embedding_override=duplicate_embedding,
        )
    )

    result = await bank.consolidate()

    assert result.deduped == 1
    assert await vector_store.get("mem-b") is None


@pytest.mark.asyncio
async def test_consolidate_contradiction_detection() -> None:
    bank, vector_store, embedding = _create_reasoning_bank()
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="mem-a",
            content="Use REST for all APIs",
            confidence=0.9,
            embedding_override=[1.0, 0.0],
        )
    )
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="mem-b",
            content="All APIs must use GraphQL",
            confidence=0.7,
            embedding_override=[0.9, 0.4358898943540673],
        )
    )

    result = await bank.consolidate()

    assert result.contradictions_found >= 1
    assert result.contradictions_resolved >= 1
    assert await vector_store.get("mem-b") is None


@pytest.mark.asyncio
async def test_consolidate_prune_stale() -> None:
    bank, vector_store, embedding = _create_reasoning_bank()
    old_time = utc_now() - timedelta(days=60)
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="stale",
            content="Old low-value note",
            confidence=0.1,
            metadata={"usage_count": 1},
            created_at=old_time,
            updated_at=old_time,
        )
    )

    result = await bank.consolidate()

    assert result.pruned >= 1
    assert await vector_store.get("stale") is None


@pytest.mark.asyncio
async def test_consolidate_skips_promotion_candidates() -> None:
    bank, vector_store, embedding = _create_reasoning_bank(
        ReasoningBankConfig(
            promotion_access_threshold=1,
            promotion_confidence_threshold=0.1,
            promotion_age_days=14,
        )
    )
    old_time = utc_now() - timedelta(days=60)
    candidate = await _memory(
        embedding,
        memory_id="candidate",
        content="Old but promotable note",
        confidence=0.1,
        metadata={"usage_count": 1},
        created_at=old_time,
        updated_at=old_time,
    )
    await vector_store.upsert(candidate)

    result = await bank.consolidate()

    assert result.pruned == 0
    assert await vector_store.get("candidate") is not None


@pytest.mark.asyncio
async def test_consolidate_merge_same_domain_creates_merged_memory() -> None:
    bank, vector_store, embedding = _create_reasoning_bank(
        llm_light=ReasoningLLMDouble(
            classify_result="NO_CONTRADICTION",
            generated_text="Merged auth rollout rule",
        )
    )
    shared_domain = {"domain": "auth"}
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="mem-a",
            content="Auth rollout note A",
            confidence=0.9,
            metadata=shared_domain,
            embedding_override=[1.0, 0.0],
        )
    )
    await vector_store.upsert(
        await _memory(
            embedding,
            memory_id="mem-b",
            content="Auth rollout note B",
            confidence=0.85,
            metadata=shared_domain,
            embedding_override=[0.92, 0.3919183588453085],
        )
    )

    result = await bank.consolidate()
    memories = await vector_store.list_by_type(
        agent_id="agent-1",
        memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
    )

    assert result.merged == 1
    assert await vector_store.get("mem-a") is None
    assert await vector_store.get("mem-b") is None
    assert any(memory.content == "Merged auth rollout rule" for memory in memories)


def test_compute_slope() -> None:
    bank, _, _ = _create_reasoning_bank()

    assert bank._compute_slope([0.1, 0.3, 0.5, 0.7]) > 0
    assert bank._compute_slope([0.7, 0.5, 0.3, 0.1]) < 0
