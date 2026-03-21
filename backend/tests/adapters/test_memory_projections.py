from __future__ import annotations

from datetime import timedelta

import pytest

from arceus.core.hippocampus.types import (
    GraphEntity,
    MemoryType,
    MemoryUnit,
    RelationType,
)
from arceus.core.hippocampus.utils.time import utc_now
from arceus.core.memory_projections import ArceusMemoryProjections
from arceus.core.memory_scope import ArceusMemoryScope
from tests.hippocampus.support.fakes.mock_embedding import MockEmbeddingEngine


@pytest.mark.asyncio
async def test_get_summary(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        await hippocampus.remember(
            "We use JWT for authentication",
            container=container,
            memory_type=MemoryType.STATIC,
        )
        await hippocampus.remember(
            "Current auth rollout needs refresh-token metrics",
            container=container,
            memory_type=MemoryType.DYNAMIC,
        )

        summary = await projections.get_summary(hippocampus)

        assert summary.agent_id == "emp-1"
        assert summary.static_fact_count == 1
        assert summary.dynamic_fact_count == 1
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_graph_view_preserves_edge_types(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")
    embedding = MockEmbeddingEngine(dimensions=32)

    try:
        jwt = GraphEntity(
            name="JWT",
            entity_type="technology",
            embedding=await embedding.embed("JWT"),
            container=container,
        )
        auth_service = GraphEntity(
            name="AuthService",
            entity_type="service",
            embedding=await embedding.embed("AuthService"),
            container=container,
        )
        await hippocampus.graph_store.create_node(jwt)
        await hippocampus.graph_store.create_node(auth_service)
        await hippocampus.graph_store.create_edge(
            jwt.id,
            auth_service.id,
            RelationType.USES,
        )

        view = await projections.get_graph_view(
            hippocampus=hippocampus,
            query="JWT",
            container=container,
            depth=1,
        )

        assert view.center_node is not None
        assert view.center_node.name == "JWT"
        assert {node.name for node in view.nodes} == {"JWT", "AuthService"}
        assert view.edges == [
            {
                "source": view.center_node.id,
                "target": next(node.id for node in view.nodes if node.name == "AuthService"),
                "type": "uses",
                "weight": 1.0,
            }
        ]
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_promotion_stream_returns_stored_events(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")
    embedding = MockEmbeddingEngine(dimensions=32)

    try:
        promotable = MemoryUnit(
            id="promotable",
            agent_id="emp-1",
            content="JWT expiry policy is a durable rule",
            embedding=await embedding.embed("JWT expiry policy is a durable rule"),
            memory_type=MemoryType.DYNAMIC,
            confidence=0.95,
            container=container,
            metadata={"usage_count": 12},
            created_at=utc_now() - timedelta(days=20),
            updated_at=utc_now() - timedelta(days=20),
        )
        await hippocampus._vector_store.upsert(promotable)

        await hippocampus.run_promotions()
        stream = await projections.get_promotion_stream(hippocampus)

        assert len(stream) == 1
        assert stream[0].memory_id != "promotable"
        assert stream[0].from_type == "dynamic"
        assert stream[0].to_type == "static"
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_graph_view_empty(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")

    try:
        view = await projections.get_graph_view(
            hippocampus=hippocampus,
            query="JWT",
            container=scope.employee_container("startup-1", "emp-1"),
            depth=1,
        )

        assert view.center_node is None
        assert view.nodes == []
        assert view.edges == []
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_memory_explorer(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")
    now = utc_now()

    try:
        older = MemoryUnit(
            id="old-static",
            agent_id="emp-1",
            content="Older static memory",
            embedding=[1.0, 0.0],
            memory_type=MemoryType.STATIC,
            confidence=0.8,
            container=container,
            source_type="remember",
            created_at=now - timedelta(days=2),
            updated_at=now - timedelta(days=2),
        )
        newer = MemoryUnit(
            id="new-dynamic",
            agent_id="emp-1",
            content="Newest dynamic memory",
            embedding=[0.9, 0.1],
            memory_type=MemoryType.DYNAMIC,
            confidence=0.9,
            container=container,
            source_type="conversation",
            created_at=now - timedelta(hours=1),
            updated_at=now - timedelta(hours=1),
        )
        await hippocampus._vector_store.upsert(older)
        await hippocampus._vector_store.upsert(newer)

        explorer = await projections.get_memory_explorer(
            hippocampus=hippocampus,
            container=container,
        )

        assert [item["id"] for item in explorer] == ["new-dynamic", "old-static"]
        assert explorer[0]["memory_type"] == "dynamic"
        assert explorer[0]["is_deleted"] is False
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_memory_explorer_filtered_by_type(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        await hippocampus.remember(
            "Static auth policy",
            container=container,
            memory_type=MemoryType.STATIC,
        )
        await hippocampus.remember(
            "Dynamic auth follow-up",
            container=container,
            memory_type=MemoryType.DYNAMIC,
        )

        explorer = await projections.get_memory_explorer(
            hippocampus=hippocampus,
            container=container,
            memory_type="static",
        )

        assert len(explorer) == 1
        assert explorer[0]["memory_type"] == "static"
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_get_version_history(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        original = await hippocampus.remember(
            "We use JWT for authentication",
            container=container,
            memory_type=MemoryType.STATIC,
        )
        updated = await hippocampus.static_memory.update(
            original.id,
            "We use JWT for authentication with 24h expiry",
        )

        history = await projections.get_version_history(hippocampus, updated.id)

        assert [item["id"] for item in history] == [original.id, updated.id]
        assert history[0]["name"] == "We use JWT for authentication"
    finally:
        await hippocampus.close()
