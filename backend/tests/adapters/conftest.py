"""Shared fixtures for adapter tests."""
from __future__ import annotations

from pathlib import Path

import pytest

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus


@pytest.fixture
def hippocampus_factory(tmp_path: Path):
    """Factory fixture that creates a Hippocampus with in-memory/noop backends."""

    async def _create(agent_id: str) -> Hippocampus:
        return await Hippocampus.create(
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

    return _create
