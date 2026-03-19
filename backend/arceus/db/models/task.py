"""Task model — with hierarchical decomposition."""

from enum import StrEnum

from sqlalchemy import ForeignKey, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, generate_uuid


class TaskStatus(StrEnum):
    PLANNED = "planned"
    IN_PROGRESS = "in_progress"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    FAILED = "failed"


class TaskPriority(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default=TaskStatus.PLANNED)
    priority: Mapped[str] = mapped_column(String(20), default=TaskPriority.MEDIUM)

    # Hierarchy
    parent_task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"))
    assigned_to_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    created_by_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))

    # Result
    outcome: Mapped[str | None] = mapped_column(Text)
    cost: Mapped[float] = mapped_column(Numeric(12, 4), default=0)

    # Task execution states (Planner → Executor → Verifier)
    execution_state: Mapped[dict | None] = mapped_column(JSON)

    # Relationships
    startup: Mapped["Startup"] = relationship(back_populates="tasks")
    assigned_agent: Mapped["Agent | None"] = relationship(
        back_populates="tasks", foreign_keys=[assigned_to_agent_id]
    )
    trace_entries: Mapped[list["TraceEntry"]] = relationship(back_populates="task")
    deliverables: Mapped[list["Deliverable"]] = relationship(back_populates="task")
    children: Mapped[list["Task"]] = relationship(back_populates="parent")
    parent: Mapped["Task | None"] = relationship(
        back_populates="children", remote_side="Task.id"
    )


class TraceEntry(Base, TimestampMixin):
    """Immutable audit log entry for a task."""

    __tablename__ = "trace_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    entry_type: Mapped[str] = mapped_column(String(50))  # tool_call, llm_response, decision, etc.
    content: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSON)

    task: Mapped["Task"] = relationship(back_populates="trace_entries")
