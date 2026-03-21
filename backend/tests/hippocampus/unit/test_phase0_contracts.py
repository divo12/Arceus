from dataclasses import fields, is_dataclass
from typing import get_type_hints

from arceus.core.hippocampus import (
    Habit,
    MemoryAction,
    MemoryPromotionEvent,
    MemorySummaryProjection,
    MemoryType,
    Pattern,
    RelationType,
    RetrievalResult,
)
from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    GraphStoreBackend,
    LLMEngine,
    PatternStore,
)
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.types import (
    ConsolidationResult,
    DistilledMemory,
    ExtractedFact,
    ExtractionMode,
    ExtractionResult,
    GCResult,
    GraphEntity,
    GraphMemoryView,
    GraphRelationship,
    MemoryUnit,
    Trajectory,
    TrajectoryStep,
    TrajectoryVerdict,
)


def test_phase0_enums_match_v6_contract() -> None:
    assert [item.value for item in MemoryAction] == ["add", "update", "delete", "none"]
    assert [item.value for item in ExtractionMode] == [
        "agent",
        "sub_agent",
        "conversation",
        "meeting",
    ]
    assert [item.value for item in RelationType] == [
        "updates",
        "extends",
        "derives",
        "uses",
        "owns",
        "depends_on",
        "related_to",
        "part_of",
        "decided_in",
        "promoted_from",
    ]


def test_phase0_config_contains_spec_fields_with_expected_defaults() -> None:
    config = HippocampusConfig()

    assert config.vector_store_backend == "in_memory"
    assert config.graph_store_backend == "neo4j"
    assert config.cache_backend == "dict"
    assert config.relational_backend == "sqlite"
    assert config.postgres_url == ""
    assert config.postgres_schema == "hippocampus"
    assert config.redis_url == ""
    assert config.vector_index_type == "hnsw"
    assert config.vector_top_k_fetch_multiplier == 3
    assert config.gc_interval_hours == 6.0
    assert config.distillation_threshold == 0.6
    assert config.pattern_learning_rate == 0.1
    assert config.habit_usage_threshold == 10
    assert config.habit_success_threshold == 0.8
    assert config.promotion_access_threshold == 10
    assert config.promotion_confidence_threshold == 0.8
    assert config.promotion_age_days == 14
    assert config.extraction_frequency == "per_task_and_meeting"
    assert config.embedding_device == "cpu"
    assert config.embedding_strict is False
    assert config.embedding_warmup is False
    assert config.azure_openai_endpoint == ""
    assert config.azure_openai_api_version == "2024-12-01-preview"
    assert config.azure_openai_deployment_reasoning == "gpt-4.1"
    assert config.azure_openai_deployment_lightweight == "gpt-4.1-mini"
    assert config.reasoning_model == "gpt-4.1"
    assert config.lightweight_model == "gpt-4.1-mini"


def test_production_backend_config_can_be_set() -> None:
    config = HippocampusConfig(
        relational_backend="postgresql",
        vector_store_backend="pgvector",
        cache_backend="redis",
        postgres_url="postgresql+asyncpg://user:pass@localhost:5432/arceus",
        postgres_schema="hippocampus",
        redis_url="redis://localhost:6379/0",
    )

    assert config.relational_backend == "postgresql"
    assert config.vector_store_backend == "pgvector"
    assert config.cache_backend == "redis"
    assert config.postgres_url.startswith("postgresql+asyncpg://")
    assert config.postgres_schema == "hippocampus"
    assert config.redis_url == "redis://localhost:6379/0"


def test_phase0_dataclasses_exist_with_expected_fields() -> None:
    for cls in [
        MemoryUnit,
        ExtractedFact,
        ExtractionResult,
        TrajectoryStep,
        Trajectory,
        GraphEntity,
        GraphRelationship,
        RetrievalResult,
        TrajectoryVerdict,
        DistilledMemory,
        ConsolidationResult,
        GCResult,
        MemorySummaryProjection,
        GraphMemoryView,
        MemoryPromotionEvent,
        Habit,
        Pattern,
    ]:
        assert is_dataclass(cls)

    extracted_fact_fields = {field.name for field in fields(ExtractedFact)}
    assert "entities" in extracted_fact_fields
    assert "relationships" in extracted_fact_fields

    graph_view_fields = {field.name for field in fields(GraphMemoryView)}
    assert graph_view_fields == {"center_node", "nodes", "edges", "depth"}


def test_distilled_memory_can_convert_to_memory_unit() -> None:
    distilled = DistilledMemory(
        agent_id="agent-1",
        trajectory_id="traj-1",
        strategy="check logs then fix config",
        embedding=[0.1, 0.2],
        quality=0.9,
        learnings=["auth failures often come from stale env vars"],
    )

    memory = distilled.to_memory_unit()

    assert memory.agent_id == "agent-1"
    assert memory.memory_type is MemoryType.DYNAMIC
    assert memory.source_type == "distillation"
    assert memory.source_id == "traj-1"


def test_phase0_protocols_expose_expected_methods() -> None:
    pattern_methods = set(PatternStore.__dict__.keys())
    graph_methods = set(GraphStoreBackend.__dict__.keys())
    llm_methods = set(LLMEngine.__dict__.keys())
    embedding_methods = set(EmbeddingEngine.__dict__.keys())

    assert {"insert", "update", "find_similar", "list_all", "update_status"} <= pattern_methods
    assert {
        "create_node",
        "get_node",
        "update_node",
        "create_edge",
        "vector_search",
        "get_neighbors",
        "cypher_query",
    } <= graph_methods
    assert {"extract_structured", "decide", "analyze", "generate", "classify"} <= llm_methods
    assert {"embed", "embed_batch"} <= embedding_methods


def test_graph_and_llm_protocol_annotations_cover_phase0_contracts() -> None:
    graph_hints = get_type_hints(GraphStoreBackend.get_neighbors)
    llm_hints = get_type_hints(LLMEngine.classify)

    assert "relation_types" in graph_hints
    assert graph_hints["relation_types"] == list[str] | None
    assert llm_hints["options"] == list[str]
