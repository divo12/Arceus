"""Task routes."""

from fastapi import APIRouter, Depends

from arceus.api.deps import get_task_repo
from arceus.api.schemas.task import TaskResponse
from arceus.db.repos import TaskRepo

router = APIRouter(prefix="/startups/{startup_id}/tasks", tags=["tasks"])


@router.get("", response_model=list[TaskResponse])
async def list_tasks(
    startup_id: str,
    status: str | None = None,
    priority: str | None = None,
    agent_id: str | None = None,
    repo: TaskRepo = Depends(get_task_repo),
) -> list[TaskResponse]:
    filters: dict = {}
    if status:
        filters["status"] = status
    if priority:
        filters["priority"] = priority
    if agent_id:
        filters["assigned_to_agent_id"] = agent_id
    tasks = await repo.list_for_startup(startup_id, **filters)
    return [TaskResponse.model_validate(t, from_attributes=True) for t in tasks]


@router.get("/tree")
async def get_task_tree(startup_id: str) -> dict:
    return {"startup_id": startup_id, "tree": []}


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    startup_id: str,
    task_id: str,
    repo: TaskRepo = Depends(get_task_repo),
) -> TaskResponse:
    task = await repo.get(task_id)
    if not task:
        from fastapi import HTTPException
        raise HTTPException(404, "Task not found")
    return TaskResponse.model_validate(task, from_attributes=True)


@router.get("/{task_id}/trace")
async def get_task_trace(startup_id: str, task_id: str) -> list:
    return []


@router.get("/{task_id}/children")
async def get_task_children(startup_id: str, task_id: str) -> list:
    return []
