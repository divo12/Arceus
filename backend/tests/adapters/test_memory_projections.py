from __future__ import annotations

import pytest

from arceus.core.hippocampus.types import (
    GraphEntity,
    MemoryType,
    RelationType,
)
from arceus.core.memory_projections import ArceusMemoryProjections
from arceus.core.memory_scope import ArceusMemoryScope


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
async def test_get_graph_view(hippocampus_factory) -> None:
    projections = ArceusMemoryProjections()
    scope = ArceusMemoryScope()
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        jwt = GraphEntity(
            name="JWT",
            entity_type="technology",
            embedding=await hippocampus._embedding.embed("JWT"),
            container=container,
        )
        auth_service = GraphEntity(
            name="AuthService",
            entity_type="service",
            embedding=await hippocampus._embedding.embed("AuthService"),
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
                "type": "related_to",
                "weight": 1.0,
            }
        ]
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
