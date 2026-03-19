"""Startup model — the top-level entity."""

from enum import StrEnum

from sqlalchemy import ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, TimestampMixin, generate_uuid


class StartupStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    ARCHIVED = "archived"


class Startup(Base, TimestampMixin):
    __tablename__ = "startups"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default=StartupStatus.ACTIVE)

    # FundamentalIdea (embedded)
    core_idea: Mapped[str] = mapped_column(Text)
    current_direction: Mapped[str] = mapped_column(Text, default="")

    # Budget
    budget_allocated: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    budget_spent: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))

    # Relationships
    members: Mapped[list["StartupMember"]] = relationship(back_populates="startup")
    agents: Mapped[list["Agent"]] = relationship(back_populates="startup")
    tasks: Mapped[list["Task"]] = relationship(back_populates="startup")
    meetings: Mapped[list["Meeting"]] = relationship(back_populates="startup")


class MemberRole(StrEnum):
    OWNER = "owner"
    VIEWER = "viewer"


class StartupMember(Base, TimestampMixin):
    __tablename__ = "startup_members"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(20), default=MemberRole.VIEWER)

    startup: Mapped["Startup"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship(back_populates="startups")
