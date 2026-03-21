import sys
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from arceus.config.settings import settings
from arceus.core.hippocampus.backends.azure_openai_llm import AzureOpenAILLMEngine
from arceus.core.hippocampus.backends.dict_cache import DictCacheStore
from arceus.core.hippocampus.backends.factory import (
    create_embedding_engine,
    create_graph_store,
    create_llm_engine,
)
from arceus.core.hippocampus.backends.in_memory_graph import InMemoryGraphStoreBackend
from arceus.core.hippocampus.backends.in_memory_vector import InMemoryVectorStore
from arceus.core.hippocampus.backends.neo4j_graph import Neo4jGraphStoreBackend
from arceus.core.hippocampus.backends.noop_llm import NoopLLMEngine
from arceus.core.hippocampus.backends.sentence_transformers_embedding import (
    SentenceTransformerEmbeddingEngine,
)
from arceus.core.hippocampus.backends.simple_embedding import MockEmbeddingEngine
from arceus.core.hippocampus.backends.sqlite_relational import SQLiteRelationalStore
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.types import (
    ExtractedFact,
    GraphEntity,
    GraphRelationship,
    Habit,
    HabitFormation,
    MemoryVisibility,
    MemoryType,
    MemoryUnit,
    RelationType,
)


class FakeNeo4jResult:
    def __init__(self, records: list[dict]) -> None:
        self._records = records
        self._index = 0

    def __aiter__(self) -> "FakeNeo4jResult":
        self._index = 0
        return self

    async def __anext__(self) -> dict:
        if self._index >= len(self._records):
            raise StopAsyncIteration
        record = self._records[self._index]
        self._index += 1
        return record


class FakeNeo4jSession:
    def __init__(self, state: dict[str, object], database: str | None) -> None:
        self._state = state
        self._database = database

    async def __aenter__(self) -> "FakeNeo4jSession":
        self._state["databases"].append(self._database)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        del exc_type, exc, tb

    async def run(self, query: str, **params):  # noqa: ANN003
        state = self._state
        nodes: dict[str, dict] = state["nodes"]  # type: ignore[assignment]
        edges: list[dict] = state["edges"]  # type: ignore[assignment]
        call_params = self._state["last_params"] = params
        state["queries"].append(query)

        if "CREATE CONSTRAINT" in query:
            return FakeNeo4jResult([])

        if "CREATE (n:GraphEntity)" in query and "SET n = $payload" in query:
            payload = dict(call_params["payload"])
            nodes[payload["id"]] = payload
            return FakeNeo4jResult([{"id": payload["id"]}])

        if "MATCH (n:GraphEntity {id: $node_id})" in query and "LIMIT 1" in query:
            node = nodes.get(call_params["node_id"])
            return FakeNeo4jResult([{"n": node}] if node is not None else [])

        if "MATCH (n:GraphEntity {id: $node_id})" in query and "SET " in query:
            node = nodes.get(call_params["node_id"])
            if node is None:
                return FakeNeo4jResult([])
            for key, value in call_params.items():
                if key != "node_id":
                    node[key] = value
            return FakeNeo4jResult([{"n": node}])

        if "CREATE (source)-[r:" in query and "SET r = $payload" in query:
            if call_params["source_id"] not in nodes or call_params["target_id"] not in nodes:
                return FakeNeo4jResult([])
            rel_type = query.split("CREATE (source)-[r:", maxsplit=1)[1].split(
                "]",
                maxsplit=1,
            )[0]
            payload = dict(call_params["payload"])
            payload["type"] = rel_type.lower()
            edges.append(payload)
            return FakeNeo4jResult([{"id": payload["id"]}])

        if "MATCH (n:GraphEntity)" in query and "RETURN n" in query:
            container = call_params["container"]
            records = [
                {"n": node}
                for node in nodes.values()
                if container == "" or node["container"] == container
            ]
            return FakeNeo4jResult(records)

        if "MATCH path =" in query and "RETURN DISTINCT neighbor" in query:
            node_id = call_params["node_id"]
            allowed = call_params.get("relation_types")
            max_hops = int(query.split("[*1..", maxsplit=1)[1].split("]", maxsplit=1)[0])
            neighbors: list[dict] = []
            seen = {node_id}
            frontier = [(node_id, 0)]
            while frontier:
                current_id, depth = frontier.pop(0)
                if depth >= max_hops:
                    continue
                for edge in edges:
                    if allowed and edge["type"] not in allowed:
                        continue
                    next_id = ""
                    if edge["source_id"] == current_id:
                        next_id = edge["target_id"]
                    elif edge["target_id"] == current_id:
                        next_id = edge["source_id"]
                    if not next_id or next_id in seen:
                        continue
                    seen.add(next_id)
                    frontier.append((next_id, depth + 1))
                    if next_id in nodes:
                        neighbors.append(nodes[next_id])
            return FakeNeo4jResult([{"neighbor": node} for node in neighbors])

        if "MATCH (source:GraphEntity)-[r]-(target:GraphEntity)" in query and "RETURN r" in query:
            node_id = call_params["node_id"]
            records = [
                {"r": edge}
                for edge in edges
                if edge["source_id"] == node_id or edge["target_id"] == node_id
            ]
            return FakeNeo4jResult(records)

        if "[:UPDATES*]" in query:
            current_id = call_params["id"]
            history: list[dict] = []
            seen: set[str] = set()
            while current_id and current_id not in seen:
                seen.add(current_id)
                node = nodes.get(current_id)
                if node is not None:
                    history.append(node)
                next_edge = next(
                    (
                        edge
                        for edge in edges
                        if edge["source_id"] == current_id and edge["type"] == "updates"
                    ),
                    None,
                )
                current_id = next_edge["target_id"] if next_edge else ""
            return FakeNeo4jResult([{"root": node} for node in reversed(history)])

        raise AssertionError(f"Unexpected Neo4j query: {query}")


