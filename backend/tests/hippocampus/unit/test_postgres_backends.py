from __future__ import annotations

import json
from datetime import timedelta

import pytest

from arceus.core.hippocampus.backends.pgvector_store import PGVectorStore
from arceus.core.hippocampus.backends.postgres_relational import PostgreSQLRelationalStore
from arceus.core.hippocampus.types import (
    Habit,
    HabitFormation,
    MemoryType,
    MemoryUnit,
    MemoryVisibility,
    Pattern,
    PatternStatus,
)
from arceus.core.hippocampus.utils.similarity import cosine_similarity
from arceus.core.hippocampus.utils.time import utc_now


class _FakeAcquire:
    def __init__(self, connection) -> None:  # noqa: ANN001
        self._connection = connection

    async def __aenter__(self):  # noqa: ANN201
        return self._connection

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        del exc_type, exc, tb


class _FakeTransaction:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        del exc_type, exc, tb


class _FakePool:
    def __init__(self, connection) -> None:  # noqa: ANN001
        self._connection = connection
        self.closed = False

    def acquire(self) -> _FakeAcquire:
        return _FakeAcquire(self._connection)

    async def close(self) -> None:
        self.closed = True


class _FakeRelationalConnection:
    def __init__(self) -> None:
        self.executed: list[str] = []
        self.habits: dict[str, dict] = {}
        self.priming: dict[str, dict] = {}
        self.patterns: dict[str, dict] = {}

    async def execute(self, query: str, *args) -> None:  # noqa: ANN002
        normalized = " ".join(query.split())
        self.executed.append(normalized)

        if 'INSERT INTO "hippocampus".habits' in normalized:
            self.habits[args[0]] = {
                "id": args[0],
                "agent_id": args[1],
                "trigger_condition": args[2],
                "action": args[3],
                "confidence": args[4],
                "usage_count": args[5],
                "formed_from_id": args[6],
                "formation_mode": args[7],
                "is_active": args[8],
                "created_at": args[9],
            }
            return

        if 'UPDATE "hippocampus".habits' in normalized:
            habit = self.habits[args[0]]
            habit["confidence"] = args[1]
            habit["usage_count"] = args[2]
            habit["is_active"] = args[3]
            return

        if 'INSERT INTO "hippocampus".priming_state' in normalized:
            self.priming[args[0]] = json.loads(args[1])
            return

        if 'INSERT INTO "hippocampus".patterns' in normalized:
            self.patterns[args[0]] = {
                "id": args[0],
                "agent_id": args[1],
                "description": args[2],
                "strategy": args[3],
                "embedding": json.loads(args[4]) if args[4] != "null" else None,
                "usage_count": args[5],
                "success_rate": args[6],
                "formed_from": json.loads(args[7]),
                "cluster_id": args[8],
                "status": args[9],
                "domain": args[10],
                "created_at": args[11],
                "updated_at": args[12],
            }
            return

        if 'UPDATE "hippocampus".patterns SET status' in normalized:
            self.patterns[args[0]]["status"] = args[1]
            return

    async def fetchrow(self, query: str, *args):  # noqa: ANN002, ANN201
        normalized = " ".join(query.split())
        if 'FROM "hippocampus".habits WHERE id = $1' in normalized:
            return self.habits.get(args[0])
        if 'FROM "hippocampus".priming_state WHERE agent_id = $1' in normalized:
            payload = self.priming.get(args[0])
            return None if payload is None else {"payload": payload}
        return None

    async def fetch(self, query: str, *args):  # noqa: ANN002, ANN201
        normalized = " ".join(query.split())
        if 'FROM "hippocampus".habits' in normalized:
            return sorted(
                [
                    habit
                    for habit in self.habits.values()
                    if habit["agent_id"] == args[0] and habit["is_active"] is args[1]
                ],
                key=lambda item: item["created_at"],
            )
        if 'FROM "hippocampus".patterns' in normalized:
            return sorted(
                [pattern for pattern in self.patterns.values() if pattern["agent_id"] == args[0]],
                key=lambda item: item["created_at"],
            )
        return []

    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction()


def _parse_vector_literal(value: str | None) -> list[float] | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped or stripped == "[]":
        return []
    return [float(item) for item in stripped[1:-1].split(",")]


