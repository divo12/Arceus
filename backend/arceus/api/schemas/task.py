"""Task request/response schemas."""

from pydantic import BaseModel


class TaskResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    description: str | None = None
    status: str
    priority: str
    assigned_to_agent_id: str | None = None
    parent_task_id: str | None = None
    cost: float


class TaskCreate(BaseModel):
    title: str
    description: str | None = None
    priority: str = "medium"
    assigned_to_agent_id: str | None = None
    parent_task_id: str | None = None
