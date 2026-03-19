"""Ticket model — immutable activity stream."""

from sqlalchemy import ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, generate_uuid


class Ticket(Base, TimestampMixin):
    __tablename__ = "tickets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    ticket_type: Mapped[str] = mapped_column(String(50))  # task_completed, tool_call, meeting, approval, decision
    title: Mapped[str] = mapped_column(String(500))
    content: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict | None] = mapped_column("metadata", JSON)
