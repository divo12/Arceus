from __future__ import annotations

import pytest

from arceus.core.hippocampus.types import Habit, MemoryType
from arceus.core.memory_scope import ArceusMemoryScope
from arceus.core.profile_engine import ArceusProfileEngine


@pytest.mark.asyncio
async def test_generate_profile_with_facts(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    engine = ArceusProfileEngine(scope)
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

        profile = await engine.generate_profile(
            hippocampus=hippocampus,
            agent_id="emp-1",
            startup_id="startup-1",
            role="CTO",
        )

        assert profile.role == "CTO"
        assert profile.core_knowledge == ["We use JWT for authentication"]
        assert profile.current_context == ["Current auth rollout needs refresh-token metrics"]
        assert profile.habits == []
        assert profile.state == {
            "confidence": 0.5,
            "caution": 0.3,
            "morale": 0.5,
            "recent_events": [],
        }
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_generate_profile_empty(hippocampus_factory) -> None:
    engine = ArceusProfileEngine()
    hippocampus = await hippocampus_factory("emp-1")

    try:
        profile = await engine.generate_profile(
            hippocampus=hippocampus,
            agent_id="emp-1",
            startup_id="startup-1",
            role="Engineer",
        )

        assert profile.role == "Engineer"
        assert profile.core_knowledge == []
        assert profile.current_context == []
        assert profile.habits == []
        assert profile.state == {
            "confidence": 0.5,
            "caution": 0.3,
            "morale": 0.5,
            "recent_events": [],
        }
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_generate_profile_with_habits_and_state(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    engine = ArceusProfileEngine(scope)
    hippocampus = await hippocampus_factory("emp-2")

    try:
        assert hippocampus.procedural_memory is not None
        assert hippocampus.priming_memory is not None

        await hippocampus.procedural_memory.add_habit(
            Habit(
                agent_id="emp-2",
                trigger_condition="when reviewing auth changes",
                action="check token expiry assumptions",
                confidence=0.9,
                usage_count=5,
                formed_from_id="pattern-1",
            )
        )
        await hippocampus.priming_memory.update_state("success", 1.0, "test")

        profile = await engine.generate_profile(
            hippocampus=hippocampus,
            agent_id="emp-2",
            startup_id="startup-1",
            role="Engineer",
        )

        assert len(profile.habits) == 1
        assert profile.habits[0]["trigger"] == "when reviewing auth changes"
        assert {"confidence", "morale", "caution"} <= set(profile.state)
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_generate_profile_returns_all_memories_without_search_truncation(
    hippocampus_factory,
) -> None:
    scope = ArceusMemoryScope()
    engine = ArceusProfileEngine(scope)
    hippocampus = await hippocampus_factory("emp-3")
    container = scope.employee_container("startup-1", "emp-3")

    static_facts = [f"Static fact {index}" for index in range(60)]
    dynamic_facts = [f"Dynamic fact {index}" for index in range(25)]

    try:
        for fact in static_facts:
            await hippocampus.remember(
                fact,
                container=container,
                memory_type=MemoryType.STATIC,
            )
        for fact in dynamic_facts:
            await hippocampus.remember(
                fact,
                container=container,
                memory_type=MemoryType.DYNAMIC,
            )

        profile = await engine.generate_profile(
            hippocampus=hippocampus,
            agent_id="emp-3",
            startup_id="startup-1",
            role="PM",
        )

        assert len(profile.core_knowledge) == len(static_facts)
        assert len(profile.current_context) == len(dynamic_facts)
        assert set(profile.core_knowledge) == set(static_facts)
        assert set(profile.current_context) == set(dynamic_facts)
    finally:
        await hippocampus.close()
