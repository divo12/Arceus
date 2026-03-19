"""Deliverable model — structured outputs from employee agents."""

from sqlalchemy import ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, generate_uuid


class Deliverable(Base, TimestampMixin):
    __tablename__ = "deliverables"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)

    # Type discriminator: task_decomposition, technical_spec, api_design, etc.
    deliverable_type: Mapped[str] = mapped_column(String(50))

    # The full structured JSON content (matches Pydantic schema)
    content: Mapped[dict] = mapped_column(JSON)

    # Status: draft → in_review → approved → rejected
    status: Mapped[str] = mapped_column(String(20), default="draft")

    # Optional reviewer (PM or manager who approved/rejected)
    reviewed_by_agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    review_feedback: Mapped[str | None] = mapped_column(Text)

    # Relationships
    task: Mapped["Task"] = relationship(back_populates="deliverables")
    agent: Mapped["Agent"] = relationship(foreign_keys=[agent_id])
    reviewer: Mapped["Agent | None"] = relationship(foreign_keys=[reviewed_by_agent_id])
