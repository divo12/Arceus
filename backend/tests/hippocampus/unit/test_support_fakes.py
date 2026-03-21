from datetime import UTC, datetime, timedelta

import pytest

from arceus.core.hippocampus.types import (
    GraphEntity,
    GraphRelationship,
    Habit,
    HabitFormation,
    MemoryType,
    MemoryUnit,
    MemoryVisibility,
    RelationType,
)
from tests.hippocampus.support.fakes.dict_cache import DictCacheStore
from tests.hippocampus.support.fakes.in_memory_graph import InMemoryGraphStoreBackend
from tests.hippocampus.support.fakes.in_memory_vector import InMemoryVectorStore
from tests.hippocampus.support.fakes.mock_embedding import MockEmbeddingEngine
from tests.hippocampus.support.fakes.sqlite_relational import SQLiteRelationalStore


@pytest.mark.asyncio
async def test_dict_cache_store_respects_ttl_and_prefix_clear() -> None:
    current_time = [100.0]
    store = DictCacheStore(time_fn=lambda: current_time[0])

    await store.set("wm:task:1", "payload", ttl_seconds=10)
    assert await store.get("wm:task:1") == "payload"

    current_time[0] = 111.0
    assert await store.get("wm:task:1") is None

    await store.set("wm:task:2", "task", ttl_seconds=100)
    await store.set("wm:conv:2", "conversation", ttl_seconds=100)

    assert await store.get_all("wm:") == {
        "wm:task:2": "task",
        "wm:conv:2": "conversation",
    }

    await store.clear("wm:")
    assert await store.get_all("wm:") == {}


@pytest.mark.asyncio
async def test_in_memory_vector_store_filters_by_container_type_and_deletion() -> None:
    store = InMemoryVectorStore()
    now = datetime.now(UTC)

    static_memory = MemoryUnit(
        agent_id="agent-1",
        startup_id="startup-1",
        content="JWT is our default auth strategy",
        embedding=[1.0, 0.0],
        memory_type=MemoryType.STATIC,
        container="startup:1:emp:e1",
        updated_at=now,
    )
    dynamic_memory = MemoryUnit(
        agent_id="agent-1",
        startup_id="startup-1",
        content="JWT tokens are expiring too quickly in staging",
        embedding=[0.9, 0.1],
        memory_type=MemoryType.DYNAMIC,
        container="startup:1:emp:e1",
        updated_at=now,
    )
    other_container_memory = MemoryUnit(
        agent_id="agent-2",
        startup_id="startup-1",
        content="JWT is also used in another employee scope",
        embedding=[1.0, 0.0],
        memory_type=MemoryType.STATIC,
        container="startup:1:emp:e2",
        updated_at=now,
    )
    expired_memory = MemoryUnit(
        agent_id="agent-1",
        startup_id="startup-1",
        content="Temporary blocker",
        embedding=[0.1, 0.9],
        memory_type=MemoryType.DYNAMIC,
        container="startup:1:emp:e1",
        expires_at=now - timedelta(hours=1),
        updated_at=now,
    )

    await store.upsert(static_memory)
    await store.upsert(dynamic_memory)
    await store.upsert(other_container_memory)
    await store.upsert(expired_memory)

    results = await store.search(
        embedding=[1.0, 0.0],
        container="startup:1:emp:e1",
        agent_id="agent-1",
        memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
        top_k=5,
    )
    # search() intentionally does NOT filter by expires_at.
    # Only find_expired() filters for expiry — search returns all non-deleted memories.
    # This is by design: expiry is handled by GC, not by search-time filtering.
    assert [memory.content for memory in results] == [
        static_memory.content,
        dynamic_memory.content,
        expired_memory.content,
    ]

    static_only = await store.list_by_type(
        agent_id="agent-1",
        container="startup:1:emp:e1",
        memory_type=MemoryType.STATIC,
    )
    assert [memory.content for memory in static_only] == [static_memory.content]

    expired = await store.find_expired(
        agent_id="agent-1",
        memory_type=MemoryType.DYNAMIC,
        before=now,
    )
    assert [memory.content for memory in expired] == [expired_memory.content]

    await store.soft_delete(static_memory.id, reason="no longer valid")
    post_delete = await store.search(
        embedding=[1.0, 0.0],
        container="startup:1:emp:e1",
        agent_id="agent-1",
        memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
        top_k=5,
    )
    assert static_memory.content not in [memory.content for memory in post_delete]


