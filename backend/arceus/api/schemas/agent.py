"""Agent request/response schemas."""

from pydantic import BaseModel


class AgentResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    name: str
    role: str
    agent_type: str
    status: str
    level: int
    total_tasks_completed: int
    total_cost: float
