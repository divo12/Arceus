from __future__ import annotations

import pytest

from arceus.core.hippocampus.engines.pattern_learner import PatternLearner
from arceus.core.hippocampus.types import Pattern, PatternStatus, Trajectory, TrajectoryStep
from arceus.core.hippocampus.utils.time import utc_now
from tests.hippocampus.support.fakes.in_memory_pattern import InMemoryPatternStore
from tests.hippocampus.support.fakes.mock_embedding import MockEmbeddingEngine
from tests.hippocampus.support.fakes.noop_llm import NoopLLMEngine


def _create_pattern_learner() -> tuple[PatternLearner, InMemoryPatternStore, MockEmbeddingEngine]:
    store = InMemoryPatternStore(agent_id="agent-1")
    embedding = MockEmbeddingEngine(dimensions=32)
    learner = PatternLearner(
        agent_id="agent-1",
        pattern_store=store,
        embedding_engine=embedding,
        llm_light=NoopLLMEngine(model_name="noop"),
    )
    return learner, store, embedding


async def _trajectory(
    embedding: MockEmbeddingEngine,
    *,
    outcome: str,
    quality: float,
    action: str = "auth:review",
) -> Trajectory:
    return Trajectory(
        agent_id="agent-1",
        task_id="task-1",
        steps=(
            TrajectoryStep(
                step_index=0,
                action=action,
                reward=quality,
                embedding=await embedding.embed(action),
            ),
        ),
        outcome=outcome,
        quality=quality,
    )


@pytest.mark.asyncio
async def test_extract_new_pattern() -> None:
    learner, _, embedding = _create_pattern_learner()
    trajectory = await _trajectory(embedding, outcome="auth strategy", quality=0.8)

    pattern = await learner.extract_pattern(trajectory)

    assert pattern is not None
    assert pattern.usage_count == 1
    assert pattern.domain == "auth"


@pytest.mark.asyncio
async def test_extract_evolves_existing() -> None:
    learner, store, embedding = _create_pattern_learner()
    existing = Pattern(
        agent_id="agent-1",
        description="auth strategy",
        strategy="auth:review",
        embedding=await embedding.embed("auth strategy"),
        usage_count=1,
        success_rate=0.7,
        formed_from=("traj-1",),
        domain="auth",
    )
    await store.insert(existing)
    trajectory = await _trajectory(embedding, outcome="auth strategy", quality=0.9)

    pattern = await learner.extract_pattern(trajectory)

    assert pattern is not None
    assert pattern.id == existing.id
    assert pattern.usage_count == 2


@pytest.mark.asyncio
async def test_extract_low_quality_skipped() -> None:
    learner, _, embedding = _create_pattern_learner()
    trajectory = await _trajectory(embedding, outcome="low-value note", quality=0.3)

    pattern = await learner.extract_pattern(trajectory)

    assert pattern is None


@pytest.mark.asyncio
async def test_check_habit_formation_qualifies() -> None:
    learner, _, embedding = _create_pattern_learner()
    pattern = Pattern(
        id="pattern-1",
        agent_id="agent-1",
        description="auth strategy",
        strategy="always inspect auth config",
        embedding=await embedding.embed("auth strategy"),
        usage_count=15,
        success_rate=0.9,
        formed_from=("traj-1",),
        domain="auth",
    )

    habit = await learner.check_habit_formation(pattern)

    assert habit is not None
    assert habit.formed_from_id == "pattern-1"


@pytest.mark.asyncio
async def test_check_habit_formation_too_few_uses() -> None:
    learner, _, embedding = _create_pattern_learner()
    pattern = Pattern(
        agent_id="agent-1",
        description="auth strategy",
        strategy="always inspect auth config",
        embedding=await embedding.embed("auth strategy"),
        usage_count=3,
        success_rate=0.9,
        formed_from=("traj-1",),
        domain="auth",
    )

    habit = await learner.check_habit_formation(pattern)

    assert habit is None


@pytest.mark.asyncio
async def test_check_habit_formation_at_threshold_qualifies() -> None:
    learner, _, embedding = _create_pattern_learner()
    pattern = Pattern(
        id="pattern-threshold",
        agent_id="agent-1",
        description="auth strategy",
        strategy="always inspect auth config",
        embedding=await embedding.embed("auth strategy"),
        usage_count=10,
        success_rate=0.8,
        formed_from=("traj-1",),
        domain="auth",
    )

    habit = await learner.check_habit_formation(pattern)

    assert habit is not None
    assert habit.formed_from_id == "pattern-threshold"


@pytest.mark.asyncio
async def test_check_habit_formation_below_success_threshold_skipped() -> None:
    learner, _, embedding = _create_pattern_learner()
    pattern = Pattern(
        agent_id="agent-1",
        description="auth strategy",
        strategy="always inspect auth config",
        embedding=await embedding.embed("auth strategy"),
        usage_count=10,
        success_rate=0.79,
        formed_from=("traj-1",),
        domain="auth",
    )

    habit = await learner.check_habit_formation(pattern)

    assert habit is None


@pytest.mark.asyncio
async def test_consolidate_merge() -> None:
    learner, store, embedding = _create_pattern_learner()
    shared_embedding = await embedding.embed("auth strategy")
    await store.insert(
        Pattern(
            id="pattern-a",
            agent_id="agent-1",
            description="auth strategy",
            strategy="inspect headers",
            embedding=shared_embedding,
            usage_count=10,
            success_rate=0.9,
            formed_from=("traj-1",),
            domain="auth",
        )
    )
    await store.insert(
        Pattern(
            id="pattern-b",
            agent_id="agent-1",
            description="auth strategy",
            strategy="inspect cookies",
            embedding=shared_embedding,
            usage_count=12,
            success_rate=0.85,
            formed_from=("traj-2",),
            domain="auth",
        )
    )

    result = await learner.consolidate_patterns()
    patterns = await store.list_all()

    assert result["merged"] >= 1
    assert any(
        pattern.id == "pattern-b" and pattern.status is PatternStatus.MERGED
        for pattern in patterns
    )


@pytest.mark.asyncio
async def test_consolidate_prune_bottom() -> None:
    learner, store, embedding = _create_pattern_learner()
    for index in range(6):
        await store.insert(
            Pattern(
                id=f"pattern-{index}",
                agent_id="agent-1",
                description=f"pattern-{index}",
                strategy=f"strategy-{index}",
                embedding=await embedding.embed(f"pattern-{index}"),
                usage_count=index + 1,
                success_rate=0.1 * (index + 1),
                formed_from=(f"traj-{index}",),
                domain=f"domain-{index}",
                created_at=utc_now(),
                updated_at=utc_now(),
            )
        )

    result = await learner.consolidate_patterns()
    patterns = await store.list_all()

    assert result["pruned"] >= 1
    assert any(pattern.status is PatternStatus.PRUNED for pattern in patterns)
