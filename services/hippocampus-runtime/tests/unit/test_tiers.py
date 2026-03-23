import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from arceus.core.hippocampus.engines.graph_store import GraphStore
from arceus.core.hippocampus.tiers.dynamic import DynamicMemory
from arceus.core.hippocampus.tiers.static import StaticMemory
from arceus.core.hippocampus.tiers.working import WorkingMemory
from arceus.core.hippocampus.types import ExtractedFact, MemoryType, MemoryUnit
from ..support.fakes.dict_cache import DictCacheStore
from ..support.fakes.in_memory_graph import InMemoryGraphStoreBackend
from ..support.fakes.in_memory_vector import InMemoryVectorStore
from ..support.fakes.mock_embedding import MockEmbeddingEngine


class SlowDictCacheStore(DictCacheStore):
    async def append(self, key: str, value: str, ttl_seconds: int = 3600) -> None:
        await asyncio.sleep(0)
        await super().append(key, value, ttl_seconds=ttl_seconds)


@pytest.mark.asyncio
async def test_working_memory_load_append_get_and_clear() -> None:
    store = DictCacheStore()
    memory = WorkingMemory(agent_id="agent-1", backend=store)

    await memory.load_task_context("task-1", {"goal": "build auth"})
    await memory.append_conversation("task-1", {"role": "assistant", "content": "Working on it"})

    context = await memory.get_current_context("task-1")
    assert context["task"] == {"goal": "build auth"}
    assert context["conversation"] == [{"role": "assistant", "content": "Working on it"}]
    assert context["scratchpad"] is None

    await memory.clear_task("task-1")
    cleared = await memory.get_current_context("task-1")
    assert cleared == {"task": None, "conversation": None, "scratchpad": None}


@pytest.mark.asyncio
async def test_working_memory_append_conversation_is_safe_under_concurrency() -> None:
    store = SlowDictCacheStore()
    memory = WorkingMemory(agent_id="agent-1", backend=store)

    messages = [
        {"role": "assistant", "content": f"message-{index}"}
        for index in range(20)
    ]

    await asyncio.gather(
        *(memory.append_conversation("task-1", message) for message in messages)
    )

    context = await memory.get_current_context("task-1")
    assert context["conversation"] is not None
    assert len(context["conversation"]) == len(messages)
    assert {item["content"] for item in context["conversation"]} == {
        message["content"] for message in messages
    }


@pytest.mark.asyncio
async def test_static_memory_add_and_search() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    memory = StaticMemory(
        agent_id="agent-1",
        vector_store=vector_store,
        embedding_engine=embedding,
    )

    await memory.add(
        ExtractedFact(
            text="We use JWT for authentication",
            memory_type=MemoryType.STATIC,
            confidence=0.95,
            is_permanent=True,
        ),
        container="startup:1:emp:e1",
    )

    results = await memory.search("JWT authentication", "startup:1:emp:e1", top_k=3)
    assert len(results) == 1
    assert results[0].memory_type is MemoryType.STATIC
    assert results[0].source_type == "remember"


@pytest.mark.asyncio
async def test_tier_add_preserves_fact_source_type() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    static_memory = StaticMemory(
        agent_id="agent-1",
        vector_store=vector_store,
        embedding_engine=embedding,
    )
    dynamic_memory = DynamicMemory(
        agent_id="agent-1",
        vector_store=vector_store,
        embedding_engine=embedding,
    )

    static_fact = ExtractedFact(
        text="Board approved weekly KPI reviews",
        memory_type=MemoryType.STATIC,
        confidence=0.95,
        source_type="meeting",
        is_permanent=True,
    )
    dynamic_fact = ExtractedFact(
        text="Auth migration follow-up is due tomorrow",
        memory_type=MemoryType.DYNAMIC,
        confidence=0.8,
        source_type="conversation",
    )

    static_unit = await static_memory.add(static_fact, container="startup:1:emp:e1")
    dynamic_unit = await dynamic_memory.add(dynamic_fact, container="startup:1:emp:e1")

    assert static_unit.source_type == "meeting"
    assert dynamic_unit.source_type == "conversation"


@pytest.mark.asyncio
async def test_tiers_mirror_memories_into_graph_nodes() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_backend = InMemoryGraphStoreBackend()
    graph_store = GraphStore(graph_backend, embedding)
    static_memory = StaticMemory(
        agent_id="agent-1",
        vector_store=vector_store,
        embedding_engine=embedding,
        graph_store=graph_store,
    )
    dynamic_memory = DynamicMemory(
        agent_id="agent-1",
        vector_store=vector_store,
        embedding_engine=embedding,
        graph_store=graph_store,
    )

    static_unit = await static_memory.add(
        ExtractedFact(
            text="JWT is our default authentication strategy",
            memory_type=MemoryType.STATIC,
            confidence=0.95,
            is_permanent=True,
        ),
        container="startup:1:emp:e1",
    )
    dynamic_unit = await dynamic_memory.add(
        ExtractedFact(
            text="The PM wants auth metrics in tomorrow's review",
            memory_type=MemoryType.DYNAMIC,
            confidence=0.8,
        ),
        container="startup:1:emp:e1",
    )

    static_node = await graph_backend.get_node(static_unit.id)
    dynamic_node = await graph_backend.get_node(dynamic_unit.id)

    assert static_node is not None
    assert static_node.entity_type == "static"
    assert dynamic_node is not None
    assert dynamic_node.entity_type == "dynamic"


@pytest.mark.asyncio
async def test_dynamic_memory_filters_decayed_memories() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    memory = DynamicMemory(
        agent_id="agent-1",
        vector_store=vector_store,
        embedding_engine=embedding,
        half_life_days=30.0,
        decay_threshold=0.1,
    )

    fresh = await memory.add(
        ExtractedFact(
            text="Auth bug is happening in staging",
            memory_type=MemoryType.DYNAMIC,
            confidence=0.8,
        ),
        container="startup:1:emp:e1",
    )

    stale_embedding = await embedding.embed("Old auth issue that no longer matters")
    stale = MemoryUnit(
        agent_id="agent-1",
        startup_id="startup-1",
        content="Old auth issue that no longer matters",
        embedding=stale_embedding,
        memory_type=MemoryType.DYNAMIC,
        confidence=0.7,
        relevance_score=1.0,
        container="startup:1:emp:e1",
        created_at=datetime.now(UTC) - timedelta(days=200),
        updated_at=datetime.now(UTC) - timedelta(days=200),
    )
    await vector_store.upsert(stale)

    results = await memory.search("auth issue", "startup:1:emp:e1", top_k=5)
    assert [item.id for item in results] == [fresh.id]

    recent = await memory.get_recent("startup:1:emp:e1", days=7)
    assert [item.id for item in recent] == [fresh.id]
    assert fresh.created_at.tzinfo is not None

    decayed = await memory.find_decayed()
    assert [item.id for item in decayed] == [stale.id]

    expired_candidate = replace(
        fresh,
        expires_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    await vector_store.upsert(expired_candidate)
    expired = await memory.find_expired()
    assert [item.id for item in expired] == [expired_candidate.id]


def test_dynamic_memory_rejects_non_positive_half_life() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)

    with pytest.raises(ValueError, match="half_life_days must be greater than 0"):
        DynamicMemory(
            agent_id="agent-1",
            vector_store=vector_store,
            embedding_engine=embedding,
            half_life_days=0,
        )

    with pytest.raises(ValueError, match="half_life_days must be greater than 0"):
        DynamicMemory(
            agent_id="agent-1",
            vector_store=vector_store,
            embedding_engine=embedding,
            half_life_days=-1,
        )
