"""Shared fixtures for adapter tests."""
from __future__ import annotations

import pytest_asyncio

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus


@pytest_asyncio.fixture
async def hippocampus_factory(patch_fake_hippocampus_runtime):
    """Factory fixture that creates a Hippocampus with explicit test fakes."""
    instances: list[Hippocampus] = []

    async def _create(agent_id: str) -> Hippocampus:
        patch_fake_hippocampus_runtime(embedding_dimensions=32)
        hippocampus = await Hippocampus.create(
            agent_id=agent_id,
            config=HippocampusConfig(embedding_dimensions=32),
        )
        instances.append(hippocampus)
        return hippocampus

    yield _create

    for hippocampus in instances:
        await hippocampus.close()
