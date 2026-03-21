from __future__ import annotations

import pytest

from arceus.core.hippocampus.backends.pgvector_store import PGVectorStore
from arceus.core.hippocampus.backends.postgres_relational import PostgreSQLRelationalStore
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.types import Habit, HabitFormation, MemoryType, MemoryUnit

pytestmark = [
    pytest.mark.integration,
    pytest.mark.postgres,
    pytest.mark.pgvector,
]


@pytest.mark.asyncio
async def test_postgresql_relational_store_restart_round_trip(
    postgres_url: str,
    schema_name: str,
) -> None:
    store = PostgreSQLRelationalStore(url=postgres_url, schema=schema_name)
    habit = Habit(
        agent_id="agent-it",
        trigger_condition="before deploy",
        action="review migration plan",
        confidence=0.9,
        usage_count=2,
        formed_from_id="pattern-it",
        formation_mode=HabitFormation.AUTO,
    )

    await store.initialize()
    await store.insert_habit(habit)
    await store.close()

    reopened = PostgreSQLRelationalStore(url=postgres_url, schema=schema_name)
    await reopened.initialize()
    loaded = await reopened.get_habit(habit.id)

    assert loaded == habit
    await reopened.close()


@pytest.mark.asyncio
async def test_pgvector_store_round_trip_and_soft_delete(
    postgres_url: str,
    schema_name: str,
) -> None:
    store = PGVectorStore(
        url=postgres_url,
        schema=schema_name,
        dimensions=3,
    )
    await store.initialize()

    static_memory = MemoryUnit(
        agent_id="agent-it",
        content="auth rollout is staged",
        embedding=[1.0, 0.0, 0.0],
        memory_type=MemoryType.STATIC,
        container="startup:integration",
    )
    dynamic_memory = MemoryUnit(
        agent_id="agent-it",
        content="jwt refresh migration is active",
        embedding=[0.9, 0.1, 0.0],
        memory_type=MemoryType.DYNAMIC,
        container="startup:integration",
    )

    await store.upsert(static_memory)
    await store.upsert(dynamic_memory)

    results = await store.search(
        embedding=[1.0, 0.0, 0.0],
        container="startup:integration",
        agent_id="agent-it",
        top_k=5,
    )
    assert {memory.id for memory in results} == {static_memory.id, dynamic_memory.id}

    listed = await store.list_by_type(
        agent_id="agent-it",
        container="startup:integration",
        memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
    )
    assert {memory.id for memory in listed} == {static_memory.id, dynamic_memory.id}

    await store.soft_delete(static_memory.id, reason="integration_cleanup")
    loaded = await store.get(static_memory.id)
    assert loaded is None

    await store.close()


@pytest.mark.asyncio
async def test_hippocampus_postgres_pgvector_smoke(
    postgres_url: str,
    unique_id: str,
) -> None:
    container = f"startup:it:{unique_id}"
    hippocampus = await Hippocampus.create(
        agent_id=f"agent-{unique_id}",
        config=HippocampusConfig(
            relational_backend="postgresql",
            postgres_url=postgres_url,
            postgres_schema=f"hippo_it_{unique_id}",
            vector_store_backend="pgvector",
            embedding_model="simple",
            embedding_dimensions=3,
            cache_backend="dict",
            graph_store_backend="in_memory",
            extraction_model="noop",
            lightweight_model="noop",
        ),
    )

    await hippocampus.remember(
        "staged rollout is the default release strategy",
        container,
        MemoryType.STATIC,
    )
    await hippocampus.remember(
        "jwt refresh migration is active this sprint",
        container,
        MemoryType.DYNAMIC,
    )
    recalled = await hippocampus.recall(
        "release strategy",
        container,
        top_k=5,
        include_graph=False,
    )
    summary = await hippocampus.get_summary()

    assert len(recalled) >= 1
    assert summary.static_fact_count == 1
    assert summary.dynamic_fact_count == 1

    await hippocampus.close()
