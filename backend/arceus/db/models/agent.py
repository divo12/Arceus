"""Agent model — EmployeeAgent and SpawnedAgent."""

from enum import StrEnum

from sqlalchemy import ForeignKey, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, generate_uuid


class AgentType(StrEnum):
    EMPLOYEE = "employee"
    GENERIC_SPAWNED = "generic_spawned"
    SPECIALIZED_CODING = "specialized_coding"
    SPECIALIZED_BROWSER = "specialized_browser"
    EXPLORATORY = "exploratory"


class AgentStatus(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    BLOCKED = "blocked"
    DESTROYED = "destroyed"
    ERROR = "error"


class Agent(Base, TimestampMixin):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(100))
    agent_type: Mapped[str] = mapped_column(String(50), default=AgentType.EMPLOYEE)
    status: Mapped[str] = mapped_column(String(20), default=AgentStatus.IDLE)
    level: Mapped[int] = mapped_column(Integer, default=0)

    # Hierarchy
    parent_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))

    # For spawned agents
    spawned_by_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    spawned_for_task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"))

    # Config
    system_prompt: Mapped[str | None] = mapped_column(Text)
    tools_config: Mapped[dict | None] = mapped_column(JSON)

    # Agent memory — knowledge from meetings, injected into LLM context
    agent_memory: Mapped[list | None] = mapped_column(JSON, default=list)

    # Metrics
    total_tasks_completed: Mapped[int] = mapped_column(Integer, default=0)
    total_cost: Mapped[float] = mapped_column(Numeric(12, 4), default=0)

    # Relationships
    startup: Mapped["Startup"] = relationship(back_populates="agents")
    tasks: Mapped[list["Task"]] = relationship(
        back_populates="assigned_agent", foreign_keys="Task.assigned_to_agent_id"
    )
