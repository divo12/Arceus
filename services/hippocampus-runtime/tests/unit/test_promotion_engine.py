from __future__ import annotations

from datetime import timedelta

import pytest

from arceus.core.hippocampus.engines.graph_store import GraphStore
from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
from arceus.core.hippocampus.types import MemoryType, MemoryUnit, RelationType
from arceus.core.hippocampus.utils.time import utc_now
from ..support.fakes.in_memory_graph import InMemoryGraphStoreBackend
from ..support.fakes.in_memory_vector import InMemoryVectorStore
from ..support.fakes.mock_embedding import MockEmbeddingEngine
from ..support.fakes.noop_llm import NoopLLMEngine

PromotionFixture = tuple[PromotionEngine, InMemoryVectorStore, InMemoryGraphStoreBackend]


class PromotionLLMDouble(NoopLLMEngine):
    def __init__(
        self,
        *,
        classify_result: str = "NO_CONTRADICTION",
        generated_text: str = "This memory consistently guided work and stayed reliable.",
    ) -> None:
        super().__init__(model_name="noop")
        self.classify_result = classify_result
        self.generated_text = generated_text

    async def generate(self, prompt: str, **kwargs) -> str:
        del prompt, kwargs
        return self.generated_text

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
        del prompt, kwargs
        assert self.classify_result in options
        return self.classify_result


def _memory(
    *,
    memory_id: str,
    memory_type: MemoryType,
    content: str = "JWT auth detail",
    embedding: list[float] | None = None,
    confidence: float = 0.9,
    usage_count: int = 10,
    age_days: int = 14,
    promotion_status: str | None = None,
    metadata: dict | None = None,
) -> MemoryUnit:
    created_at = utc_now() - timedelta(days=age_days)
    base_metadata = {"usage_count": usage_count}
    if metadata:
        base_metadata.update(metadata)
    return MemoryUnit(
        id=memory_id,
        agent_id="agent-1",
        content=content,
        embedding=embedding or [1.0, 0.0],
        memory_type=memory_type,
        confidence=confidence,
        container="startup:1:emp:agent-1",
        metadata=base_metadata,
        created_at=created_at,
        updated_at=created_at,
        promotion_status=promotion_status,
    )


@pytest.fixture
def promotion_engine_fixture() -> PromotionFixture:
    vector_store = InMemoryVectorStore()
    graph_backend = InMemoryGraphStoreBackend()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(graph_backend, embedding)
    engine = PromotionEngine(
        agent_id="agent-1",
        vector_store=vector_store,
        graph_store=graph_store,
        embedding_engine=embedding,
        llm_light=PromotionLLMDouble(),
    )
    return engine, vector_store, graph_backend


def test_qualifies_for_static(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, _, _ = promotion_engine_fixture
    memory = _memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC)

    assert engine.qualifies_for_static(memory) is True


def test_does_not_qualify_low_usage(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, _, _ = promotion_engine_fixture
    memory = _memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC, usage_count=9)

    assert engine.qualifies_for_static(memory) is False


def test_does_not_qualify_low_confidence(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, _, _ = promotion_engine_fixture
    memory = _memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC, confidence=0.79)

    assert engine.qualifies_for_static(memory) is False


def test_does_not_qualify_young(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, _, _ = promotion_engine_fixture
    memory = _memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC, age_days=13)

    assert engine.qualifies_for_static(memory) is False


