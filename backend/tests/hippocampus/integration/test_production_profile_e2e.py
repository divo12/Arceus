from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
import os

import pytest

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.engines.promotion_engine import PromotionEngine
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType
from arceus.core.hippocampus.utils.time import utc_now

pytestmark = [
    pytest.mark.integration,
    pytest.mark.production_stack,
]


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


@pytest.mark.asyncio
async def test_production_profile_hippocampus_smoke(
    postgres_url: str,
    redis_url: str,
    neo4j_profile: dict[str, str],
    unique_id: str,
    sentence_transformer_enabled: bool,
) -> None:
    del sentence_transformer_enabled
    if _env("HIPPOCAMPUS_TEST_RUN_E2E") not in {"1", "true", "TRUE", "yes", "on"}:
        pytest.skip("set HIPPOCAMPUS_TEST_RUN_E2E=1 to enable full production-profile smoke")

    container = f"startup:e2e:{unique_id}"
    hippocampus = await Hippocampus.create(
        agent_id=f"agent-e2e-{unique_id}",
        config=HippocampusConfig(
            relational_backend="postgresql",
            postgres_url=postgres_url,
            postgres_schema=f"hippo_e2e_{unique_id}",
            vector_store_backend="pgvector",
            cache_backend="redis",
            redis_url=redis_url,
            graph_store_backend="neo4j",
            neo4j_uri=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_URI"],
            neo4j_username=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_USERNAME"],
            neo4j_password=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_PASSWORD"],
            neo4j_database=neo4j_profile.get("HIPPOCAMPUS_TEST_NEO4J_DATABASE", "neo4j"),
            embedding_model="all-MiniLM-L6-v2",
            embedding_dimensions=384,
            embedding_strict=True,
            embedding_warmup=True,
            extraction_model="noop",
            lightweight_model="noop",
        ),
    )

    await hippocampus.remember(
        "roll out auth changes in phases with a security checkpoint",
        container,
        MemoryType.STATIC,
    )
    dynamic_memory = await hippocampus.remember(
        "refresh-token migration is currently active",
        container,
        MemoryType.DYNAMIC,
    )
    recalled = await hippocampus.recall(
        "auth rollout checkpoint",
        container,
        top_k=5,
        include_graph=True,
    )
    promotion_time = utc_now() - timedelta(days=PromotionEngine.STATIC_AGE_DAYS_THRESHOLD + 1)
    promotable_dynamic = replace(
        dynamic_memory,
        confidence=0.95,
        metadata={"usage_count": PromotionEngine.STATIC_ACCESS_THRESHOLD},
        created_at=promotion_time,
        updated_at=promotion_time,
    )
    await hippocampus._vector_store.upsert(promotable_dynamic)
    promotions = await hippocampus.run_promotions()
    gc_result = await hippocampus.run_gc()
    summary = await hippocampus.get_summary()

    assert len(recalled) >= 2
    assert len(promotions) == 1
    assert summary.static_fact_count == 2
    assert summary.dynamic_fact_count == 0
    assert gc_result.expired_removed >= 0

    await hippocampus.close()
