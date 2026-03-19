from __future__ import annotations

import pytest
import pytest_asyncio

from arceus.core.hippocampus.backends.noop_llm import NoopLLMEngine
from arceus.core.hippocampus.backends.sqlite_relational import SQLiteRelationalStore
from arceus.core.hippocampus.tiers.procedural import ProceduralMemory
from arceus.core.hippocampus.types import Habit


@pytest_asyncio.fixture
async def relational_store(tmp_path):
    store = SQLiteRelationalStore(str(tmp_path / "procedural.db"))
    await store.initialize()
    try:
        yield store
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_add_and_list_habits(relational_store: SQLiteRelationalStore) -> None:
    memory = ProceduralMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    await memory.add_habit(
        Habit(
            agent_id="agent-1",
            trigger_condition="when debugging auth",
            action="check token expiry first",
        )
    )
    await memory.add_habit(
        Habit(
            agent_id="agent-1",
            trigger_condition="when writing migrations",
            action="review rollback plan",
        )
    )

    habits = await memory.get_active()

    assert len(habits) == 2
    assert {habit.trigger_condition for habit in habits} == {
        "when debugging auth",
        "when writing migrations",
    }


@pytest.mark.asyncio
async def test_get_matching_habits_noop_llm(relational_store: SQLiteRelationalStore) -> None:
    memory = ProceduralMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )
    await memory.add_habit(
        Habit(
            agent_id="agent-1",
            trigger_condition="when reviewing PRs",
            action="check tests first",
        )
    )

    matches = await memory.get_matching_habits("some context")

    assert matches == []


@pytest.mark.asyncio
async def test_record_usage_increases_count(relational_store: SQLiteRelationalStore) -> None:
    memory = ProceduralMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )
    habit = await memory.add_habit(
        Habit(
            agent_id="agent-1",
            trigger_condition="when deploying",
            action="verify migrations",
            confidence=0.5,
            usage_count=0,
        )
    )

    updated = await memory.record_usage(habit.id, was_useful=True)

    assert updated.usage_count == 1
    assert updated.confidence > habit.confidence


@pytest.mark.asyncio
async def test_record_usage_negative_deactivates(relational_store: SQLiteRelationalStore) -> None:
    memory = ProceduralMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )
    habit = await memory.add_habit(
        Habit(
            agent_id="agent-1",
            trigger_condition="when triaging incidents",
            action="page the owner immediately",
            confidence=0.2,
        )
    )

    updated = habit
    for _ in range(3):
        updated = await memory.record_usage(habit.id, was_useful=False)

    assert updated.confidence < 0.2
    assert updated.is_active is False


@pytest.mark.asyncio
async def test_empty_habits_returns_empty(relational_store: SQLiteRelationalStore) -> None:
    memory = ProceduralMemory(
        agent_id="agent-1",
        relational_store=relational_store,
        llm_light=NoopLLMEngine(model_name="noop"),
    )

    assert await memory.get_active() == []
    assert await memory.get_matching_habits("anything") == []