def test_does_not_qualify_already_promoted(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, _, _ = promotion_engine_fixture
    memory = _memory(
        memory_id="dyn-1",
        memory_type=MemoryType.DYNAMIC,
        promotion_status="promoted",
    )

    assert engine.qualifies_for_static(memory) is False


@pytest.mark.asyncio
async def test_run_promotions_happy_path(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, graph_backend = promotion_engine_fixture
    await vector_store.upsert(_memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC))

    events = await engine.run_promotions()

    static_memories = await vector_store.list_by_type("agent-1", memory_type=MemoryType.STATIC)
    assert len(events) == 1
    assert events[0].reason == "This memory consistently guided work and stayed reliable."
    assert len(static_memories) == 1
    assert static_memories[0].memory_type is MemoryType.STATIC
    assert static_memories[0].metadata["promoted_from"] == "dyn-1"
    assert await vector_store.get("dyn-1") is None
    assert any(
        edge.relation_type is RelationType.PROMOTED_FROM
        for edge in graph_backend.list_edges()
    )


@pytest.mark.asyncio
async def test_run_promotions_contradiction_blocks(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    _, vector_store, graph_backend = promotion_engine_fixture
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(graph_backend, embedding)
    engine = PromotionEngine(
        agent_id="agent-1",
        vector_store=vector_store,
        graph_store=graph_store,
        embedding_engine=embedding,
        llm_light=PromotionLLMDouble(classify_result="CONTRADICTION"),
    )
    await vector_store.upsert(_memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC))
    await vector_store.upsert(
        _memory(
            memory_id="stat-1",
            memory_type=MemoryType.STATIC,
            content="We never use JWT",
        )
    )

    events = await engine.run_promotions()

    assert events == []
    assert await vector_store.get("dyn-1") is not None
    assert graph_backend.list_edges() == []


@pytest.mark.asyncio
async def test_run_promotions_with_empty_static_store() -> None:
    vector_store = InMemoryVectorStore()
    graph_backend = InMemoryGraphStoreBackend()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(graph_backend, embedding)
    engine = PromotionEngine(
        agent_id="agent-1",
        vector_store=vector_store,
        graph_store=graph_store,
        embedding_engine=embedding,
        llm_light=PromotionLLMDouble(classify_result="CONTRADICTION"),
    )
    await vector_store.upsert(_memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC))

    events = await engine.run_promotions()
    static_memories = await vector_store.list_by_type("agent-1", memory_type=MemoryType.STATIC)

    assert len(events) == 1
    assert len(static_memories) == 1
    assert static_memories[0].metadata["promoted_from"] == "dyn-1"


@pytest.mark.asyncio
async def test_run_promotions_rate_limit(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, _ = promotion_engine_fixture
    for index in range(10):
        await vector_store.upsert(
            _memory(
                memory_id=f"dyn-{index}",
                memory_type=MemoryType.DYNAMIC,
                embedding=[1.0, float(index)],
            )
        )

    events = await engine.run_promotions()
    static_memories = await vector_store.list_by_type("agent-1", memory_type=MemoryType.STATIC)

    assert len(events) == 5
    assert len(static_memories) == 5


@pytest.mark.asyncio
async def test_demote_static_to_dynamic(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, _ = promotion_engine_fixture
    await vector_store.upsert(_memory(memory_id="stat-1", memory_type=MemoryType.STATIC))

    demoted = await engine.demote("stat-1", "unused_during_probation")

    assert demoted is not None
    assert demoted.memory_type is MemoryType.DYNAMIC
    assert demoted.confidence == pytest.approx(0.72)
    assert demoted.metadata["demoted_from"] == "stat-1"
    assert await vector_store.get("stat-1") is None


@pytest.mark.asyncio
async def test_demote_non_static_returns_none(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, _ = promotion_engine_fixture
    await vector_store.upsert(_memory(memory_id="dyn-1", memory_type=MemoryType.DYNAMIC))

    assert await engine.demote("dyn-1", "unused_static_60d") is None


@pytest.mark.asyncio
async def test_probation_demotion(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, _ = promotion_engine_fixture
    static_memory = _memory(
        memory_id="stat-1",
        memory_type=MemoryType.STATIC,
        metadata={
            "probation_until": (utc_now() - timedelta(days=2)).isoformat(),
            "probation_usage_count": 0,
        },
    )
    await vector_store.upsert(static_memory)

    demoted = await engine.check_probation_demotions()

    assert len(demoted) == 1
    assert demoted[0].memory_type is MemoryType.DYNAMIC


@pytest.mark.asyncio
async def test_unused_static_demotion_60d(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, _ = promotion_engine_fixture
    static_memory = _memory(
        memory_id="stat-1",
        memory_type=MemoryType.STATIC,
        metadata={"last_accessed": (utc_now() - timedelta(days=60)).isoformat()},
    )
    await vector_store.upsert(static_memory)

    demoted = await engine.check_unused_static_demotions()

    assert len(demoted) == 1
    assert demoted[0].memory_type is MemoryType.DYNAMIC


@pytest.mark.asyncio
async def test_graph_edge_created_on_promotion(
    promotion_engine_fixture: PromotionFixture,
) -> None:
    engine, vector_store, graph_backend = promotion_engine_fixture
    await vector_store.upsert(_memory(memory_id="dyn-graph", memory_type=MemoryType.DYNAMIC))

    await engine.run_promotions()

    promoted_edges = [
        edge
        for edge in graph_backend.list_edges()
        if edge.relation_type is RelationType.PROMOTED_FROM
    ]
    assert len(promoted_edges) == 1
    assert promoted_edges[0].target_id == "dyn-graph"