class FakeNeo4jDriver:
    def __init__(self) -> None:
        self.state: dict[str, object] = {
            "nodes": {},
            "edges": [],
            "queries": [],
            "databases": [],
            "last_params": {},
        }
        self.closed = False

    def session(self, *, database: str | None = None) -> FakeNeo4jSession:
        return FakeNeo4jSession(self.state, database)

    async def close(self) -> None:
        self.closed = True


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

    assert isinstance(simple, MockEmbeddingEngine)
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
    fallback = MockEmbeddingEngine(dimensions=384)

    class FakeSentenceTransformersModule:
        SentenceTransformer = BrokenSentenceTransformer

    monkeypatch.setitem(sys.modules, "sentence_transformers", FakeSentenceTransformersModule())

    with caplog.at_level("WARNING"):
        vector = await engine.embed("hello world")

    assert vector == await fallback.embed("hello world")
    assert "Falling back to simple embeddings" in caplog.text


def test_graph_store_factory_builds_neo4j_backend() -> None:
    config = HippocampusConfig(
        neo4j_uri="neo4j+s://example.databases.neo4j.io",
        neo4j_username="neo4j",
        neo4j_password="secret",
        neo4j_database="neo4j",
    )

    backend = create_graph_store("neo4j", config)

    assert isinstance(backend, Neo4jGraphStoreBackend)


def test_graph_store_factory_uses_repo_dotenv_database_when_config_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "neo4j_uri", "neo4j+s://repo.databases.neo4j.io")
    monkeypatch.setattr(settings, "neo4j_username", "repo-user")
    monkeypatch.setattr(settings, "neo4j_password", SecretStr("repo-password"))
    monkeypatch.setattr(settings, "neo4j_database", "repo-db")

    config = HippocampusConfig(
        graph_store_backend="neo4j",
        neo4j_uri="",
        neo4j_username="",
        neo4j_password="",
        neo4j_database="",
    )
    backend = create_graph_store("neo4j", config)

    assert isinstance(backend, Neo4jGraphStoreBackend)
    assert backend._database == "repo-db"


def test_graph_store_factory_requires_credentials_for_neo4j(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "neo4j_uri", "")
    monkeypatch.setattr(settings, "neo4j_username", "")
    monkeypatch.setattr(settings, "neo4j_password", "")

    with pytest.raises(ValueError, match="Neo4j backend requires credentials"):
        create_graph_store("neo4j", HippocampusConfig())


