"""Memory metadata models — Pattern, Skill, Habit references.

The actual memory content lives in Mem0. These are metadata/pointers
stored in Postgres for dashboard display and fast queries.
"""

from sqlalchemy import Float, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, generate_uuid


class MemoryMetadata(Base, TimestampMixin):
    """Pointer to a Mem0 memory unit with local metadata."""

    __tablename__ = "memory_metadata"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    mem0_id: Mapped[str] = mapped_column(String(255))  # ID in Mem0's storage
    memory_type: Mapped[str] = mapped_column(String(50))  # episode, pattern, skill, habit
    summary: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float)
    access_count: Mapped[int] = mapped_column(Integer, default=0)
    tags: Mapped[dict | None] = mapped_column(JSON)


class Approval(Base, TimestampMixin):
    """Escalated decisions needing user approval."""

    __tablename__ = "approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    from_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    approval_type: Mapped[str] = mapped_column(String(50))  # budget, direction, tool, spawn
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending, accepted, rejected
    feedback: Mapped[str | None] = mapped_column(Text)


class ChatMessage(Base, TimestampMixin):
    """CEO ↔ User chat history."""

    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # user, assistant
    content: Mapped[str] = mapped_column(Text)


class Notification(Base, TimestampMixin):
    """Persisted notifications for the bell icon."""

    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    startup_id: Mapped[str | None] = mapped_column(ForeignKey("startups.id"))
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(20), default="info")  # info, warning, error
    read: Mapped[bool] = mapped_column(default=False)
