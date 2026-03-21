from __future__ import annotations

import os
from uuid import uuid4

import pytest


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "integration: opt-in production/infrastructure tests")
    config.addinivalue_line("markers", "postgres: PostgreSQL relational smoke coverage")
    config.addinivalue_line("markers", "pgvector: pgvector-backed vector store smoke coverage")
    config.addinivalue_line("markers", "redis: Redis working-memory smoke coverage")
    config.addinivalue_line("markers", "neo4j: Neo4j graph-profile smoke coverage")
    config.addinivalue_line(
        "markers",
        "production_stack: end-to-end production-profile Hippocampus smoke coverage",
    )


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def _flag(name: str) -> bool:
    return _env(name).lower() in {"1", "true", "yes", "on"}


def _require_envs(*names: str) -> dict[str, str]:
    if not _flag("HIPPOCAMPUS_RUN_INTEGRATION"):
        pytest.skip(
            "integration tests are opt-in; set HIPPOCAMPUS_RUN_INTEGRATION=1 to enable"
        )

    values: dict[str, str] = {}
    missing: list[str] = []
    for name in names:
        value = _env(name)
        if not value:
            missing.append(name)
        else:
            values[name] = value

    if missing:
        joined = ", ".join(missing)
        pytest.skip(f"missing integration env vars: {joined}")

    return values


@pytest.fixture
def postgres_url() -> str:
    return _require_envs("HIPPOCAMPUS_TEST_POSTGRES_URL")["HIPPOCAMPUS_TEST_POSTGRES_URL"]


@pytest.fixture
def redis_url() -> str:
    return _require_envs("HIPPOCAMPUS_TEST_REDIS_URL")["HIPPOCAMPUS_TEST_REDIS_URL"]


@pytest.fixture
def neo4j_profile() -> dict[str, str]:
    return _require_envs(
        "HIPPOCAMPUS_TEST_NEO4J_URI",
        "HIPPOCAMPUS_TEST_NEO4J_USERNAME",
        "HIPPOCAMPUS_TEST_NEO4J_PASSWORD",
    )


@pytest.fixture
def unique_id() -> str:
    return uuid4().hex[:8]


@pytest.fixture
def schema_name(unique_id: str) -> str:
    return f"hippo_it_{unique_id}"


@pytest.fixture
def sentence_transformer_enabled() -> bool:
    if not _flag("HIPPOCAMPUS_TEST_ENABLE_SENTENCE_TRANSFORMERS"):
        pytest.skip(
            "set HIPPOCAMPUS_TEST_ENABLE_SENTENCE_TRANSFORMERS=1 "
            "to run the sentence-transformers production-profile smoke test"
        )
    return True
