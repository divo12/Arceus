import pytest

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import GraphEntity, MemoryType


@pytest.mark.asyncio
async def test_hippocampus_create_remember_and_recall_prioritizes_static(tmp_path) -> None:
    config = HippocampusConfig(
        sqlite_path=str(tmp_path / "hippocampus.db"),
        embedding_model="simple",
        embedding_dimensions=32,
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)

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
    assert all(memory.container == container for memory in recalled)
    assert recalled[0].created_at.tzinfo is not None
    await hippocampus.close()


@pytest.mark.asyncio
async def test_hippocampus_recall_does_not_cross_scope(tmp_path) -> None:
    config = HippocampusConfig(
        sqlite_path=str(tmp_path / "hippocampus.db"),
        embedding_model="simple",
        embedding_dimensions=32,
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)

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

    recalled = await hippocampus.recall("JWT authentication", container=own_container, top_k=5)

    assert len(recalled) == 1
    assert recalled[0].container == own_container
    await hippocampus.close()


@pytest.mark.asyncio
async def test_hippocampus_recall_can_return_graph_results_when_enabled(tmp_path) -> None:
    config = HippocampusConfig(
        sqlite_path=str(tmp_path / "hippocampus.db"),
        embedding_model="simple",
        embedding_dimensions=32,
        graph_store_backend="in_memory",
    )
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)
    container = "startup:startup-1:emp:agent-1"

    await hippocampus.graph_store.create_node(
        GraphEntity(
            name="JWT",
            entity_type="technology",
            embedding=await hippocampus._embedding.embed("JWT"),
            container=container,
        )
    )

    recalled = await hippocampus.recall("JWT", container=container, top_k=1, include_graph=True)

    assert len(recalled) == 1
    assert getattr(recalled[0], "name", "") == "JWT"
    await hippocampus.close()
