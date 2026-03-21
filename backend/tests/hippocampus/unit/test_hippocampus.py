import pytest

from arceus.core.hippocampus.config import HippocampusConfig
import arceus.core.hippocampus.hippocampus as hippocampus_module
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import GraphEntity, MemoryType
from tests.hippocampus.support.fakes.dict_cache import DictCacheStore
from tests.hippocampus.support.fakes.in_memory_graph import InMemoryGraphStoreBackend
from tests.hippocampus.support.fakes.in_memory_vector import InMemoryVectorStore
from tests.hippocampus.support.fakes.noop_llm import NoopLLMEngine
from tests.hippocampus.support.fakes.sqlite_relational import SQLiteRelationalStore


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
async def test_hippocampus_recall_can_return_graph_results_when_enabled(
    patch_fake_hippocampus_runtime,
) -> None:
    patch_fake_hippocampus_runtime(embedding_dimensions=32)
    config = HippocampusConfig(embedding_dimensions=32)
    hippocampus = await Hippocampus.create(agent_id="agent-1", config=config)
    try:
        container = "startup:startup-1:emp:agent-1"

        await hippocampus.graph_store.create_node(
            GraphEntity(
                name="JWT",
                entity_type="technology",
                embedding=await hippocampus._embedding.embed("JWT"),
                container=container,
            )
        )

        recalled = await hippocampus.recall(
            "JWT",
            container=container,
            top_k=1,
            include_graph=True,
        )

        assert len(recalled) == 1
        assert getattr(recalled[0], "name", "") == "JWT"
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


@pytest.mark.asyncio
async def test_hippocampus_create_enforces_strict_embedding_on_production_profile(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeEmbeddingEngine:
        def __init__(self) -> None:
            self.warmed = False

        async def warmup(self) -> None:
            self.warmed = True

        async def embed(self, text: str) -> list[float]:
            del text
            return [0.0]

        async def embed_batch(self, texts: list[str]) -> list[list[float]]:
            del texts
            return [[0.0]]

    fake_embedding = FakeEmbeddingEngine()
    created: dict[str, object] = {}
    relational_store = SQLiteRelationalStore(str(tmp_path / "hippo.db"))
    vector_store = InMemoryVectorStore()
    cache_backend = DictCacheStore()
    graph_backend = InMemoryGraphStoreBackend()

    def fake_create_embedding_engine(
        backend: str,
        dimensions: int,
        *,
        device: str = "cpu",
        strict: bool = False,
    ) -> FakeEmbeddingEngine:
        created["backend"] = backend
        created["dimensions"] = dimensions
        created["device"] = device
        created["strict"] = strict
        return fake_embedding

    monkeypatch.setattr(
        hippocampus_module,
        "create_vector_store",
        lambda backend, config: vector_store,
    )
    monkeypatch.setattr(
        hippocampus_module,
        "create_graph_store",
        lambda backend, config: graph_backend,
    )
    monkeypatch.setattr(
        hippocampus_module,
        "create_cache",
        lambda backend, config: cache_backend,
    )
    monkeypatch.setattr(
        hippocampus_module,
        "create_relational",
        lambda backend, config: relational_store,
    )
    monkeypatch.setattr(
        hippocampus_module,
        "create_embedding_engine",
        fake_create_embedding_engine,
    )
    monkeypatch.setattr(
        hippocampus_module,
        "create_llm_engine",
        lambda model_name, config: NoopLLMEngine(model_name=model_name),
    )

    hippocampus = await Hippocampus.create(
        agent_id="agent-1",
        config=HippocampusConfig(
            relational_backend="postgresql",
            vector_store_backend="pgvector",
            cache_backend="redis",
            embedding_model="all-MiniLM-L6-v2",
            embedding_dimensions=1,
            extraction_model="gpt-4.1",
            lightweight_model="gpt-4.1-mini",
        ),
    )

    try:
        assert created["strict"] is True
        assert fake_embedding.warmed is True
    finally:
        await hippocampus.close()
