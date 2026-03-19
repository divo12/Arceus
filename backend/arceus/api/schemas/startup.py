"""Startup request/response schemas."""

from pydantic import BaseModel


class StartupCreate(BaseModel):
    name: str
    core_idea: str
    budget: float = 500.0


class StartupStatusUpdate(BaseModel):
    status: str  # "active" | "paused" | "archived"


class StartupResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    name: str
    status: str
    core_idea: str
    current_direction: str
    budget_allocated: float
    budget_spent: float


class StartupOverview(BaseModel):
    startup_id: str
    employees_total: int
    employees_running: int
    tasks_open: int
    tasks_completed: int
    budget_spent: float
    budget_allocated: float
    pending_approvals: int


class MemberInvite(BaseModel):
    email: str


class MemberResponse(BaseModel):
    model_config = {"from_attributes": True}

    user_id: str
    email: str
    role: str
