from __future__ import annotations

from collections import deque
from dataclasses import fields, replace

from arceus.core.hippocampus.types import GraphEntity, GraphRelationship, RelationType
from arceus.core.hippocampus.utils.similarity import cosine_similarity


class InMemoryGraphStoreBackend:
    """In-process graph backend used for tests and local MVP development."""

    _VALID_NODE_FIELDS = {field.name for field in fields(GraphEntity)}

    def __init__(self) -> None:
        self._nodes: dict[str, GraphEntity] = {}
        self._edges: dict[str, GraphRelationship] = {}

    async def create_node(self, entity: GraphEntity) -> str:
        self._nodes[entity.id] = entity
        return entity.id

    async def get_node(self, node_id: str) -> GraphEntity | None:
        return self._nodes.get(node_id)

    async def update_node(self, node_id: str, updates: dict) -> None:
        existing = self._nodes.get(node_id)
        if existing is None:
            return
        invalid = set(updates) - self._VALID_NODE_FIELDS
        if invalid:
            raise ValueError(f"Invalid GraphEntity fields: {invalid}")
        self._nodes[node_id] = replace(existing, **updates)

    async def create_edge(self, rel: GraphRelationship) -> str:
        self._edges[rel.id] = rel
        return rel.id

    async def vector_search(
        self,
        embedding: list[float],
        container: str,
        top_k: int,
    ) -> list[GraphEntity]:
        scored: list[tuple[float, GraphEntity]] = []
        for node in self._nodes.values():
            if container and node.container != container:
                continue
            score = cosine_similarity(embedding, node.embedding or [])
            scored.append((score, node))
        scored.sort(key=lambda item: (item[0], item[1].mention_count), reverse=True)
        return [node for _, node in scored[:top_k]]

    async def get_neighbors(
        self,
        node_id: str,
        max_hops: int,
        relation_types: list[str] | None = None,
    ) -> list[GraphEntity]:
        if max_hops <= 0 or node_id not in self._nodes:
            return []

        allowed = {item.lower() for item in relation_types} if relation_types else None
        seen = {node_id}
        frontier: deque[tuple[str, int]] = deque([(node_id, 0)])
        neighbors: list[GraphEntity] = []

        while frontier:
            current_id, depth = frontier.popleft()
            if depth >= max_hops:
                continue

            for edge in self._edges.values():
                if allowed and edge.relation_type.value not in allowed:
                    continue

                next_id = ""
                if edge.source_id == current_id:
                    next_id = edge.target_id
                elif edge.target_id == current_id:
                    next_id = edge.source_id

                if not next_id or next_id in seen:
                    continue

                seen.add(next_id)
                frontier.append((next_id, depth + 1))
                node = self._nodes.get(next_id)
                if node is not None:
                    neighbors.append(node)

        return neighbors

    async def cypher_query(self, query: str, params: dict) -> list[GraphEntity]:
        del query
        start_id = params.get("id", "")
        if start_id not in self._nodes:
            return []

        history: list[GraphEntity] = []
        current_id = start_id
        seen: set[str] = set()

        while current_id and current_id not in seen:
            seen.add(current_id)
            node = self._nodes.get(current_id)
            if node is not None:
                history.append(node)

            next_edge = next(
                (
                    edge
                    for edge in self._edges.values()
                    if edge.source_id == current_id and edge.relation_type is RelationType.UPDATES
                ),
                None,
            )
            current_id = next_edge.target_id if next_edge else ""

        return list(reversed(history))

    def list_nodes(self) -> list[GraphEntity]:
        return list(self._nodes.values())

    def list_edges(self) -> list[GraphRelationship]:
        return list(self._edges.values())
