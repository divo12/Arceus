import pytest

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType


@pytest.mark.asyncio
async def test_hippocampus_create_remember_and_recall_prioritizes_static(
    patch_fake_hippocampus_runtime,
) -> None:
    patch_fake_hippocampus_runtime(embedding_dimensions=32)
    config = HippocampusConfig(embedding_dimensions=32)
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)

    try:
        container = "startup:startup-1:emp:agent-1"
        await hippocampus.remember(
            "We use JWT for authentication",
            container=container,
            memory_type=MemoryType.STATIC,
        )
        await hippocampus.remember(
            "JWT tokens currently expire every 24 hours",
            container=container,
            memory_type=MemoryType.DYNAMIC,
        )

        recalled = await hippocampus.recall("JWT auth", container=container, top_k=2)

        assert len(recalled) == 2
        assert recalled[0].memory_type is MemoryType.STATIC
        assert recalled[0].relevance_score > 0.0
        assert all(memory.container == container for memory in recalled)
        assert recalled[0].created_at.tzinfo is not None
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_hippocampus_recall_does_not_cross_scope(
    patch_fake_hippocampus_runtime,
) -> None:
    patch_fake_hippocampus_runtime(embedding_dimensions=32)
    config = HippocampusConfig(embedding_dimensions=32)
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)

    try:
        own_container = "startup:startup-1:emp:agent-1"
        other_container = "startup:startup-1:emp:agent-2"

        await hippocampus.remember(
            "We use JWT for authentication",
            container=own_container,
            memory_type=MemoryType.STATIC,
        )
        await hippocampus.remember(
            "We use JWT for authentication in another employee scope",
            container=other_container,
            memory_type=MemoryType.STATIC,
        )

        recalled = await hippocampus.recall(
            "JWT authentication",
            container=own_container,
            top_k=5,
        )

        assert len(recalled) == 1
        assert recalled[0].container == own_container
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_hippocampus_recall_filters_zero_relevance_results(
    patch_fake_hippocampus_runtime,
) -> None:
    patch_fake_hippocampus_runtime(embedding_dimensions=32)
    config = HippocampusConfig(embedding_dimensions=32)
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)

    try:
        container = "startup:startup-1:emp:agent-1"

        await hippocampus.remember(
            "The deployment pipeline uses blue green rollouts",
            container=container,
            memory_type=MemoryType.STATIC,
        )

        recalled = await hippocampus.recall(
            "yo",
            container=container,
            top_k=5,
        )

        assert recalled == []
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_hippocampus_get_summary_counts_static_and_dynamic(
    patch_fake_hippocampus_runtime,
) -> None:
    patch_fake_hippocampus_runtime(embedding_dimensions=32)
    config = HippocampusConfig(embedding_dimensions=32)
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)
    try:
        container = "startup:startup-1:emp:agent-1"

        await hippocampus.remember(
            "We use JWT for authentication",
            container=container,
            memory_type=MemoryType.STATIC,
        )
        await hippocampus.remember(
            "JWT tokens currently expire every 24 hours",
            container=container,
            memory_type=MemoryType.DYNAMIC,
        )

        summary = await hippocampus.get_summary()

        assert summary.agent_id == "agent-1"
        assert summary.static_fact_count == 1
        assert summary.dynamic_fact_count == 1
    finally:
        await hippocampus.close()