class _FakeVectorConnection:
    def __init__(self) -> None:
        self.executed: list[str] = []
        self.rows: dict[str, dict] = {}

    async def execute(self, query: str, *args) -> None:  # noqa: ANN002
        normalized = " ".join(query.split())
        self.executed.append(normalized)

        if 'INSERT INTO "hippocampus".memory_units' in normalized:
            self.rows[args[0]] = {
                "id": args[0],
                "agent_id": args[1],
                "startup_id": args[2],
                "content": args[3],
                "embedding": _parse_vector_literal(args[4]),
                "memory_type": args[5],
                "confidence": args[6],
                "relevance_score": args[7],
                "container": args[8],
                "visibility": args[9],
                "metadata": json.loads(args[10]),
                "source_type": args[11],
                "source_id": args[12],
                "provenance": args[13],
                "created_at": args[14],
                "updated_at": args[15],
                "expires_at": args[16],
                "version": args[17],
                "previous_version_id": args[18],
                "promotion_status": args[19],
                "deleted_at": None,
                "delete_reason": "",
            }
            return

        if 'UPDATE "hippocampus".memory_units SET deleted_at' in normalized:
            row = self.rows.get(args[0])
            if row is not None:
                row["deleted_at"] = args[1]
                row["delete_reason"] = args[2]

    async def fetchrow(self, query: str, *args):  # noqa: ANN002, ANN201
        normalized = " ".join(query.split())
        if 'FROM "hippocampus".memory_units WHERE id = $1 AND deleted_at IS NULL' in normalized:
            row = self.rows.get(args[0])
            if row is None or row["deleted_at"] is not None:
                return None
            return row
        return None

    async def fetch(self, query: str, *args):  # noqa: ANN002, ANN201
        normalized = " ".join(query.split())

        if 'ORDER BY embedding <=>' in normalized:
            container = args[0]
            index = 1
            agent_id = ""
            if "visibility !=" in normalized:
                agent_id = args[index]
                private_value = args[index + 1]
                index += 2
            else:
                private_value = MemoryVisibility.PRIVATE.value

            memory_types: set[str] | None = None
            if "memory_type = ANY" in normalized:
                memory_types = set(args[index])
                index += 1

            query_embedding = _parse_vector_literal(args[index]) or []
            limit = args[index + 1]

            rows = []
            for row in self.rows.values():
                if row["deleted_at"] is not None or row["container"] != container:
                    continue
                if agent_id and not (
                    row["agent_id"] == agent_id or row["visibility"] != private_value
                ):
                    continue
                if memory_types and row["memory_type"] not in memory_types:
                    continue
                rows.append(row)

            rows.sort(
                key=lambda item: (
                    cosine_similarity(query_embedding, item["embedding"] or []),
                    item["updated_at"],
                ),
                reverse=True,
            )
            return rows[:limit]

        if 'AND expires_at <= $3' in normalized:
            agent_id = args[0]
            memory_type = args[1]
            before = args[2]
            rows = [
                row
                for row in self.rows.values()
                if row["deleted_at"] is None
                and row["agent_id"] == agent_id
                and row["memory_type"] == memory_type
                and row["expires_at"] is not None
                and row["expires_at"] <= before
            ]
            rows.sort(key=lambda item: item["expires_at"])
            return rows

        if 'FROM "hippocampus".memory_units WHERE agent_id = $1' in normalized:
            agent_id = args[0]
            index = 1
            memory_types: set[str] | None = None
            container: str | None = None
            created_after = None

            if "memory_type = ANY" in normalized:
                memory_types = set(args[index])
                index += 1
            if "container =" in normalized:
                container = args[index]
                index += 1
            if "created_at >=" in normalized:
                created_after = args[index]

            rows = []
            for row in self.rows.values():
                if row["deleted_at"] is not None or row["agent_id"] != agent_id:
                    continue
                if memory_types and row["memory_type"] not in memory_types:
                    continue
                if container is not None and row["container"] != container:
                    continue
                if created_after is not None and row["created_at"] < created_after:
                    continue
                rows.append(row)

            rows.sort(key=lambda item: item["updated_at"], reverse=True)
            return rows

        return []


@pytest.mark.asyncio
async def test_postgres_relational_store_initialize_and_close(monkeypatch) -> None:
    connection = _FakeRelationalConnection()
    pool = _FakePool(connection)

    async def fake_create_pool(url: str) -> _FakePool:
        assert url == "postgresql+asyncpg://user:pass@localhost:5432/arceus"
        return pool

    monkeypatch.setattr("asyncpg.create_pool", fake_create_pool)

    store = PostgreSQLRelationalStore(
        url="postgresql+asyncpg://user:pass@localhost:5432/arceus",
        schema="hippocampus",
    )
    await store.initialize()

    assert any('CREATE SCHEMA IF NOT EXISTS "hippocampus"' in query for query in connection.executed)
    assert store._pool is pool

    await store.close()
    assert pool.closed is True