@pytest.mark.asyncio
async def test_in_memory_vector_store_respects_visibility_when_searching() -> None:
    store = InMemoryVectorStore()

    private_memory = MemoryUnit(
        id="private-1",
        agent_id="pm-1",
        content="PM private note",
        embedding=[1.0, 0.0, 0.0],
        memory_type=MemoryType.DYNAMIC,
        container="startup:acme",
        visibility=MemoryVisibility.PRIVATE,
    )
    shared_memory = MemoryUnit(
        id="shared-1",
        agent_id="pm-1",
        content="Enterprise needs security review",
        embedding=[1.0, 0.0, 0.0],
        memory_type=MemoryType.DYNAMIC,
        container="startup:acme",
        visibility=MemoryVisibility.STARTUP_SHARED,
    )

    await store.upsert(private_memory)
    await store.upsert(shared_memory)

    own_results = await store.search(
        embedding=[1.0, 0.0, 0.0],
        container="startup:acme",
        agent_id="pm-1",
    )
    assert {memory.id for memory in own_results} == {"private-1", "shared-1"}

    other_results = await store.search(
        embedding=[1.0, 0.0, 0.0],
        container="startup:acme",
        agent_id="cto-1",
    )
    assert {memory.id for memory in other_results} == {"shared-1"}


@pytest.mark.asyncio
async def test_in_memory_vector_store_top_k_truncation() -> None:
    store = InMemoryVectorStore()
    for index in range(10):
        await store.upsert(
            MemoryUnit(
                agent_id="agent-1",
                content=f"memory-{index}",
                embedding=[float(index) / 10] * 32,
                memory_type=MemoryType.DYNAMIC,
                container="test",
            )
        )

    results = await store.search(
        embedding=[0.5] * 32,
        container="test",
        agent_id="agent-1",
        top_k=3,
    )

    assert len(results) == 3


@pytest.mark.asyncio
async def test_sqlite_relational_store_reuses_single_connection_for_in_memory_database() -> None:
    store = SQLiteRelationalStore(":memory:")
    await store.initialize()

    first_connection = store._connection
    assert first_connection is not None

    habit = Habit(
        agent_id="agent-1",
        trigger_condition="before committing code",
        action="run tests first",
        confidence=0.9,
        formed_from_id="pattern-1",
        formation_mode=HabitFormation.AUTO,
    )

    await store.insert_habit(habit)
    loaded = await store.get_habit(habit.id)
    listed = await store.list_habits(agent_id="agent-1")

    assert loaded.id == habit.id
    assert [item.id for item in listed] == [habit.id]
    assert store._connection is first_connection

    await store.close()
    assert store._connection is None


def test_mock_embedding_engine_logs_production_warning(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level("WARNING"):
        engine = MockEmbeddingEngine(dimensions=32)

    assert engine is not None
    assert "not suitable for production use" in caplog.text


@pytest.mark.asyncio
async def test_in_memory_graph_backend_rejects_unknown_update_fields() -> None:
    backend = InMemoryGraphStoreBackend()
    node = GraphEntity(name="JWT", entity_type="technology", embedding=[1.0], container="scope")
    await backend.create_node(node)

    with pytest.raises(ValueError, match="Invalid GraphEntity fields"):
        await backend.update_node(node.id, {"unknown_field": 123})


@pytest.mark.asyncio
async def test_in_memory_graph_backend_create_edge_requires_existing_nodes() -> None:
    backend = InMemoryGraphStoreBackend()

    with pytest.raises(KeyError, match="Cannot create edge"):
        await backend.create_edge(
            GraphRelationship(
                source_id="missing-source",
                target_id="missing-target",
                relation_type=RelationType.RELATED_TO,
            )
        )
