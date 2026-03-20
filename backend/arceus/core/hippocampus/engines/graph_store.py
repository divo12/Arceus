from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, GraphStoreBackend
from arceus.core.hippocampus.types import GraphEntity, GraphRelationship, RelationType
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class GraphStore:
    """Graph facade for entity relationships and memory version chains."""

    def __init__(
        self,
        backend: GraphStoreBackend,
        embedding_engine: EmbeddingEngine,
    ) -> None:
        self._backend = backend
        self._embedding = embedding_engine

    async def close(self) -> None:
        close = getattr(self._backend, "close", None)
        if close is not None:
            await close()

    async def find_similar_node(
        self,
        embedding: list[float],
        threshold: float = 0.7,
        container: str = "",
    ) -> GraphEntity | None:
        candidates = await self._backend.vector_search(embedding, container=container, top_k=5)
        for candidate in candidates:
            similarity = cosine_similarity(embedding, candidate.embedding or [])
            if similarity >= threshold:
                return candidate
        return None

    async def merge_node(self, existing: GraphEntity, new: GraphEntity) -> GraphEntity:
        await self._backend.update_node(
            existing.id,
            {
                "mention_count": existing.mention_count + 1,
                "metadata": {**existing.metadata, **new.metadata},
            },
        )
        refreshed = await self._backend.get_node(existing.id)
        return refreshed or existing

    async def create_node(self, entity: GraphEntity) -> str:
        return await self._backend.create_node(entity)

    async def create_edge(
        self,
        source_id: str,
        target_id: str,
        rel_type: RelationType,
        metadata: dict | None = None,
    ) -> str:
        relationship = GraphRelationship(
            source_id=source_id,
            target_id=target_id,
            relation_type=rel_type,
            metadata=metadata or {},
        )
        return await self._backend.create_edge(relationship)

    async def add_relationship(self, relationship: GraphRelationship) -> str:
        return await self._backend.create_edge(relationship)

    async def create_edge_by_name(
        self,
        source_name: str,
        target_name: str,
        rel_type: RelationType,
        container: str = "",
    ) -> str | None:
        source_embedding = await self._embedding.embed(source_name)
        target_embedding = await self._embedding.embed(target_name)
        source_node = await self.find_similar_node(source_embedding, container=container)
        target_node = await self.find_similar_node(target_embedding, container=container)
        if source_node is None or target_node is None:
            return None
        return await self.create_edge(source_node.id, target_node.id, rel_type)

    async def search(
        self,
        query: str,
        container: str,
        top_k: int = 10,
        max_hops: int = 2,
    ) -> list[GraphEntity]:
        query_embedding = await self._embedding.embed(query)
        seed_nodes = await self._backend.vector_search(
            query_embedding,
            container,
            top_k=top_k * 3,
        )

        expanded: dict[str, GraphEntity] = {}
        for node in seed_nodes:
            expanded[node.id] = node
            for neighbor in await self._backend.get_neighbors(node.id, max_hops=max_hops):
                expanded[neighbor.id] = neighbor

        ranked = sorted(
            expanded.values(),
            key=lambda node: (
                cosine_similarity(query_embedding, node.embedding or []),
                node.mention_count,
            ),
            reverse=True,
        )
        return ranked[:top_k]

    async def get_neighbors(
        self,
        node_id: str,
        max_hops: int = 2,
    ) -> list[GraphEntity]:
        """Public facade for graph neighbor traversal."""
        return await self._backend.get_neighbors(node_id, max_hops=max_hops)

    async def version_memory(
        self,
        old_memory_id: str,
        new_fact: str,
        container: str,
    ) -> GraphEntity:
        embedding = await self._embedding.embed(new_fact)
        new_node = GraphEntity(
            name=new_fact,
            entity_type="memory_version",
            embedding=embedding,
            container=container,
            is_latest=True,
        )
        await self._backend.create_node(new_node)
        await self.create_edge(new_node.id, old_memory_id, RelationType.UPDATES)
        await self._backend.update_node(old_memory_id, {"is_latest": False})
        return new_node

    async def get_version_history(self, memory_id: str) -> list[GraphEntity]:
        return await self._backend.cypher_query(
            """
            MATCH path = (n)-[:UPDATES*0..]->(root)
            WHERE n.id = $id
            UNWIND nodes(path) AS version
            RETURN DISTINCT version
            ORDER BY version.created_at
            """,
            {"id": memory_id},
        )
