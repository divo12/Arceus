from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime

import asyncpg

from arceus.config.settings import settings
from arceus.core.hippocampus.types import Habit, HabitFormation, Pattern, PatternStatus

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_identifier(value: str, field_name: str) -> str:
    if not _IDENTIFIER_RE.fullmatch(value):
        raise ValueError(f"Invalid {field_name}: {value!r}")
    return value


class PostgreSQLRelationalStore:
    """PostgreSQL storage for durable Hippocampus relational state."""

    def __init__(
        self,
        url: str = "",
        schema: str = "public",
    ) -> None:
        resolved_url = url or settings.hippocampus_postgres_url or settings.database_url
        if resolved_url and not resolved_url.startswith("postgresql"):
            raise ValueError(
                "PostgreSQLRelationalStore requires a postgresql URL "
                f"(got {resolved_url!r})"
            )
        self._url = resolved_url
        self._schema = _validate_identifier(
            schema or settings.hippocampus_postgres_schema,
            "schema",
        )
        self._pool: asyncpg.Pool | None = None
        self._initialized = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        if self._initialized and self._pool is not None:
            return
        if not self._url:
            raise ValueError("PostgreSQLRelationalStore requires a PostgreSQL URL")

        async with self._lock:
            if self._initialized and self._pool is not None:
                return

            self._pool = await asyncpg.create_pool(self._url)
            async with self._pool.acquire() as connection:
                await connection.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._schema}"')
                await connection.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{self._schema}".habits (
                        id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        trigger_condition TEXT NOT NULL,
                        action TEXT NOT NULL,
                        confidence DOUBLE PRECISION NOT NULL,
                        usage_count INTEGER NOT NULL,
                        formed_from_id TEXT NOT NULL,
                        formation_mode TEXT NOT NULL,
                        is_active BOOLEAN NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                await connection.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{self._schema}".priming_state (
                        agent_id TEXT PRIMARY KEY,
                        payload JSONB NOT NULL
                    )
                    """
                )
                await connection.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{self._schema}".patterns (
                        id TEXT PRIMARY KEY,
                        agent_id TEXT NOT NULL,
                        description TEXT NOT NULL,
                        strategy TEXT NOT NULL,
                        embedding JSONB,
                        usage_count INTEGER NOT NULL,
                        success_rate DOUBLE PRECISION NOT NULL,
                        formed_from JSONB NOT NULL,
                        cluster_id TEXT,
                        status TEXT NOT NULL,
                        domain TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL
                    )
                    """
                )
                await connection.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{self._schema}".memory_metadata (
                        key TEXT PRIMARY KEY,
                        value JSONB NOT NULL
                    )
                    """
                )
                await connection.execute(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_habits_agent_active
                    ON "{self._schema}".habits (agent_id, is_active, created_at)
                    """
                )
                await connection.execute(
                    f"""
                    CREATE INDEX IF NOT EXISTS idx_patterns_agent_created
                    ON "{self._schema}".patterns (agent_id, created_at)
                    """
                )

            self._initialized = True

    async def close(self) -> None:
        async with self._lock:
            if self._pool is not None:
                await self._pool.close()
                self._pool = None
                self._initialized = False

    async def insert_habit(self, habit: Habit) -> None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            await connection.execute(
                f"""
                INSERT INTO "{self._schema}".habits (
                    id, agent_id, trigger_condition, action, confidence, usage_count,
                    formed_from_id, formation_mode, is_active, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (id) DO UPDATE SET
                    agent_id = EXCLUDED.agent_id,
                    trigger_condition = EXCLUDED.trigger_condition,
                    action = EXCLUDED.action,
                    confidence = EXCLUDED.confidence,
                    usage_count = EXCLUDED.usage_count,
                    formed_from_id = EXCLUDED.formed_from_id,
                    formation_mode = EXCLUDED.formation_mode,
                    is_active = EXCLUDED.is_active,
                    created_at = EXCLUDED.created_at
                """,
                habit.id,
                habit.agent_id,
                habit.trigger_condition,
                habit.action,
                habit.confidence,
                habit.usage_count,
                habit.formed_from_id,
                habit.formation_mode.value,
                habit.is_active,
                habit.created_at,
            )

    async def get_habit(self, habit_id: str) -> Habit:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                f'SELECT * FROM "{self._schema}".habits WHERE id = $1',
                habit_id,
            )
        if row is None:
            raise KeyError(habit_id)
        return self._habit_from_row(row)

    async def list_habits(self, agent_id: str, is_active: bool = True) -> list[Habit]:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT * FROM "{self._schema}".habits
                WHERE agent_id = $1 AND is_active = $2
                ORDER BY created_at ASC
                """,
                agent_id,
                is_active,
            )
        return [self._habit_from_row(row) for row in rows]

    async def update_habit(self, habit: Habit) -> None:
        await self.insert_habit(habit)

    async def record_habit_usage(
        self,
        habit_id: str,
        lr: float,
        signal: float,
    ) -> Habit:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    f'SELECT * FROM "{self._schema}".habits WHERE id = $1 FOR UPDATE',
                    habit_id,
                )
                if row is None:
                    raise KeyError(habit_id)

                habit = self._habit_from_row(row)
                new_count = habit.usage_count + 1
                new_confidence = habit.confidence * (1 - lr) + signal * lr
                updated = Habit(
                    id=habit.id,
                    agent_id=habit.agent_id,
                    trigger_condition=habit.trigger_condition,
                    action=habit.action,
                    confidence=new_confidence,
                    usage_count=new_count,
                    formed_from_id=habit.formed_from_id,
                    formation_mode=habit.formation_mode,
                    is_active=new_confidence > 0.2,
                    created_at=habit.created_at,
                )
                await connection.execute(
                    f"""
                    UPDATE "{self._schema}".habits
                    SET confidence = $2,
                        usage_count = $3,
                        is_active = $4
                    WHERE id = $1
                    """,
                    updated.id,
                    updated.confidence,
                    updated.usage_count,
                    updated.is_active,
                )
        return updated

    async def set_priming_state(self, agent_id: str, state: dict) -> None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            await connection.execute(
                f"""
                INSERT INTO "{self._schema}".priming_state (agent_id, payload)
                VALUES ($1, $2::jsonb)
                ON CONFLICT (agent_id) DO UPDATE SET payload = EXCLUDED.payload
                """,
                agent_id,
                json.dumps(state),
            )

    async def get_priming_state(self, agent_id: str) -> dict | None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                f'SELECT payload FROM "{self._schema}".priming_state WHERE agent_id = $1',
                agent_id,
            )
        if row is None:
            return None
        payload = row["payload"]
        return dict(payload) if not isinstance(payload, str) else json.loads(payload)

    async def insert_pattern(self, pattern: Pattern) -> None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            await connection.execute(
                f"""
                INSERT INTO "{self._schema}".patterns (
                    id, agent_id, description, strategy, embedding, usage_count,
                    success_rate, formed_from, cluster_id, status, domain,
                    created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11, $12, $13
                )
                ON CONFLICT (id) DO UPDATE SET
                    agent_id = EXCLUDED.agent_id,
                    description = EXCLUDED.description,
                    strategy = EXCLUDED.strategy,
                    embedding = EXCLUDED.embedding,
                    usage_count = EXCLUDED.usage_count,
                    success_rate = EXCLUDED.success_rate,
                    formed_from = EXCLUDED.formed_from,
                    cluster_id = EXCLUDED.cluster_id,
                    status = EXCLUDED.status,
                    domain = EXCLUDED.domain,
                    created_at = EXCLUDED.created_at,
                    updated_at = EXCLUDED.updated_at
                """,
                pattern.id,
                pattern.agent_id,
                pattern.description,
                pattern.strategy,
                json.dumps(pattern.embedding),
                pattern.usage_count,
                pattern.success_rate,
                json.dumps(list(pattern.formed_from)),
                pattern.cluster_id,
                pattern.status.value,
                pattern.domain,
                pattern.created_at,
                pattern.updated_at,
            )

    async def update_pattern(self, pattern: Pattern) -> None:
        await self.insert_pattern(pattern)

    async def list_patterns(self, agent_id: str) -> list[Pattern]:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT * FROM "{self._schema}".patterns
                WHERE agent_id = $1
                ORDER BY created_at ASC
                """,
                agent_id,
            )
        return [self._pattern_from_row(row) for row in rows]

    async def update_pattern_status(self, pattern_id: str, status: PatternStatus) -> None:
        await self.initialize()
        pool = self._require_pool()
        async with pool.acquire() as connection:
            await connection.execute(
                f'UPDATE "{self._schema}".patterns SET status = $2 WHERE id = $1',
                pattern_id,
                status.value,
            )

    def _require_pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("PostgreSQLRelationalStore is not initialized")
        return self._pool

    def _habit_from_row(self, row: asyncpg.Record) -> Habit:
        return Habit(
            id=row["id"],
            agent_id=row["agent_id"],
            trigger_condition=row["trigger_condition"],
            action=row["action"],
            confidence=row["confidence"],
            usage_count=row["usage_count"],
            formed_from_id=row["formed_from_id"],
            formation_mode=HabitFormation(row["formation_mode"]),
            is_active=bool(row["is_active"]),
            created_at=self._ensure_datetime(row["created_at"]),
        )

    def _pattern_from_row(self, row: asyncpg.Record) -> Pattern:
        embedding = row["embedding"]
        formed_from = row["formed_from"]
        return Pattern(
            id=row["id"],
            agent_id=row["agent_id"],
            description=row["description"],
            strategy=row["strategy"],
            embedding=self._json_list(embedding),
            usage_count=row["usage_count"],
            success_rate=row["success_rate"],
            formed_from=tuple(self._json_list(formed_from)),
            cluster_id=row["cluster_id"],
            status=PatternStatus(row["status"]),
            domain=row["domain"],
            created_at=self._ensure_datetime(row["created_at"]),
            updated_at=self._ensure_datetime(row["updated_at"]),
        )

    def _json_list(self, value: object) -> list | None:
        if value is None:
            return None
        if isinstance(value, str):
            return json.loads(value)
        return list(value)

    def _ensure_datetime(self, value: datetime | str) -> datetime:
        if isinstance(value, datetime):
            return value
        return datetime.fromisoformat(value)
