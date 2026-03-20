from __future__ import annotations

from dataclasses import replace

import pytest

from arceus.core.hippocampus.backends.in_memory_graph import InMemoryGraphStoreBackend
from arceus.core.hippocampus.backends.in_memory_vector import InMemoryVectorStore
from arceus.core.hippocampus.backends.simple_embedding import MockEmbeddingEngine
from arceus.core.hippocampus.engines.extractor import MemoryExtractor
from arceus.core.hippocampus.engines.graph_store import GraphStore
from arceus.core.hippocampus.tiers.dynamic import DynamicMemory
from arceus.core.hippocampus.tiers.static import StaticMemory
from arceus.core.hippocampus.types import (
    ExtractedFact,
    ExtractionMode,
    GraphEntity,
    Habit,
    MemoryAction,
    MemoryType,
    RelationType,
)


class FakeLLM:
    def __init__(
        self,
        *,
        extracted_facts: list[ExtractedFact] | None = None,
        decision: dict | None = None,
        classification: str = "uses",
    ) -> None:
        self.extracted_facts = extracted_facts or []
        self.decision = decision or {"action": "NONE", "target_id": "", "reason": "noop"}
        self.classification = classification
        self.last_prompt: str | None = None

    async def extract_structured(
        self,
        prompt: str,
        messages: list[dict],
        output_schema: type,
    ) -> list:
        del messages, output_schema
        self.last_prompt = prompt
        return self.extracted_facts

    async def decide(self, prompt: str, **kwargs) -> dict:
        del prompt, kwargs
        return self.decision

    async def analyze(self, prompt: str, **kwargs) -> dict:
        del prompt, kwargs
        return {}

    async def generate(self, prompt: str, **kwargs) -> str:
        del prompt, kwargs
        return ""

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
        del prompt, kwargs
        assert self.classification in options
        return self.classification


class RecordingProceduralMemory:
    def __init__(self) -> None:
        self.habits: list[Habit] = []

    async def add_habit(self, habit: Habit) -> Habit:
        self.habits.append(habit)
        return habit


