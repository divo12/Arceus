import pytest

from arceus.core.hippocampus.config import HippocampusConfig
from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.hippocampus.types import MemoryType
from arceus.core.memory_scope import ArceusMemoryScope


def test_memory_scope_generates_canonical_container_names() -> None:
    scope = ArceusMemoryScope()

    assert scope.startup_container("startup-1") == "startup:startup-1"
    assert scope.employee_container("startup-1", "emp-1") == "startup:startup-1:emp:emp-1"
    assert scope.task_container("startup-1", "task-1") == "startup:startup-1:task:task-1"
    assert (
        scope.sub_agent_container("startup-1", "task-1", "sub-1")
        == "startup:startup-1:task:task-1:sub:sub-1"
    )


@pytest.mark.asyncio
async def test_memory_scope_retrieves_shared_private_and_task_memories_without_leakage(
    tmp_path,
) -> None:
    scope = ArceusMemoryScope()
    hippocampus = await Hippocampus.create(
        agent_id="emp-1",
        config=HippocampusConfig(sqlite_path=str(tmp_path / "hippocampus.db")),
    )

    startup_id = "startup-1"
    employee_id = "emp-1"
    task_id = "task-1"

    await hippocampus.remember(
        "The company uses JWT for authentication",
        container=scope.startup_container(startup_id),
        memory_type=MemoryType.STATIC,
    )
    await hippocampus.remember(
        "I prefer writing auth tests before refactoring",
        container=scope.employee_container(startup_id, employee_id),
        memory_type=MemoryType.DYNAMIC,
    )
    await hippocampus.remember(
        "The current task is debugging token refresh",
        container=scope.task_container(startup_id, task_id),
        memory_type=MemoryType.DYNAMIC,
    )
    await hippocampus.remember(
        "Another employee owns SSO integration",
        container=scope.employee_container(startup_id, "emp-2"),
        memory_type=MemoryType.DYNAMIC,
    )

    results = await scope.get_memories_for_agent(
        hippocampus=hippocampus,
        query="auth token JWT",
        startup_id=startup_id,
        employee_id=employee_id,
        task_id=task_id,
        include_shared=True,
    )

    contents = [memory.content for memory in results]
    assert "The company uses JWT for authentication" in contents
    assert "I prefer writing auth tests before refactoring" in contents
    assert "The current task is debugging token refresh" in contents
    assert "Another employee owns SSO integration" not in contents
