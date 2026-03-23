from __future__ import annotations

import asyncio
import json
from dataclasses import asdict, fields
from typing import Any

from arceus.config.settings import settings
from arceus.core.hippocampus.types import GraphEntity, GraphRelationship, RelationType
from arceus.core.hippocampus.utils.similarity import cosine_similarity

_VALID_NODE_FIELDS = {field.name for field in fields(GraphEntity)}


class Neo4jGraphStoreBackend:
    """Neo4j Aura-backed graph backend for Hippocampus graph memory."""

    def __init__(
        self,
        *,
        uri: str = "",
        username: str = "",
        password: str = "",
        database: str = "",
        driver: Any | None = None,
    ) -> None:
        self._uri = uri or settings.neo4j_uri
        self._username = username or settings.neo4j_username
        self._password = password or settings.neo4j_password.get_secret_value()
        self._database = database or settings.neo4j_database
        self._driver = driver
        self._schema_ready = False
        self._schema_lock = asyncio.Lock()

    async def close(self) -> None:
        if self._driver is not None:
            await self._driver.close()
            self._driver = None
            self._schema_ready = False

    async def create_node(self, entity: GraphEntity) -> str:
        payload = _entity_payload(entity)
        await self._run(
            """
            CREATE (n:GraphEntity)
            SET n = $payload
            RETURN n.id AS id
            """,
            payload=payload,
            ensure_schema=True,
        )
        return entity.id

    async def get_node(self, node_id: str) -> GraphEntity | None:
        records = await self._run(
            """
            MATCH (n:GraphEntity {id: $node_id})
            RETURN n
            LIMIT 1
            """,
            node_id=node_id,
        )
        if not records:
            return None
        return _record_to_entity(records[0])

    async def update_node(self, node_id: str, updates: dict) -> None:
        invalid = set(updates) - _VALID_NODE_FIELDS
        if invalid:
            raise ValueError(f"Invalid GraphEntity fields: {invalid}")
        if not updates:
            return

        serialized_updates = {
            field_name: _serialize_metadata(value) if field_name == "metadata" else value
            for field_name, value in updates.items()
        }
        assignments = ", ".join(f"n.{field_name} = ${field_name}" for field_name in updates)
        await self._run(
            f"""
            MATCH (n:GraphEntity {{id: $node_id}})
            SET {assignments}
            RETURN n
            """,
            node_id=node_id,
            **serialized_updates,
        )

    async def create_edge(self, rel: GraphRelationship) -> str:
        rel_type = rel.relation_type.name
        payload = _relationship_payload(rel)
        records = await self._run(
            f"""
            MATCH (source:GraphEntity {{id: $source_id}})
            MATCH (target:GraphEntity {{id: $target_id}})
            CREATE (source)-[r:{rel_type}]->(target)
            SET r = $payload
            RETURN r.id AS id
            """,
            source_id=rel.source_id,
            target_id=rel.target_id,
            payload=payload,
            ensure_schema=True,
        )
        if not records:
            raise KeyError(
                "Cannot create edge: "
                f"source={rel.source_id} or target={rel.target_id} not found in graph"
            )
        return rel.id

    async def vector_search(
        self,
        embedding: list[float],
        container: str,
        top_k: int,
    ) -> list[GraphEntity]:
        records = await self._run(
            """
            MATCH (n:GraphEntity)
            WHERE $container = '' OR n.container = $container
            RETURN n
            """,
            container=container,
        )
        entities = [
            entity
            for record in records
            if (entity := _record_to_entity(record)) is not None
        ]
        entities.sort(
            key=lambda entity: (
                cosine_similarity(embedding, entity.embedding or []),
                entity.mention_count,
            ),
            reverse=True,
        )
        return entities[:top_k]

    async def get_neighbors(
        self,
        node_id: str,
        max_hops: int,
        relation_types: list[str] | None = None,
    ) -> list[GraphEntity]:
        if not isinstance(max_hops, int) or max_hops < 1 or max_hops > 10:
            raise ValueError(
                f"max_hops must be an integer between 1 and 10, got {max_hops!r}"
            )
        records = await self._run(
            f"""
            MATCH path =
                (start:GraphEntity {{id: $node_id}})-[*1..{max_hops}]-(neighbor:GraphEntity)
            WHERE $relation_types IS NULL
                OR ALL(rel IN relationships(path) WHERE toLower(type(rel)) IN $relation_types)
            RETURN DISTINCT neighbor
            """,
            node_id=node_id,
            relation_types=[item.lower() for item in relation_types] if relation_types else None,
        )
        neighbors: list[GraphEntity] = []
        for record in records:
            entity = _record_to_entity(record, preferred_key="neighbor")
            if entity is not None and entity.id != node_id:
                neighbors.append(entity)
        return neighbors

    async def get_edges(self, node_id: str) -> list[GraphRelationship]:
        records = await self._run(
            """
            MATCH (source:GraphEntity)-[r]-(target:GraphEntity)
            WHERE source.id = $node_id OR target.id = $node_id
            RETURN r
            """,
            node_id=node_id,
        )
        edges: list[GraphRelationship] = []
        for record in records:
            relationship = _record_to_relationship(record)
            if relationship is not None:
                edges.append(relationship)
        return edges

    async def cypher_query(self, query: str, params: dict) -> list[GraphEntity]:
        records = await self._run(query, **params)
        results: list[GraphEntity] = []
        for record in records:
            entity = _record_to_entity(record)
            if entity is not None:
                results.append(entity)
        return results

    def _get_driver(self) -> Any:
        if self._driver is not None:
            return self._driver
        if not (self._uri and self._username and self._password):
            raise ValueError("Neo4j credentials are missing")

        from neo4j import AsyncGraphDatabase

        self._driver = AsyncGraphDatabase.driver(
            self._uri,
            auth=(self._username, self._password),
        )
        return self._driver

    async def _run(
        self,
        query: str,
        *,
        ensure_schema: bool = False,
        **params: Any,
    ) -> list[dict[str, Any]]:
        driver = self._get_driver()
        async with driver.session(database=self._database or None) as session:
            if ensure_schema:
                await self._ensure_schema(session)
            result = await session.run(query, **params)
            return [record async for record in result]

    async def _ensure_schema(self, session: Any) -> None:
        if self._schema_ready:
            return
        async with self._schema_lock:
            if self._schema_ready:
                return
            await session.run(
                """
                CREATE CONSTRAINT hippocampus_graph_entity_id IF NOT EXISTS
                FOR (n:GraphEntity)
                REQUIRE n.id IS UNIQUE
                """,
            )
            self._schema_ready = True


