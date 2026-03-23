from __future__ import annotations

import sys
from datetime import UTC
from pathlib import Path

import pytest


RUNTIME_SRC = Path(__file__).resolve().parents[1] / "python" / "src"
if str(RUNTIME_SRC) not in sys.path:
    sys.path.insert(0, str(RUNTIME_SRC))

from arceus.config.settings import Settings
from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.types import DistilledMemory, MemoryType
from arceus.core.hippocampus.utils.similarity import (
    cosine_similarity,
    max_marginal_relevance,
)
from arceus.core.hippocampus.utils.time import parse_utc_iso, utc_now


def test_settings_support_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA", "paperclip_memory")
    monkeypatch.setenv("ARCEUS_NEO4J_PASSWORD", "secret-pass")

    settings = Settings()

    assert settings.hippocampus_postgres_schema == "paperclip_memory"
    assert settings.neo4j_password.get_secret_value() == "secret-pass"


def test_hippocampus_config_defaults_match_embedded_prod_shape() -> None:
    config = HippocampusConfig()

    assert config.vector_store_backend == "pgvector"
    assert config.graph_store_backend == "neo4j"
    assert config.cache_backend == "redis"
    assert config.relational_backend == "postgresql"
    assert config.embedding_dimensions == 384


def test_cosine_similarity_handles_common_cases() -> None:
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine_similarity([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine_similarity([], [1.0, 0.0]) == 0.0

    with pytest.raises(ValueError, match="Embedding dimensions must match"):
        cosine_similarity([1.0], [1.0, 0.0])


def test_max_marginal_relevance_prefers_diversity_after_best_match() -> None:
    indices = max_marginal_relevance(
        query_embedding=[1.0, 0.0],
        candidate_embeddings=[
            [1.0, 0.0],
            [0.0, 1.0],
            [0.8, 0.2],
        ],
        top_k=2,
        lambda_mult=0.2,
    )

    assert indices == [0, 1]


def test_time_helpers_return_utc_aware_datetimes() -> None:
    now = utc_now()
    parsed_naive = parse_utc_iso("2026-03-23T10:30:00")
    parsed_offset = parse_utc_iso("2026-03-23T16:00:00+05:30")

    assert now.tzinfo == UTC
    assert parsed_naive.tzinfo == UTC
    assert parsed_offset.tzinfo == UTC
    assert parsed_offset.hour == 10
    assert parsed_offset.minute == 30


def test_distilled_memory_converts_to_dynamic_memory_unit() -> None:
    distilled = DistilledMemory(
        agent_id="agent-1",
        trajectory_id="traj-1",
        strategy="Always verify migrations before deploy",
        container="startup:paperclip",
        embedding=[0.1, 0.2, 0.3],
        quality=0.91,
    )

    unit = distilled.to_memory_unit()

    assert unit.agent_id == "agent-1"
    assert unit.content == "Always verify migrations before deploy"
    assert unit.memory_type is MemoryType.DYNAMIC
    assert unit.confidence == pytest.approx(0.91)
    assert unit.container == "startup:paperclip"
    assert unit.source_type == "distillation"
    assert unit.source_id == "traj-1"
