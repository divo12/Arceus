from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime

import asyncpg

from arceus.config.settings import settings
from arceus.core.hippocampus.types import MemoryType, MemoryUnit, MemoryVisibility
from arceus.core.hippocampus.utils.similarity import cosine_similarity
from arceus.core.hippocampus.utils.time import utc_now

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_identifier(value: str, field_name: str) -> str:
    if not _IDENTIFIER_RE.fullmatch(value):
        raise ValueError(f"Invalid {field_name}: {value!r}")
    return value


def _parse_embedding(value: object) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, list):
        return [float(item) for item in value]
    if isinstance(value, tuple):
        return [float(item) for item in value]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped[0] == "[" and stripped[-1] == "]":
            body = stripped[1:-1].strip()
            if not body:
                return []
            return [float(item.strip()) for item in body.split(",")]
        return [float(item) for item in json.loads(stripped)]
    raise TypeError(f"Unsupported embedding payload: {type(value).__name__}")


def _vector_literal(values: list[float] | None) -> str | None:
    if values is None:
        return None
    return "[" + ",".join(str(float(value)) for value in values) + "]"


class PGVectorStore:
    """PostgreSQL + pgvector-backed Hippocampus vector store."""

    def __init__(
        self,
        url: str = "",
        schema: str = "public",
        vector_index_type: str = "hnsw",
        top_k_fetch_multiplier: int = 3,
        dimensions: int = 384,
    ) -> None:
        resolved_url = url or settings.hippocampus_postgres_url or settings.database_url
        if resolved_url and not resolved_url.startswith("postgresql"):
            raise ValueError(
                "PGVectorStore requires a postgresql URL "
                f"(got {resolved_url!r})"
            )
        self._url = resolved_url
        self._schema = _validate_identifier(
            schema or settings.hippocampus_postgres_schema,
            "schema",
        )
        self._vector_index_type = vector_index_type or settings.hippocampus_vector_index_type
        self._top_k_fetch_multiplier = max(top_k_fetch_multiplier, 1)
        self._dimensions = dimensions
        self._pool: asyncpg.Pool | None = None
        self._initialized = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        if self._initialized and self._pool is not None:
            return
        if not self._url:
            raise ValueError("PGVectorStore requires a PostgreSQL URL")

        async with self._lock:
            if self._initialized and self._pool is not None:
                return

            self._pool = await asyncpg.create_pool(self._url)
            async with self._pool.acquire() as connection:
                await connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                await connection.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._schema}"')
                await connection.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{self._schema}".memory_units (
                        id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        startup_id TEXT NOT NULL DEFAULT '',
                        content TEXT NOT NULL,
                        embedding vector({self._dimensions}),
                        memory_type TEXT NOT NULL,
                        confidence DOUBLE PRECISION NOT NULL,
                        relevance_score DOUBLE PRECISION NOT NULL,
                        container TEXT NOT NULL,
                        visibility TEXT NOT NULL,
                        metadata JSONB NOT NULL DEFAULT '{{}}'::jsonb,
                        source_type TEXT NOT NULL DEFAULT '',
                        source_id TEXT NOT NULL DEFAULT '',
                        provenance TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMPTZ NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL,
                        expires_at TIMESTAMPTZ NULL,
                        version INTEGER NOT NULL DEFAULT 1,
                        previous_version_id TEXT NULL,
                        promotion_status TEXT NULL,
                        deleted_at TIMESTAMPTZ NULL,
                        delete_reason TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                await connection.execute(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_units_agent_type
                    ON "{self._schema}".memory_units (agent_id, memory_type)
                    """
                )
                await connection.execute(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_units_container
                    ON "{self._schema}".memory_units (container)
                    """
                )
                await connection.execute(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_units_created_at
                    ON "{self._schema}".memory_units (created_at DESC)
                    """
                )
                await connection.execute(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_memory_units_expires_at
                    ON "{self._schema}".memory_units (agent_id, memory_type, expires_at)
                    WHERE deleted_at IS NULL
                    """
                )
                if self._vector_index_type == "hnsw":
                    await connection.execute(
                        f"""
                        CREATE INDEX IF NOT EXISTS idx_memory_units_embedding_hnsw
                        ON "{self._schema}".memory_units
                        USING hnsw (embedding vector_cosine_ops)
                        """
                    )
                elif self._vector_index_type == "ivfflat":
                    await connection.execute(
                        f"""
                        CREATE INDEX IF NOT EXISTS idx_memory_units_embedding_ivfflat
                        ON "{self._schema}".memory_units
                        USING ivfflat (embedding vector_cosine_ops)
                        """
                    )
                else:
                    raise ValueError(
                        "PGVectorStore vector_index_type must be 'hnsw' or 'ivfflat', "
                        f"got {self._vector_index_type!r}"
                    )

            self._initialized = True

    async def close(self) -> None:
        async with self._lock:
            if self._pool is not None:
                await self._pool.close()
                self._pool = None
                self._initialized = False

    async def upsert(self, unit: MemoryUnit) -> None:
        await self.initialize()
        pool = self._require_pool()
        vector_value = _vector_literal(unit.embedding)
        async with pool.acquire() as connection:
            await connection.execute(
                f"""
                INSERT INTO "{self._schema}".memory_units (
                    id, agent_id, startup_id, content, embedding, memory_type,
                    confidence, relevance_score, container, visibility, metadata,
                    source_type, source_id, provenance, created_at, updated_at,
                    expires_at, version, previous_version_id, promotion_status,
                    deleted_at, delete_reason
                ) VALUES (
                    $1, $2, $3, $4, CAST($5 AS vector({self._dimensions})), $6,
                    $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17,
                    $18, $19, $20, NULL, ''
                )
                ON CONFLICT (id) DO UPDATE SET
                    agent_id = EXCLUDED.agent_id,
                    startup_id = EXCLUDED.startup_id,
                    content = EXCLUDED.content,
                    embedding = EXCLUDED.embedding,
                    memory_type = EXCLUDED.memory_type,
                    confidence = EXCLUDED.confidence,
                    relevance_score = EXCLUDED.relevance_score,
                    container = EXCLUDED.container,
                    visibility = EXCLUDED.visibility,
                    metadata = EXCLUDED.metadata,
                    source_type = EXCLUDED.source_type,
                    source_id = EXCLUDED.source_id,
                    provenance = EXCLUDED.provenance,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at,
                    expires_at = EXCLUDED.expires_at,
                    version = EXCLUDED.version,
                    previous_version_id = EXCLUDED.previous_version_id,
                    promotion_status = EXCLUDED.promotion_status,
                    deleted_at = NULL,
                    delete_reason = ''
                """,
                unit.id,
                unit.agent_id,
                unit.startup_id,
                unit.content,
                vector_value,
                unit.memory_type.value,
                unit.confidence,
                unit.relevance_score,
                unit.container,
                unit.visibility.value,
                json.dumps(unit.metadata),
                unit.source_type,
                unit.source_id,
                unit.provenance,
                unit.created_at,
                unit.updated_at,
                unit.expires_at,
                unit.version,
                unit.previous_version_id,
                unit.promotion_status,
            )

    async def get(self, memory_id: str) -> MemoryUnit | None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                f"""
                SELECT * FROM "{self._schema}".memory_units
                WHERE id = $1 AND deleted_at IS NULL
                """,
                memory_id,
            )
        return None if row is None else self._memory_from_row(row)

    async def search(
        self,
        embedding: list[float],
        container: str,
        *,
        agent_id: str = "",
        memory_types: list[MemoryType] | None = None,
        top_k: int = 10,
    ) -> list[MemoryUnit]:
        await self.initialize()
        pool = self._require_pool()

        filters = ['container = $1', 'deleted_at IS NULL']
        params: list[object] = [container]
        next_index = 2

        if agent_id:
            filters.append(
                f"(agent_id = ${next_index} OR visibility != ${next_index + 1})"
            )
            params.extend([agent_id, MemoryVisibility.PRIVATE.value])
            next_index += 2

        if memory_types:
            filters.append(f"memory_type = ANY(${next_index}::text[])")
            params.append([memory_type.value for memory_type in memory_types])
            next_index += 1

        params.append(_vector_literal(embedding))
        vector_index = next_index
        limit = max(top_k * self._top_k_fetch_multiplier, top_k)
        params.append(limit)
        limit_index = vector_index + 1

        async with pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT * FROM "{self._schema}".memory_units
                WHERE {' AND '.join(filters)}
                ORDER BY embedding <=> CAST(${vector_index} AS vector({self._dimensions})),
                         updated_at DESC
                LIMIT ${limit_index}
                """,
                *params,
            )

        results: list[tuple[float, MemoryUnit]] = []
        for row in rows:
            memory = self._memory_from_row(row)
            results.append((cosine_similarity(embedding, memory.embedding or []), memory))

        results.sort(key=lambda item: (item[0], item[1].updated_at), reverse=True)
        return [memory for _, memory in results[:top_k]]

    async def list_by_type(
        self,
        agent_id: str,
        memory_type: MemoryType | None = None,
        memory_types: list[MemoryType] | None = None,
        container: str | None = None,
        created_after: datetime | None = None,
    ) -> list[MemoryUnit]:
        await self.initialize()
        pool = self._require_pool()

        filters = ['agent_id = $1', 'deleted_at IS NULL']
        params: list[object] = [agent_id]
        next_index = 2

        allowed_types = memory_types or ([memory_type] if memory_type else None)
        if allowed_types:
            filters.append(f"memory_type = ANY(${next_index}::text[])")
            params.append([item.value for item in allowed_types])
            next_index += 1
        if container is not None:
            filters.append(f"container = ${next_index}")
            params.append(container)
            next_index += 1
        if created_after is not None:
            filters.append(f"created_at >= ${next_index}")
            params.append(created_after)
            next_index += 1

        async with pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT * FROM "{self._schema}".memory_units
                WHERE {' AND '.join(filters)}
                ORDER BY updated_at DESC
                """,
                *params,
            )
        return [self._memory_from_row(row) for row in rows]

    async def soft_delete(self, memory_id: str, reason: str = "") -> None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            await connection.execute(
                f"""
                UPDATE "{self._schema}".memory_units
                SET deleted_at = $2, delete_reason = $3
                WHERE id = $1
                """,
                memory_id,
                utc_now(),
                reason,
            )

    async def find_expired(
        self,
        agent_id: str,
        memory_type: MemoryType,
        before: datetime,
    ) -> list[MemoryUnit]:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT * FROM "{self._schema}".memory_units
                WHERE agent_id = $1
                  AND memory_type = $2
                  AND deleted_at IS NULL
                  AND expires_at IS NOT NULL
                  AND expires_at <= $3
                ORDER BY expires_at ASC
                """,
                agent_id,
                memory_type.value,
                before,
            )
        return [self._memory_from_row(row) for row in rows]

    def _require_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("PGVectorStore is not initialized")
        return self._pool

    def _memory_from_row(self, row: asyncpg.Record) -> MemoryUnit:
        metadata = row["metadata"]
        return MemoryUnit(
            id=row["id"],
            agent_id=row["agent_id"],
            startup_id=row["startup_id"],
            content=row["content"],
            embedding=_parse_embedding(row["embedding"]),
            memory_type=MemoryType(row["memory_type"]),
            confidence=row["confidence"],
            relevance_score=row["relevance_score"],
            container=row["container"],
            visibility=MemoryVisibility(row["visibility"]),
            metadata=dict(metadata) if not isinstance(metadata, str) else json.loads(metadata),
            source_type=row["source_type"],
            source_id=row["source_id"],
            provenance=row["provenance"],
            created_at=self._ensure_datetime(row["created_at"]),
            updated_at=self._ensure_datetime(row["updated_at"]),
            expires_at=self._optional_datetime(row["expires_at"]),
            version=row["version"],
            previous_version_id=row["previous_version_id"],
            promotion_status=row["promotion_status"],
        )

    def _ensure_datetime(self, value: datetime | str) -> datetime:
        if isinstance(value, datetime):
            return value
        return datetime.fromisoformat(value)

    def _optional_datetime(self, value: datetime | str | None) -> datetime | None:
        if value is None:
            return None
        return self._ensure_datetime(value)
