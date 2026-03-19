import sys
from datetime import UTC, datetime, timedelta

import pytest

from arceus.core.hippocampus.backends.dict_cache import DictCacheStore
from arceus.core.hippocampus.backends.factory import create_embedding_engine, create_graph_store
from arceus.core.hippocampus.backends.in_memory_vector import InMemoryVectorStore
from arceus.core.hippocampus.backends.sentence_transformers_embedding import (
    SentenceTransformerEmbeddingEngine,
)
from arceus.core.hippocampus.backends.simple_embedding import SimpleEmbeddingEngine
from arceus.core.hippocampus.backends.sqlite_relational import SQLiteRelationalStore
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.types import Habit, HabitFormation, MemoryType, MemoryUnit


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
        memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
        top_k=5,
    )
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
        memory_types=[MemoryType.STATIC, MemoryType.DYNAMIC],
        top_k=5,
    )
    assert static_memory.content not in [memory.content for memory in post_delete]


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


def test_embedding_factory_distinguishes_simple_and_sentence_transformer_backends() -> None:
    simple = create_embedding_engine("simple", dimensions=32)
    sentence_model = create_embedding_engine("all-MiniLM-L6-v2", dimensions=384)

    assert isinstance(simple, SimpleEmbeddingEngine)
    assert isinstance(sentence_model, SentenceTransformerEmbeddingEngine)


@pytest.mark.asyncio
async def test_sentence_transformer_embedding_engine_uses_loaded_model(monkeypatch) -> None:
    class FakeVector:
        def __init__(self, values: list[float]) -> None:
            self._values = values

        def tolist(self) -> list[float]:
            return self._values

    class FakeModel:
        def encode(self, payload, normalize_embeddings: bool = True):  # noqa: ANN001
            assert normalize_embeddings is True
            if isinstance(payload, list):
                return [FakeVector([1.0, 0.0]), FakeVector([0.0, 1.0])]
            return FakeVector([0.6, 0.8])

    engine = SentenceTransformerEmbeddingEngine(model_name="all-MiniLM-L6-v2")

    async def fake_get_model() -> FakeModel:
        return FakeModel()

    monkeypatch.setattr(engine, "_get_model", fake_get_model)

    assert await engine.embed("hello world") == [0.6, 0.8]
    assert await engine.embed_batch(["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]


@pytest.mark.asyncio
async def test_sentence_transformer_embedding_engine_logs_warning_and_falls_back(
    monkeypatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class BrokenSentenceTransformer:
        def __init__(self, model_name: str) -> None:
            raise RuntimeError(f"cannot load {model_name}")

    engine = SentenceTransformerEmbeddingEngine(model_name="all-MiniLM-L6-v2")
    fallback = SimpleEmbeddingEngine(dimensions=384)

    class FakeSentenceTransformersModule:
        SentenceTransformer = BrokenSentenceTransformer

    monkeypatch.setitem(sys.modules, "sentence_transformers", FakeSentenceTransformersModule())

    with caplog.at_level("WARNING"):
        vector = await engine.embed("hello world")

    assert vector == await fallback.embed("hello world")
    assert "Falling back to simple embeddings" in caplog.text


def test_graph_store_factory_requires_explicit_in_memory_backend_for_now() -> None:
    config = HippocampusConfig()

    with pytest.raises(ValueError, match="Neo4j backend not yet implemented"):
        create_graph_store("neo4j", config)
