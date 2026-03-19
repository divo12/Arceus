from __future__ import annotations

import pytest

from arceus.core.hippocampus.types import MemoryType
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
        assert profile.state == {}
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
        assert profile.state == {}
    finally:
        await hippocampus.close()