def test_neo4j_graph_backend_prefers_repo_dotenv_over_shell_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NEO4J_URI", "neo4j+s://shell.databases.neo4j.io")
    monkeypatch.setenv("NEO4J_USERNAME", "shell-user")
    monkeypatch.setenv("NEO4J_PASSWORD", "shell-password")
    monkeypatch.setenv("NEO4J_DATABASE", "shell-db")
    monkeypatch.setattr(settings, "neo4j_uri", "neo4j+s://repo.databases.neo4j.io")
    monkeypatch.setattr(settings, "neo4j_username", "repo-user")
    monkeypatch.setattr(settings, "neo4j_password", SecretStr("repo-password"))
    monkeypatch.setattr(settings, "neo4j_database", "repo-db")

    backend = Neo4jGraphStoreBackend()

    assert backend._uri == "neo4j+s://repo.databases.neo4j.io"
    assert backend._username == "repo-user"
    assert backend._password == "repo-password"
    assert backend._database == "repo-db"


@pytest.mark.asyncio
async def test_neo4j_graph_backend_crud_search_neighbors_and_close() -> None:
    driver = FakeNeo4jDriver()
    backend = Neo4jGraphStoreBackend(
        uri="neo4j+s://example.databases.neo4j.io",
        username="neo4j",
        password="secret",
        database="hippocampus",
        driver=driver,
    )

    jwt = GraphEntity(
        id="jwt-node",
        name="JWT",
        entity_type="technology",
        embedding=[1.0, 0.0],
        container="scope-1",
    )
    auth = GraphEntity(
        id="auth-node",
        name="AuthService",
        entity_type="service",
        embedding=[0.9, 0.1],
        container="scope-1",
    )
    old_version = GraphEntity(
        id="memory-v1",
        name="Old auth memory",
        entity_type="memory_version",
        embedding=[0.2, 0.8],
        container="scope-1",
    )
    new_version = GraphEntity(
        id="memory-v2",
        name="New auth memory",
        entity_type="memory_version",
        embedding=[0.3, 0.7],
        container="scope-1",
    )

    await backend.create_node(jwt)
    await backend.create_node(auth)
    await backend.create_node(old_version)
    await backend.create_node(new_version)
    await backend.update_node("jwt-node", {"mention_count": 4})

    uses_edge = GraphRelationship(
        id="edge-uses",
        source_id="auth-node",
        target_id="jwt-node",
        relation_type=RelationType.USES,
    )
    updates_edge = GraphRelationship(
        id="edge-updates",
        source_id="memory-v2",
        target_id="memory-v1",
        relation_type=RelationType.UPDATES,
    )
    await backend.create_edge(uses_edge)
    await backend.create_edge(updates_edge)

    loaded = await backend.get_node("jwt-node")
    search_results = await backend.vector_search([1.0, 0.0], "scope-1", top_k=2)
    neighbors = await backend.get_neighbors("auth-node", max_hops=1, relation_types=["uses"])
    history = await backend.cypher_query(
        "MATCH (n)-[:UPDATES*]->(root) WHERE n.id = $id RETURN root ORDER BY root.created_at",
        {"id": "memory-v2"},
    )
    await backend.close()

    assert loaded is not None
    assert loaded.mention_count == 4
    assert [node.id for node in search_results] == ["jwt-node", "auth-node"]
    assert [node.id for node in neighbors] == ["jwt-node"]
    assert [node.id for node in history] == ["memory-v1", "memory-v2"]
    assert driver.state["databases"]
    assert all(item == "hippocampus" for item in driver.state["databases"])
    assert driver.closed is True


def test_llm_factory_uses_azure_backend_when_credentials_are_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "azure_openai_endpoint", "https://example.openai.azure.com/")
    monkeypatch.setattr(settings, "azure_openai_api_key", SecretStr("test-key"))

    engine = create_llm_engine("gpt-4.1", HippocampusConfig())

    assert isinstance(engine, AzureOpenAILLMEngine)


def test_llm_factory_uses_repo_dotenv_api_version_when_config_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "azure_openai_endpoint", "https://repo.openai.azure.com/")
    monkeypatch.setattr(settings, "azure_openai_api_key", SecretStr("repo-key"))
    monkeypatch.setattr(settings, "azure_openai_api_version", "2025-03-01-preview")

    config = HippocampusConfig(azure_openai_endpoint="", azure_openai_api_version="")
    engine = create_llm_engine("gpt-4.1", config)

    assert isinstance(engine, AzureOpenAILLMEngine)
    assert engine._api_version == "2025-03-01-preview"


def test_llm_factory_requires_credentials_for_real_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "azure_openai_endpoint", "")
    monkeypatch.setattr(settings, "azure_openai_api_key", SecretStr(""))

    with pytest.raises(ValueError, match="requires Azure OpenAI credentials"):
        create_llm_engine("gpt-4.1", HippocampusConfig())


