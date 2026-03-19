from __future__ import annotations

import pytest

from arceus.core.delegation_memory import DelegationMemoryManager
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType
from arceus.core.memory_scope import ArceusMemoryScope


@pytest.mark.asyncio
async def test_prepare_delegation_context_copies_memories_into_task_scope(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    from_hippocampus = await hippocampus_factory("emp-1")
    to_hippocampus = await hippocampus_factory("emp-2")
    startup_id = "startup-1"
    task_id = "task-1"
    from_container = scope.employee_container(startup_id, "emp-1")
    task_container = scope.task_container(startup_id, task_id)

    try:
        await from_hippocampus.remember(
            "We use JWT for authentication",
            container=from_container,
            memory_type=MemoryType.STATIC,
        )
        await from_hippocampus.remember(
            "Current auth rollout needs refresh-token metrics",
            container=from_container,
            memory_type=MemoryType.DYNAMIC,
        )

        copied = await manager.prepare_delegation_context(
            from_hippocampus=from_hippocampus,
            to_hippocampus=to_hippocampus,
            from_agent_id="emp-1",
            to_agent_id="emp-2",
            startup_id=startup_id,
            task_id=task_id,
            task_description="JWT auth refresh tokens",
        )
        delegated = await to_hippocampus.recall(
            "JWT auth refresh tokens",
            container=task_container,
            top_k=10,
            include_graph=False,
        )

        assert len(copied) == 2
        assert all(memory.memory_type is MemoryType.DYNAMIC for memory in copied)
        assert all(memory.container == task_container for memory in copied)
        assert {memory.content for memory in delegated} == {
            "We use JWT for authentication",
            "Current auth rollout needs refresh-token metrics",
        }
    finally:
        await from_hippocampus.close()
        await to_hippocampus.close()


@pytest.mark.asyncio
async def test_delegation_copies_not_references(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    from_hippocampus = await hippocampus_factory("emp-1")
    to_hippocampus = await hippocampus_factory("emp-2")
    startup_id = "startup-1"
    task_id = "task-1"
    from_container = scope.employee_container(startup_id, "emp-1")
    task_container = scope.task_container(startup_id, task_id)

    try:
        original = await from_hippocampus.remember(
            "Stripe webhooks drive payment notifications",
            container=from_container,
            memory_type=MemoryType.STATIC,
        )

        copied = await manager.prepare_delegation_context(
            from_hippocampus=from_hippocampus,
            to_hippocampus=to_hippocampus,
            from_agent_id="emp-1",
            to_agent_id="emp-2",
            startup_id=startup_id,
            task_id=task_id,
            task_description="payment notifications",
        )
        delegated = await to_hippocampus.recall(
            "payment notifications",
            container=task_container,
            top_k=10,
            include_graph=False,
        )

        assert len(copied) == 1
        assert copied[0].id != original.id
        assert len(delegated) == 1
        assert delegated[0].id != original.id
    finally:
        await from_hippocampus.close()
        await to_hippocampus.close()


@pytest.mark.asyncio
async def test_delegation_sets_source_type(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    from_hippocampus = await hippocampus_factory("emp-1")
    to_hippocampus = await hippocampus_factory("emp-2")

    try:
        await from_hippocampus.remember(
            "Stripe webhooks drive payment notifications",
            container=scope.employee_container("startup-1", "emp-1"),
            memory_type=MemoryType.STATIC,
        )

        copied = await manager.prepare_delegation_context(
            from_hippocampus=from_hippocampus,
            to_hippocampus=to_hippocampus,
            from_agent_id="emp-1",
            to_agent_id="emp-2",
            startup_id="startup-1",
            task_id="task-1",
            task_description="payment notifications",
        )

        assert len(copied) == 1
        assert copied[0].source_type == "delegation"
        assert copied[0].source_id == "emp-1"
        assert copied[0].metadata["delegated_from"] == "emp-1"

        # Verify the persisted memory (not just the local copy) carries delegation metadata
        task_container = scope.task_container("startup-1", "task-1")
        persisted = await to_hippocampus.recall(
            "payment notifications",
            container=task_container,
            top_k=10,
            include_graph=False,
        )
        assert len(persisted) == 1
        assert persisted[0].source_type == "delegation"
        assert persisted[0].metadata["delegated_from"] == "emp-1"
    finally:
        await from_hippocampus.close()
        await to_hippocampus.close()


@pytest.mark.asyncio
async def test_internalize_high_quality(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        await manager.internalize_delegation_result(
            delegator_hippocampus=hippocampus,
            delegator_agent_id="emp-1",
            startup_id="startup-1",
            learnings=["Keep JWT expiry aligned with session windows"],
            quality=0.95,
        )

        results = await hippocampus.recall(
            "JWT expiry session windows",
            container=container,
            top_k=10,
            include_graph=False,
        )

        assert len(results) == 1
        assert results[0].content == "Keep JWT expiry aligned with session windows"
        memory_types = {memory.content: memory.memory_type for memory in results}
        assert memory_types["Keep JWT expiry aligned with session windows"] is MemoryType.STATIC
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_internalize_medium_quality(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        await manager.internalize_delegation_result(
            delegator_hippocampus=hippocampus,
            delegator_agent_id="emp-1",
            startup_id="startup-1",
            learnings=["Track auth rollout blockers daily"],
            quality=0.70,
        )

        results = await hippocampus.recall(
            "auth rollout blockers",
            container=container,
            top_k=10,
            include_graph=False,
        )

        assert len(results) == 1
        assert results[0].content == "Track auth rollout blockers daily"
        assert results[0].memory_type is MemoryType.DYNAMIC
    finally:
        await hippocampus.close()


@pytest.mark.asyncio
async def test_internalize_low_quality_skipped(hippocampus_factory) -> None:
    scope = ArceusMemoryScope()
    manager = DelegationMemoryManager(scope)
    hippocampus = await hippocampus_factory("emp-1")
    container = scope.employee_container("startup-1", "emp-1")

    try:
        await manager.internalize_delegation_result(
            delegator_hippocampus=hippocampus,
            delegator_agent_id="emp-1",
            startup_id="startup-1",
            learnings=["Ignore this low-confidence note"],
            quality=0.50,
        )

        results = await hippocampus.recall(
            "low-confidence note",
            container=container,
            top_k=10,
            include_graph=False,
        )

        assert results == []
    finally:
        await hippocampus.close()
