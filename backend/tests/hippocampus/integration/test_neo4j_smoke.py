from __future__ import annotations

import pytest

from arceus.core.hippocampus.backends.neo4j_graph import Neo4jGraphStoreBackend
from arceus.core.hippocampus.types import GraphEntity, GraphRelationship, RelationType

pytestmark = [
    pytest.mark.integration,
    pytest.mark.neo4j,
]


@pytest.mark.asyncio
async def test_neo4j_graph_backend_crud_and_neighbors(
    neo4j_profile: dict[str, str],
    unique_id: str,
) -> None:
    backend = Neo4jGraphStoreBackend(
        uri=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_URI"],
        username=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_USERNAME"],
        password=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_PASSWORD"],
        database=neo4j_profile.get("HIPPOCAMPUS_TEST_NEO4J_DATABASE", ""),
    )

    source = GraphEntity(
        id=f"neo4j-source-{unique_id}",
        name="JWT rollout",
        entity_type="memory",
        container=f"startup:neo4j:{unique_id}",
        embedding=[1.0, 0.0, 0.0],
    )
    target = GraphEntity(
        id=f"neo4j-target-{unique_id}",
        name="Security review",
        entity_type="memory",
        container=f"startup:neo4j:{unique_id}",
        embedding=[0.9, 0.1, 0.0],
    )

    await backend.create_node(source)
    await backend.create_node(target)
    relationship = GraphRelationship(
        source_id=source.id,
        target_id=target.id,
        relation_type=RelationType.USES,
    )
    await backend.create_edge(relationship)

    loaded = await backend.get_node(source.id)
    neighbors = await backend.get_neighbors(source.id, max_hops=1)
    edges = await backend.get_edges(source.id)

    assert loaded is not None
    assert loaded.id == source.id
    assert {neighbor.id for neighbor in neighbors} >= {target.id}
    assert any(edge.relation_type is RelationType.USES for edge in edges)

    await backend.close()


@pytest.mark.asyncio
async def test_neo4j_graph_backend_vector_search_smoke(
    neo4j_profile: dict[str, str],
    unique_id: str,
) -> None:
    backend = Neo4jGraphStoreBackend(
        uri=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_URI"],
        username=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_USERNAME"],
        password=neo4j_profile["HIPPOCAMPUS_TEST_NEO4J_PASSWORD"],
        database=neo4j_profile.get("HIPPOCAMPUS_TEST_NEO4J_DATABASE", ""),
    )

    node = GraphEntity(
        id=f"neo4j-vector-{unique_id}",
        name="Migration retrospective",
        entity_type="memory",
        container=f"startup:neo4j:{unique_id}",
        embedding=[0.3, 0.7, 0.0],
    )
    await backend.create_node(node)

    results = await backend.vector_search(
        embedding=[0.3, 0.7, 0.0],
        container=f"startup:neo4j:{unique_id}",
        top_k=3,
    )

    assert any(result.id == node.id for result in results)
    await backend.close()