def has_neo4j_credentials(
    *,
    uri: str = "",
    username: str = "",
    password: str = "",
) -> bool:
    return bool(
        (uri or settings.neo4j_uri)
        and (username or settings.neo4j_username)
        and (password or settings.neo4j_password.get_secret_value())
    )


def _entity_payload(entity: GraphEntity) -> dict[str, Any]:
    payload = asdict(entity)
    payload["metadata"] = _serialize_metadata(entity.metadata)
    payload["created_at"] = entity.created_at
    return payload


def _relationship_payload(rel: GraphRelationship) -> dict[str, Any]:
    return {
        "id": rel.id,
        "source_id": rel.source_id,
        "target_id": rel.target_id,
        "relation_type": rel.relation_type.value,
        "weight": rel.weight,
        "metadata": _serialize_metadata(rel.metadata),
        "created_at": rel.created_at,
    }


def _record_to_entity(
    record: Any,
    *,
    preferred_key: str | None = None,
) -> GraphEntity | None:
    values: list[Any] = []
    getter = getattr(record, "get", None)
    if preferred_key is not None and callable(getter):
        preferred_value = getter(preferred_key, None)
        if preferred_value is not None:
            values.append(preferred_value)

    record_values = getattr(record, "values", None)
    if callable(record_values):
        values.extend(list(record_values()))
    elif isinstance(record, dict):
        values.extend(record.values())
    else:
        values.append(record)

    seen_ids: set[int] = set()
    for value in values:
        identifier = id(value)
        if identifier in seen_ids:
            continue
        seen_ids.add(identifier)
        entity = _coerce_graph_entity(value)
        if entity is not None:
            return entity
    return None


def _coerce_graph_entity(value: Any) -> GraphEntity | None:
    if value is None:
        return None
    try:
        payload = dict(value)
    except (TypeError, ValueError):
        return None
    if "id" not in payload or "name" not in payload:
        return None
    return GraphEntity(
        id=str(payload.get("id", "")),
        name=str(payload.get("name", "")),
        entity_type=str(payload.get("entity_type", "")),
        embedding=[float(item) for item in payload.get("embedding", []) or []],
        mention_count=int(payload.get("mention_count", 1) or 1),
        container=str(payload.get("container", "")),
        metadata=_deserialize_metadata(payload.get("metadata")),
        is_latest=bool(payload.get("is_latest", True)),
        created_at=payload.get("created_at", GraphEntity().created_at),
    )


def _record_to_relationship(record: Any) -> GraphRelationship | None:
    values: list[Any] = []
    getter = getattr(record, "get", None)
    if callable(getter):
        relationship_value = getter("r", None)
        if relationship_value is not None:
            values.append(relationship_value)

    record_values = getattr(record, "values", None)
    if callable(record_values):
        values.extend(list(record_values()))
    elif isinstance(record, dict):
        values.extend(record.values())
    else:
        values.append(record)

    seen_ids: set[int] = set()
    for value in values:
        identifier = id(value)
        if identifier in seen_ids:
            continue
        seen_ids.add(identifier)
        relationship = _coerce_graph_relationship(value)
        if relationship is not None:
            return relationship
    return None


def _coerce_graph_relationship(value: Any) -> GraphRelationship | None:
    if value is None:
        return None
    try:
        payload = dict(value)
    except (TypeError, ValueError):
        return None
    if "id" not in payload or "source_id" not in payload or "target_id" not in payload:
        return None
    relation_name = str(payload.get("relation_type", RelationType.RELATED_TO.value)).upper()
    relation_type = RelationType.__members__.get(relation_name, RelationType.RELATED_TO)
    return GraphRelationship(
        id=str(payload.get("id", "")),
        source_id=str(payload.get("source_id", "")),
        target_id=str(payload.get("target_id", "")),
        relation_type=relation_type,
        weight=float(payload.get("weight", 1.0) or 1.0),
        metadata=_deserialize_metadata(payload.get("metadata")),
        created_at=payload.get("created_at", GraphRelationship().created_at),
    )


def _serialize_metadata(metadata: Any) -> str:
    return json.dumps(metadata or {}, sort_keys=True)


def _deserialize_metadata(metadata: Any) -> dict[str, Any]:
    if isinstance(metadata, dict):
        return dict(metadata)
    if isinstance(metadata, str) and metadata:
        try:
            value = json.loads(metadata)
        except json.JSONDecodeError:
            return {}
        if isinstance(value, dict):
            return value
    return {}
