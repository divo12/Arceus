"""Shared fixtures for adapter tests."""
from __future__ import annotations

from pathlib import Path

import pytest_asyncio

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus


@pytest_asyncio.fixture
async def hippocampus_factory(tmp_path: Path):
    """Factory fixture that creates a Hippocampus with in-memory/noop backends."""
    instances: list[Hippocampus] = []

    async def _create(agent_id: str) -> Hippocampus:
        hippocampus = await Hippocampus.create(
            agent_id=agent_id,
            config=HippocampusConfig(
                sqlite_path=str(tmp_path / f"{agent_id}.db"),
                embedding_model="simple",
                embedding_dimensions=32,
                graph_store_backend="in_memory",
                extraction_model="noop",
                lightweight_model="noop",
            ),
        )
        instances.append(hippocampus)
        return hippocampus

    yield _create

    for hippocampus in instances:
        await hippocampus.close()