@pytest.mark.asyncio
async def test_postgres_relational_store_crud_behaves_like_sqlite() -> None:
    connection = _FakeRelationalConnection()
    store = PostgreSQLRelationalStore(
        url="postgresql+asyncpg://user:pass@localhost:5432/arceus",
        schema="hippocampus",
    )
    store._pool = _FakePool(connection)
    store._initialized = True

    created_at = utc_now()
    habit = Habit(
        id="habit-1",
        agent_id="agent-1",
        trigger_condition="before deploy",
        action="check release notes",
        confidence=0.6,
        usage_count=0,
        formed_from_id="pattern-1",
        formation_mode=HabitFormation.AUTO,
        created_at=created_at,
    )
    await store.insert_habit(habit)

    loaded = await store.get_habit("habit-1")
    assert loaded == habit

    updated = await store.record_habit_usage("habit-1", lr=0.5, signal=1.0)
    assert updated.usage_count == 1
    assert updated.confidence == pytest.approx(0.8)

    await store.set_priming_state("agent-1", {"confidence": 0.7})
    assert await store.get_priming_state("agent-1") == {"confidence": 0.7}

    pattern = Pattern(
        id="pattern-1",
        agent_id="agent-1",
        description="auth rollout",
        strategy="roll out in phases",
        embedding=[0.1, 0.2],
        usage_count=3,
        success_rate=0.9,
        formed_from=("traj-1",),
        status=PatternStatus.ACTIVE,
        domain="security",
        created_at=created_at,
        updated_at=created_at,
    )
    await store.insert_pattern(pattern)
    await store.update_pattern_status("pattern-1", PatternStatus.MERGED)

    patterns = await store.list_patterns("agent-1")
    assert len(patterns) == 1
    assert patterns[0].status is PatternStatus.MERGED


@pytest.mark.asyncio
async def test_pgvector_store_initialize_and_query_behaviors(monkeypatch) -> None:
    connection = _FakeVectorConnection()
    pool = _FakePool(connection)

    async def fake_create_pool(url: str) -> _FakePool:
        assert url == "postgresql+asyncpg://user:pass@localhost:5432/arceus"
        return pool

    monkeypatch.setattr("asyncpg.create_pool", fake_create_pool)

    store = PGVectorStore(
        url="postgresql+asyncpg://user:pass@localhost:5432/arceus",
        schema="hippocampus",
        dimensions=3,
    )
    await store.initialize()

    assert any("CREATE EXTENSION IF NOT EXISTS vector" in query for query in connection.executed)
    assert any('CREATE TABLE IF NOT EXISTS "hippocampus".memory_units' in query for query in connection.executed)
    assert any("idx_memory_units_embedding_hnsw" in query for query in connection.executed)

    now = utc_now()
    private_memory = MemoryUnit(
        id="private-1",
        agent_id="pm-1",
        content="private note",
        embedding=[1.0, 0.0, 0.0],
        memory_type=MemoryType.DYNAMIC,
        container="startup:acme",
        visibility=MemoryVisibility.PRIVATE,
        created_at=now,
        updated_at=now,
    )
    shared_memory = MemoryUnit(
        id="shared-1",
        agent_id="pm-1",
        content="shared note",
        embedding=[0.9, 0.1, 0.0],
        memory_type=MemoryType.DYNAMIC,
        container="startup:acme",
        visibility=MemoryVisibility.STARTUP_SHARED,
        created_at=now,
        updated_at=now,
    )
    expired_memory = MemoryUnit(
        id="expired-1",
        agent_id="pm-1",
        content="expired note",
        embedding=[0.2, 0.8, 0.0],
        memory_type=MemoryType.DYNAMIC,
        container="startup:acme",
        visibility=MemoryVisibility.STARTUP_SHARED,
        expires_at=now - timedelta(hours=1),
        created_at=now,
        updated_at=now,
    )

    await store.upsert(private_memory)
    await store.upsert(shared_memory)
    await store.upsert(expired_memory)

    loaded = await store.get("private-1")
    assert loaded is not None
    assert loaded.content == "private note"

    own_results = await store.search(
        embedding=[1.0, 0.0, 0.0],
        container="startup:acme",
        agent_id="pm-1",
    )
    assert {memory.id for memory in own_results} == {"private-1", "shared-1", "expired-1"}

    other_results = await store.search(
        embedding=[1.0, 0.0, 0.0],
        container="startup:acme",
        agent_id="cto-1",
    )
    assert {memory.id for memory in other_results} == {"shared-1", "expired-1"}

    listed = await store.list_by_type(agent_id="pm-1", memory_type=MemoryType.DYNAMIC)
    assert {memory.id for memory in listed} == {"private-1", "shared-1", "expired-1"}

    expired = await store.find_expired("pm-1", MemoryType.DYNAMIC, now)
    assert [memory.id for memory in expired] == ["expired-1"]

    await store.soft_delete("private-1", reason="obsolete")
    assert await store.get("private-1") is None

    await store.close()
    assert pool.closed is True