def test_llm_factory_supports_explicit_noop_model() -> None:
    engine = create_llm_engine("noop", HippocampusConfig())

    assert isinstance(engine, NoopLLMEngine)


def test_azure_llm_reads_unprefixed_dotenv_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "azure_openai_endpoint", "https://dotenv.openai.azure.com/")
    monkeypatch.setattr(settings, "azure_openai_api_key", SecretStr("dotenv-key"))
    monkeypatch.setattr(settings, "azure_openai_api_version", "2025-03-01-preview")

    engine = AzureOpenAILLMEngine(model_name="gpt-4.1")

    assert engine._azure_endpoint == "https://dotenv.openai.azure.com/"
    assert engine._api_key.get_secret_value() == "dotenv-key"
    assert engine._api_version == "2025-03-01-preview"


def test_azure_llm_prefers_repo_dotenv_over_shell_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://shell.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "shell-key")
    monkeypatch.setenv("AZURE_OPENAI_API_VERSION", "2099-01-01-preview")
    monkeypatch.setattr(settings, "azure_openai_endpoint", "https://repo.openai.azure.com/")
    monkeypatch.setattr(settings, "azure_openai_api_key", SecretStr("repo-key"))
    monkeypatch.setattr(settings, "azure_openai_api_version", "2025-03-01-preview")

    engine = AzureOpenAILLMEngine(model_name="gpt-4.1")

    assert engine._azure_endpoint == "https://repo.openai.azure.com/"
    assert engine._api_key.get_secret_value() == "repo-key"
    assert engine._api_version == "2025-03-01-preview"


@pytest.mark.asyncio
async def test_azure_openai_llm_extracts_and_decides_with_json_payloads() -> None:
    class FakeResponse:
        def __init__(self, content: str) -> None:
            self.choices = [SimpleNamespace(message=SimpleNamespace(content=content))]

    class FakeCompletions:
        def __init__(self) -> None:
            self.requests: list[dict] = []

        async def create(self, **kwargs):  # noqa: ANN003
            self.requests.append(kwargs)
            user_payload = kwargs["messages"][-1]["content"]
            if "existing_memories" in user_payload:
                return FakeResponse('{"action":"UPDATE","target_id":"mem-1","reason":"refine"}')
            return FakeResponse(
                '[{"text":"Auth uses JWT","type":"static","confidence":0.9,'
                '"entities":["AuthService","JWT"],'
                '"relationships":[["AuthService","uses","JWT"]]}]'
            )

    fake_client = SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions()))
    engine = AzureOpenAILLMEngine(
        model_name="gpt-4.1",
        azure_endpoint="https://example.openai.azure.com/",
        api_key="test-key",
        api_version="2025-03-01-preview",
        client=fake_client,
    )

    extracted = await engine.extract_structured(
        prompt="extract facts",
        messages=[{"role": "assistant", "content": "Auth uses JWT"}],
        output_schema=list[ExtractedFact],
    )
    decision = await engine.decide(
        prompt="decide memory action",
        fact="Auth uses JWT",
        existing_memories=[{"id": "mem-1", "content": "Auth uses JWT", "type": "static"}],
    )

    assert extracted[0].memory_type is MemoryType.STATIC
    assert extracted[0].entities == ("AuthService", "JWT")
    assert extracted[0].relationships == (("AuthService", "uses", "JWT"),)
    assert decision == {"action": "UPDATE", "target_id": "mem-1", "reason": "refine"}
    json_request = fake_client.chat.completions.requests[0]
    assert json_request["response_format"] == {"type": "json_object"}
    assert "json" in json_request["messages"][0]["content"].lower()


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


@pytest.mark.asyncio
async def test_neo4j_graph_backend_create_edge_requires_existing_nodes() -> None:
    backend = Neo4jGraphStoreBackend(
        uri="neo4j+s://example.databases.neo4j.io",
        username="neo4j",
        password="secret",
        database="hippocampus",
        driver=FakeNeo4jDriver(),
    )

    with pytest.raises(KeyError, match="Cannot create edge"):
        await backend.create_edge(
            GraphRelationship(
                source_id="missing-source",
                target_id="missing-target",
                relation_type=RelationType.RELATED_TO,
            )
        )
