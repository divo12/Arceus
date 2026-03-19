"""Budget model — cost tracking per LLM call."""

from sqlalchemy import ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, generate_uuid


class CostEntry(Base, TimestampMixin):
    __tablename__ = "cost_entries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id"))
    model: Mapped[str] = mapped_column(String(100))
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cost: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
