"""Hierarchy model — org chart nodes and edges."""

from sqlalchemy import ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base, TimestampMixin, generate_uuid


class HierarchyNode(Base, TimestampMixin):
    __tablename__ = "hierarchy_nodes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    role: Mapped[str] = mapped_column(String(100))  # CEO, CTO, PM, Developer, etc.
    title: Mapped[str] = mapped_column(String(255))
    level: Mapped[int] = mapped_column(Integer, default=0)  # 0=CEO, 1=Employee, 2=Employee
    parent_node_id: Mapped[str | None] = mapped_column(ForeignKey("hierarchy_nodes.id"))
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id"))
    config: Mapped[dict | None] = mapped_column(JSON)  # LLM-generated config for the role


class HierarchyEdge(Base):
    __tablename__ = "hierarchy_edges"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=generate_uuid)
    startup_id: Mapped[str] = mapped_column(ForeignKey("startups.id"), index=True)
    from_node_id: Mapped[str] = mapped_column(ForeignKey("hierarchy_nodes.id"))
    to_node_id: Mapped[str] = mapped_column(ForeignKey("hierarchy_nodes.id"))
    relationship_type: Mapped[str] = mapped_column(String(50))  # reports_to, delegates_to
