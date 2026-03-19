"""Meeting model — standups, escalations, syncs."""

from enum import StrEnum

from sqlalchemy import ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, generate_uuid


class MeetingType(StrEnum):
    STANDUP = "standup"
    SPEC_REVIEW = "spec_review"
    ESCALATION = "escalation"
    SPRINT_PLANNING = "sprint_planning"


class MeetingStatus(StrEnum):
    SCHEDULED = "scheduled"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class Meeting(Base, TimestampMixin):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    meeting_type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default=MeetingStatus.SCHEDULED)

    # Participants (agent IDs)
    participant_ids: Mapped[list | None] = mapped_column(JSON)

    # Agenda and results
    agenda: Mapped[dict | None] = mapped_column(JSON)
    decisions: Mapped[list | None] = mapped_column(JSON)
    learnings: Mapped[list | None] = mapped_column(JSON)
    raw_transcript: Mapped[str | None] = mapped_column(Text)

    # Relationships
    startup: Mapped["Startup"] = relationship(back_populates="meetings")
