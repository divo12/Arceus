from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

import aiosqlite

from arceus.core.hippocampus.types import Habit, HabitFormation, Pattern, PatternStatus


class SQLiteRelationalStore:
    """SQLite relational store used by tests."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._initialized = False
        self._connection: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        if self._initialized and self._connection is not None:
            return

        async with self._lock:
            if self._initialized and self._connection is not None:
                return

            if self._path != ":memory:":
                Path(self._path).parent.mkdir(parents=True, exist_ok=True)

            self._connection = await aiosqlite.connect(self._path)
            await self._connection.execute("PRAGMA journal_mode=WAL;")
            await self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS habits (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    trigger_condition TEXT NOT NULL,
                    action TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    usage_count INTEGER NOT NULL,
                    formed_from_id TEXT NOT NULL,
                    formation_mode TEXT NOT NULL,
                    is_active INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            await self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS priming_state (
                    agent_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                )
                """
            )
            await self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS patterns (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    description TEXT NOT NULL,
                    strategy TEXT NOT NULL,
                    embedding TEXT,
                    usage_count INTEGER NOT NULL,
                    success_rate REAL NOT NULL,
                    formed_from TEXT NOT NULL,
                    cluster_id TEXT,
                    status TEXT NOT NULL,
                    domain TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            await self._connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )
            await self._connection.commit()
            self._initialized = True

    async def close(self) -> None:
        async with self._lock:
            if self._connection is not None:
                await self._connection.close()
                self._connection = None
                self._initialized = False

    async def insert_habit(self, habit: Habit) -> None:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            await connection.execute(
                """
                INSERT OR REPLACE INTO habits (
                    id, agent_id, trigger_condition, action, confidence, usage_count,
                    formed_from_id, formation_mode, is_active, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    habit.id,
                    habit.agent_id,
                    habit.trigger_condition,
                    habit.action,
                    habit.confidence,
                    habit.usage_count,
                    habit.formed_from_id,
                    habit.formation_mode.value,
                    1 if habit.is_active else 0,
                    habit.created_at.isoformat(),
                ),
            )
            await connection.commit()

    async def get_habit(self, habit_id: str) -> Habit:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            cursor = await connection.execute("SELECT * FROM habits WHERE id = ?", (habit_id,))
            row = await cursor.fetchone()
        if row is None:
            raise KeyError(habit_id)
        return self._habit_from_row(row)

    async def list_habits(self, agent_id: str, is_active: bool = True) -> list[Habit]:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            cursor = await connection.execute(
                "SELECT * FROM habits WHERE agent_id = ? AND is_active = ? ORDER BY created_at ASC",
                (agent_id, 1 if is_active else 0),
            )
            rows = await cursor.fetchall()
        return [self._habit_from_row(row) for row in rows]

    async def update_habit(self, habit: Habit) -> None:
        await self.insert_habit(habit)

    async def record_habit_usage(
        self, habit_id: str, lr: float, signal: float
    ) -> Habit:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            cursor = await connection.execute(
                "SELECT * FROM habits WHERE id = ?", (habit_id,)
            )
            row = await cursor.fetchone()
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
                """
                INSERT OR REPLACE INTO habits (
                    id, agent_id, trigger_condition, action, confidence, usage_count,
                    formed_from_id, formation_mode, is_active, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    updated.id,
                    updated.agent_id,
                    updated.trigger_condition,
                    updated.action,
                    updated.confidence,
                    updated.usage_count,
                    updated.formed_from_id,
                    updated.formation_mode.value,
                    1 if updated.is_active else 0,
                    updated.created_at.isoformat(),
                ),
            )
            await connection.commit()
        return updated

    async def set_priming_state(self, agent_id: str, state: dict) -> None:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            await connection.execute(
                "INSERT OR REPLACE INTO priming_state (agent_id, payload) VALUES (?, ?)",
                (agent_id, json.dumps(state)),
            )
            await connection.commit()

    async def get_priming_state(self, agent_id: str) -> dict | None:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            cursor = await connection.execute(
                "SELECT payload FROM priming_state WHERE agent_id = ?",
                (agent_id,),
            )
            row = await cursor.fetchone()
        return None if row is None else json.loads(row[0])

    async def insert_pattern(self, pattern: Pattern) -> None:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            await connection.execute(
                """
                INSERT OR REPLACE INTO patterns (
                    id, agent_id, description, strategy, embedding, usage_count,
                    success_rate, formed_from, cluster_id, status, domain,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
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
                    pattern.created_at.isoformat(),
                    pattern.updated_at.isoformat(),
                ),
            )
            await connection.commit()

    async def update_pattern(self, pattern: Pattern) -> None:
        await self.insert_pattern(pattern)

    async def list_patterns(self, agent_id: str) -> list[Pattern]:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            cursor = await connection.execute(
                "SELECT * FROM patterns WHERE agent_id = ? ORDER BY created_at ASC",
                (agent_id,),
            )
            rows = await cursor.fetchall()
        return [self._pattern_from_row(row) for row in rows]

    async def update_pattern_status(self, pattern_id: str, status: PatternStatus) -> None:
        await self.initialize()
        async with self._lock:
            connection = self._require_connection()
            await connection.execute(
                "UPDATE patterns SET status = ? WHERE id = ?",
                (status.value, pattern_id),
            )
            await connection.commit()

    def _require_connection(self) -> aiosqlite.Connection:
        if self._connection is None:
            raise RuntimeError("SQLiteRelationalStore is not initialized")
        return self._connection

    def _habit_from_row(self, row: aiosqlite.Row | tuple) -> Habit:
        (
            habit_id,
            agent_id,
            trigger_condition,
            action,
            confidence,
            usage_count,
            formed_from_id,
            formation_mode,
            is_active,
            created_at,
        ) = row
        return Habit(
            id=habit_id,
            agent_id=agent_id,
            trigger_condition=trigger_condition,
            action=action,
            confidence=confidence,
            usage_count=usage_count,
            formed_from_id=formed_from_id,
            formation_mode=HabitFormation(formation_mode),
            is_active=bool(is_active),
            created_at=datetime.fromisoformat(created_at),
        )

    def _pattern_from_row(self, row: aiosqlite.Row | tuple) -> Pattern:
        (
            pattern_id,
            agent_id,
            description,
            strategy,
            embedding,
            usage_count,
            success_rate,
            formed_from,
            cluster_id,
            status,
            domain,
            created_at,
            updated_at,
        ) = row
        return Pattern(
            id=pattern_id,
            agent_id=agent_id,
            description=description,
            strategy=strategy,
            embedding=json.loads(embedding) if embedding else None,
            usage_count=usage_count,
            success_rate=success_rate,
            formed_from=tuple(json.loads(formed_from)),
            cluster_id=cluster_id,
            status=PatternStatus(status),
            domain=domain,
            created_at=datetime.fromisoformat(created_at),
            updated_at=datetime.fromisoformat(updated_at),
        )
