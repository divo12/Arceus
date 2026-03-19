"""Structured deliverable schemas — typed outputs from employee agents.

Every agent produces one of these via PydanticAI result_type.
The LLM is forced to output valid JSON matching the discriminated union.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────────


class DeliverableType(StrEnum):
    TASK_DECOMPOSITION = "task_decomposition"
    TECHNICAL_SPEC = "technical_spec"
    API_DESIGN = "api_design"
    DATA_MODEL = "data_model"
    UI_SPEC = "ui_spec"
    RESEARCH_REPORT = "research_report"


# ── TaskDecomposition ─────────────────────────────────────────────────


class SubTask(BaseModel):
    title: str = Field(description="Short task title")
    description: str = Field(description="What needs to be done")
    assign_to_role: str = Field(description="Role that should own this task, e.g. CTO, PM, Backend Developer")
    priority: str = Field(description="critical / high / medium / low")
    rationale: str = Field(description="Why this task matters and why this role")


class TaskDecomposition(BaseModel):
    type: Literal["task_decomposition"] = "task_decomposition"
    summary: str = Field(description="Brief overview of the decomposition strategy")
    tasks: list[SubTask] = Field(description="Ordered list of sub-tasks")


# ── TechnicalSpec ─────────────────────────────────────────────────────


class ComponentInterface(BaseModel):
    name: str
    description: str
    direction: str = Field(description="inbound / outbound / bidirectional")


class SystemComponent(BaseModel):
    name: str = Field(description="Component name, e.g. AuthService")
    component_type: str = Field(description="microservice / module / library / database / external_api")
    responsibilities: str = Field(description="What this component does")
    interfaces: list[ComponentInterface] = Field(default_factory=list)
    dependencies: list[str] = Field(default_factory=list, description="Names of other components this depends on")


class ArchitectureDecision(BaseModel):
    decision: str = Field(description="What was decided")
    rationale: str = Field(description="Why this approach was chosen")
    alternatives_considered: list[str] = Field(default_factory=list)


class TechnicalSpec(BaseModel):
    type: Literal["technical_spec"] = "technical_spec"
    summary: str = Field(description="High-level architecture overview")
    components: list[SystemComponent] = Field(description="System components")
    architecture_decisions: list[ArchitectureDecision] = Field(default_factory=list)
    tech_stack: list[str] = Field(default_factory=list, description="Technologies chosen")


# ── APIDesign ─────────────────────────────────────────────────────────


class APIEndpoint(BaseModel):
    method: str = Field(description="GET / POST / PUT / PATCH / DELETE")
    path: str = Field(description="URL path, e.g. /api/users/{id}")
    description: str
    request_schema: dict | None = Field(default=None, description="JSON schema for request body")
    response_schema: dict | None = Field(default=None, description="JSON schema for response body")
    auth_required: bool = True


class APIDesign(BaseModel):
    type: Literal["api_design"] = "api_design"
    summary: str = Field(description="API design overview")
    base_url: str = Field(default="/api")
    endpoints: list[APIEndpoint] = Field(description="List of API endpoints")
    auth_strategy: str = Field(default="", description="Authentication approach")


# ── DataModel ─────────────────────────────────────────────────────────


class FieldDef(BaseModel):
    name: str
    field_type: str = Field(description="string / integer / float / boolean / datetime / uuid / json / text")
    nullable: bool = False
    constraints: list[str] = Field(default_factory=list, description="e.g. unique, indexed, default=0")


class RelationshipDef(BaseModel):
    target: str = Field(description="Name of the related model")
    relationship_type: str = Field(description="one_to_one / one_to_many / many_to_many")
    on_delete: str = Field(default="cascade", description="cascade / set_null / restrict")


class ModelDef(BaseModel):
    name: str = Field(description="Model/table name, e.g. User")
    description: str
    fields: list[FieldDef]
    relationships: list[RelationshipDef] = Field(default_factory=list)


class DataModel(BaseModel):
    type: Literal["data_model"] = "data_model"
    summary: str = Field(description="Data model overview")
    models: list[ModelDef] = Field(description="Database models/tables")
    database_type: str = Field(default="postgresql", description="Target database")


# ── UISpec ────────────────────────────────────────────────────────────


class UIComponent(BaseModel):
    name: str
    component_type: str = Field(description="page / form / list / card / modal / nav / chart")
    description: str
    props: dict = Field(default_factory=dict)


class UIInteraction(BaseModel):
    trigger: str = Field(description="What user action triggers this")
    action: str = Field(description="What happens")
    target: str = Field(default="", description="Which component is affected")


class UIScreen(BaseModel):
    name: str = Field(description="Screen name, e.g. Login Page")
    route: str = Field(description="URL route, e.g. /login")
    description: str
    components: list[UIComponent] = Field(default_factory=list)
    interactions: list[UIInteraction] = Field(default_factory=list)


class UISpec(BaseModel):
    type: Literal["ui_spec"] = "ui_spec"
    summary: str = Field(description="UI/UX overview")
    screens: list[UIScreen] = Field(description="Application screens")
    design_system: str = Field(default="", description="UI framework / design system notes")


# ── ResearchReport ────────────────────────────────────────────────────


class Finding(BaseModel):
    topic: str
    summary: str
    sources: list[str] = Field(default_factory=list, description="URLs or references")
    confidence: str = Field(description="high / medium / low")


class ResearchReport(BaseModel):
    type: Literal["research_report"] = "research_report"
    summary: str = Field(description="Research overview")
    findings: list[Finding] = Field(description="Key findings")
    recommendations: list[str] = Field(default_factory=list)


# ── Discriminated Union ───────────────────────────────────────────────


AgentOutput = Annotated[
    TaskDecomposition | TechnicalSpec | APIDesign | DataModel | UISpec | ResearchReport,
    Field(discriminator="type"),
]