class FakeHippocampus:
    def __init__(
        self,
        *,
        static_memory: StaticMemory,
        dynamic_memory: DynamicMemory,
        graph_store: GraphStore,
        vector_store: InMemoryVectorStore,
        embedding_engine: MockEmbeddingEngine,
        procedural_memory: RecordingProceduralMemory | None = None,
    ) -> None:
        self.static_memory = static_memory
        self.dynamic_memory = dynamic_memory
        self.graph_store = graph_store
        if procedural_memory is not None:
            self.procedural_memory = procedural_memory
        self._vector_store = vector_store
        self._embedding = embedding_engine

    async def search(
        self,
        query: str,
        agent_id: str,
        container: str,
        top_k: int = 5,
    ) -> list:
        del agent_id
        embedding = await self._embedding.embed(query)
        return await self._vector_store.search(
            embedding=embedding,
            container=container,
            top_k=top_k,
        )

    async def soft_delete(self, memory_id: str, reason: str = "") -> None:
        await self._vector_store.soft_delete(memory_id, reason=reason)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "expected_fragment"),
    [
        (ExtractionMode.AGENT, "memory extraction system"),
        (ExtractionMode.SUB_AGENT, "sub-agent's task execution"),
        (ExtractionMode.MEETING, "meeting transcript between agents"),
    ],
)
async def test_memory_extractor_uses_correct_prompt_by_mode(
    mode: ExtractionMode,
    expected_fragment: str,
) -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(InMemoryGraphStoreBackend(), embedding)
    hippocampus = FakeHippocampus(
        static_memory=StaticMemory("agent-1", vector_store, embedding, graph_store),
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
    )
    llm = FakeLLM()
    llm_light = FakeLLM(classification="uses")
    extractor = MemoryExtractor(llm, llm_light, embedding, hippocampus)

    await extractor.extract(
        messages=[{"role": "assistant", "content": "sample"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
        mode=mode,
    )

    assert llm.last_prompt is not None
    assert expected_fragment in llm.last_prompt


@pytest.mark.asyncio
async def test_graph_store_creates_edges_by_name_and_tracks_version_history() -> None:
    backend = InMemoryGraphStoreBackend()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(backend, embedding)
    container = "startup:1:emp:e1"

    jwt = GraphEntity(
        name="JWT",
        entity_type="technology",
        embedding=await embedding.embed("JWT"),
        container=container,
    )
    auth_service = GraphEntity(
        name="AuthService",
        entity_type="concept",
        embedding=await embedding.embed("AuthService"),
        container=container,
    )
    old_version = GraphEntity(
        id="memory-v1",
        name="Auth uses JWT",
        entity_type="memory_version",
        embedding=await embedding.embed("Auth uses JWT"),
        container=container,
    )

    await graph_store.create_node(jwt)
    await graph_store.create_node(auth_service)
    await graph_store.create_node(old_version)

    edge_id = await graph_store.create_edge_by_name(
        "AuthService",
        "JWT",
        RelationType.USES,
        container=container,
    )
    assert edge_id is not None

    new_version = await graph_store.version_memory(
        old_memory_id="memory-v1",
        new_fact="Auth uses JWT with 24h expiry",
        container=container,
    )
    history = await graph_store.get_version_history(new_version.id)

    assert any(edge.relation_type is RelationType.USES for edge in backend.list_edges())
    assert any(node.id == "memory-v1" for node in history)


@pytest.mark.asyncio
async def test_static_memory_update_creates_new_version_and_updates_edge() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_backend = InMemoryGraphStoreBackend()
    graph_store = GraphStore(graph_backend, embedding)
    memory = StaticMemory("agent-1", vector_store, embedding, graph_store)

    original = await memory.add(
        ExtractedFact(
            text="We use JWT for authentication",
            memory_type=MemoryType.STATIC,
            confidence=0.9,
            is_permanent=True,
        ),
        container="startup:1:emp:e1",
    )

    updated = await memory.update(original.id, "We use JWT with 24h expiry")
    all_static = await memory.get_all("startup:1:emp:e1")

    assert updated.version == 2
    assert updated.previous_version_id == original.id
    assert len(all_static) == 1
    assert all_static[0].id == updated.id
    assert await vector_store.get(original.id) is None
    assert any(edge.relation_type is RelationType.UPDATES for edge in graph_backend.list_edges())


@pytest.mark.asyncio
async def test_memory_extractor_adds_memory_and_graph_relationships() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_backend = InMemoryGraphStoreBackend()
    graph_store = GraphStore(graph_backend, embedding)
    hippocampus = FakeHippocampus(
        static_memory=StaticMemory("agent-1", vector_store, embedding, graph_store),
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
    )

    fact = ExtractedFact(
        text="AuthService uses JWT for authentication",
        memory_type=MemoryType.STATIC,
        confidence=0.95,
        is_permanent=True,
        entities=("AuthService", "JWT"),
        relationships=(("AuthService", "uses", "JWT"),),
    )
    extractor = MemoryExtractor(
        FakeLLM(extracted_facts=[fact]),
        FakeLLM(classification="uses"),
        embedding,
        hippocampus,
    )

    result = await extractor.extract(
        messages=[{"role": "assistant", "content": "AuthService uses JWT"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
        mode=ExtractionMode.AGENT,
    )

    stored = await hippocampus.static_memory.get_all("startup:1:emp:e1")

    assert result.actions == ((MemoryAction.ADD, "", "no existing match"),)
    assert len(stored) == 1
    assert len(graph_backend.list_nodes()) >= 2
    assert any(edge.relation_type is RelationType.USES for edge in graph_backend.list_edges())
    assert stored[0].source_type == "agent"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("mode", "expected_source_type"),
    [
        (ExtractionMode.CONVERSATION, "conversation"),
        (ExtractionMode.MEETING, "meeting"),
    ],
)
async def test_memory_extractor_stamps_source_type_from_mode(
    mode: ExtractionMode,
    expected_source_type: str,
) -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(InMemoryGraphStoreBackend(), embedding)
    hippocampus = FakeHippocampus(
        static_memory=StaticMemory("agent-1", vector_store, embedding, graph_store),
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
    )
    extractor = MemoryExtractor(
        FakeLLM(
            extracted_facts=[
                ExtractedFact(
                    text="PM clarified the launch checklist owner",
                    memory_type=MemoryType.DYNAMIC,
                    confidence=0.8,
                )
            ]
        ),
        FakeLLM(classification="related_to"),
        embedding,
        hippocampus,
    )

    result = await extractor.extract(
        messages=[{"role": "assistant", "content": "Launch checklist owner updated"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
        mode=mode,
    )

    stored = await vector_store.list_by_type(
        agent_id="agent-1",
        container="startup:1:emp:e1",
        memory_type=MemoryType.DYNAMIC,
    )

    assert result.facts[0].source_type == expected_source_type
    assert stored[0].source_type == expected_source_type


@pytest.mark.asyncio
async def test_memory_extractor_versions_existing_static_memory_on_update() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_backend = InMemoryGraphStoreBackend()
    graph_store = GraphStore(graph_backend, embedding)
    static_memory = StaticMemory("agent-1", vector_store, embedding, graph_store)
    original = await static_memory.add(
        ExtractedFact(
            text="We use JWT for authentication",
            memory_type=MemoryType.STATIC,
            confidence=0.9,
            is_permanent=True,
        ),
        container="startup:1:emp:e1",
    )

    hippocampus = FakeHippocampus(
        static_memory=static_memory,
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
    )
    updated_fact = replace(
        ExtractedFact(
            text="We use JWT for authentication with 24h expiry",
            memory_type=MemoryType.STATIC,
            confidence=0.95,
            is_permanent=True,
        ),
        entities=("JWT",),
    )
    extractor = MemoryExtractor(
        FakeLLM(
            extracted_facts=[updated_fact],
            decision={
                "action": "UPDATE",
                "target_id": original.id,
                "reason": "refines existing static memory",
            },
        ),
        FakeLLM(classification="related_to"),
        embedding,
        hippocampus,
    )

    result = await extractor.extract(
        messages=[{"role": "assistant", "content": "JWT now has 24h expiry"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
        mode=ExtractionMode.AGENT,
    )
    stored = await static_memory.get_all("startup:1:emp:e1")

    assert result.actions[0][0] is MemoryAction.UPDATE
    assert len(stored) == 1
    assert stored[0].previous_version_id == original.id
    assert await vector_store.get(original.id) is None
    assert any(edge.relation_type is RelationType.UPDATES for edge in graph_backend.list_edges())


@pytest.mark.asyncio
async def test_memory_extractor_invalid_action_defaults_to_none() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(InMemoryGraphStoreBackend(), embedding)
    static_memory = StaticMemory("agent-1", vector_store, embedding, graph_store)
    await static_memory.add(
        ExtractedFact(
            text="We use JWT for authentication",
            memory_type=MemoryType.STATIC,
            confidence=0.9,
            is_permanent=True,
        ),
        container="startup:1:emp:e1",
    )
    hippocampus = FakeHippocampus(
        static_memory=static_memory,
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
    )

    extractor = MemoryExtractor(
        FakeLLM(
            extracted_facts=[
                ExtractedFact(
                    text="We use JWT for authentication",
                    memory_type=MemoryType.STATIC,
                    confidence=0.9,
                    is_permanent=True,
                ),
            ],
            decision={"action": "surprise_me", "target_id": "ignored", "reason": "bad llm output"},
        ),
        FakeLLM(classification="related_to"),
        embedding,
        hippocampus,
    )

    result = await extractor.extract(
        messages=[{"role": "assistant", "content": "JWT auth"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
    )

    assert result.actions == ((MemoryAction.NONE, "ignored", "bad llm output"),)


@pytest.mark.asyncio
async def test_memory_extractor_rejects_hallucinated_target_id() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(InMemoryGraphStoreBackend(), embedding)
    static_memory = StaticMemory("agent-1", vector_store, embedding, graph_store)
    existing = await static_memory.add(
        ExtractedFact(
            text="We use JWT for authentication",
            memory_type=MemoryType.STATIC,
            confidence=0.9,
            is_permanent=True,
        ),
        container="startup:1:emp:e1",
    )
    hippocampus = FakeHippocampus(
        static_memory=static_memory,
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
    )

    extractor = MemoryExtractor(
        FakeLLM(
            extracted_facts=[
                ExtractedFact(
                    text="We use JWT for authentication",
                    memory_type=MemoryType.STATIC,
                    confidence=0.9,
                    is_permanent=True,
                ),
            ],
            decision={
                "action": "DELETE",
                "target_id": "hallucinated-id",
                "reason": "bad llm output",
            },
        ),
        FakeLLM(classification="related_to"),
        embedding,
        hippocampus,
    )

    result = await extractor.extract(
        messages=[{"role": "assistant", "content": "JWT auth"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
    )

    assert result.actions == ((MemoryAction.NONE, "", "invalid_target_id"),)
    assert await vector_store.get(existing.id) is not None


@pytest.mark.asyncio
async def test_memory_extractor_falls_back_when_procedural_memory_is_unavailable() -> None:
    vector_store = InMemoryVectorStore()
    embedding = MockEmbeddingEngine(dimensions=32)
    graph_store = GraphStore(InMemoryGraphStoreBackend(), embedding)
    hippocampus = FakeHippocampus(
        static_memory=StaticMemory("agent-1", vector_store, embedding, graph_store),
        dynamic_memory=DynamicMemory("agent-1", vector_store, embedding),
        graph_store=graph_store,
        vector_store=vector_store,
        embedding_engine=embedding,
        procedural_memory=None,
    )
    fact = ExtractedFact(
        text="before deploy -> run tests first",
        memory_type=MemoryType.PROCEDURAL,
        confidence=0.92,
        is_procedural=True,
    )
    extractor = MemoryExtractor(
        FakeLLM(extracted_facts=[fact]),
        FakeLLM(classification="related_to"),
        embedding,
        hippocampus,
    )

    await extractor.extract(
        messages=[{"role": "assistant", "content": "Always run tests before deploy"}],
        agent_id="agent-1",
        container="startup:1:emp:e1",
    )

    dynamic = await vector_store.list_by_type(
        agent_id="agent-1",
        container="startup:1:emp:e1",
        memory_type=MemoryType.DYNAMIC,
    )
    assert [memory.content for memory in dynamic] == ["before deploy -> run tests first"]
