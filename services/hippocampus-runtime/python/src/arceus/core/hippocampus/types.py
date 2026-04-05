from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from arceus.core.hippocampus.utils.time import utc_now


class MemoryType(Enum):
    WORKING = "working"
    STATIC = "static"
    DYNAMIC = "dynamic"
    PROCEDURAL = "procedural"
    PRIMING = "priming"


class MemoryAction(Enum):
    ADD = "add"
    UPDATE = "update"
    DELETE = "delete"
    NONE = "none"


class MemoryVisibility(Enum):
    PRIVATE = "private"
    TASK_SCOPED = "task_scoped"
    STARTUP_SHARED = "shared"
    BOARD_VISIBLE = "board"


class PatternStatus(Enum):
    ACTIVE = "active"
    MERGED = "merged"
    PRUNED = "pruned"
    ARCHIVED = "archived"


class HabitFormation(Enum):
    AUTO = "auto"
    EXPLICIT = "explicit"


class ExtractionMode(Enum):
    AGENT = "agent"
    SUB_AGENT = "sub_agent"
    CONVERSATION = "conversation"
    MEETING = "meeting"


@dataclass(frozen=True)
class MemoryUnit:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    company_id: str = ""
    content: str = ""
    embedding: list[float] | None = None
    memory_type: MemoryType = MemoryType.DYNAMIC
    confidence: float = 0.0
    relevance_score: float = 1.0
    container: str = ""
    visibility: MemoryVisibility = MemoryVisibility.PRIVATE
    metadata: dict = field(default_factory=dict)
    source_type: str = ""
    source_id: str = ""
    provenance: str = ""
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)
    expires_at: datetime | None = None
    version: int = 1
    previous_version_id: str | None = None
    promotion_status: str | None = None

    def __post_init__(self) -> None:
        # Auto-extract company_id from container string if not explicitly set.
        # Container format: "company:<UUID>:agent:<UUID>"
        if not self.company_id and self.container.startswith("company:"):
            parts = self.container.split(":")
            if len(parts) >= 2 and len(parts[1]) >= 32:
                object.__setattr__(self, "company_id", parts[1])


def extract_company_id(container: str) -> str:
    """Extract company UUID from container string 'company:<UUID>:agent:<UUID>'."""
    if container.startswith("company:"):
        parts = container.split(":")
        if len(parts) >= 2 and len(parts[1]) >= 32:
            return parts[1]
    return ""


@dataclass(frozen=True)
class ExtractedFact:
    text: str = ""
    memory_type: MemoryType = MemoryType.DYNAMIC
    confidence: float = 0.0
    source_type: str = "remember"
    is_permanent: bool = False
    is_procedural: bool = False
    is_temporal: bool = False
    expires_at: datetime | None = None
    entities: tuple[str, ...] = ()
    relationships: tuple[tuple[str, str, str], ...] = ()


@dataclass(frozen=True)
class Habit:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    trigger_condition: str = ""
    action: str = ""
    confidence: float = 0.0
    usage_count: int = 0
    formed_from_id: str = ""
    formation_mode: HabitFormation = HabitFormation.AUTO
    is_active: bool = True
    created_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True)
class Pattern:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    description: str = ""
    strategy: str = ""
    embedding: list[float] | None = None
    usage_count: int = 0
    success_rate: float = 0.0
    formed_from: tuple[str, ...] = ()
    cluster_id: str | None = None
    status: PatternStatus = PatternStatus.ACTIVE
    domain: str = ""
    created_at: datetime = field(default_factory=utc_now)
    updated_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True)
class TrajectoryStep:
    step_index: int = 0
    action: str = ""
    observation: str = ""
    reward: float = 0.0
    embedding: list[float] | None = None
    timestamp: datetime = field(default_factory=utc_now)


@dataclass(frozen=True)
class Trajectory:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    task_id: str = ""
    steps: tuple[TrajectoryStep, ...] = ()
    outcome: str = ""
    quality: float = 0.0
    created_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True)
class ExtractionResult:
    facts: tuple[ExtractedFact, ...] = ()
    actions: tuple[tuple[MemoryAction, str, str], ...] = ()


@dataclass(frozen=True)
class RetrievalResult:
    memory: MemoryUnit
    relevance: float
    diversity: float


@dataclass(frozen=True)
class TrajectoryVerdict:
    trajectory_id: str = ""
    quality: float = 0.0
    is_successful: bool = False
    strengths: tuple[str, ...] = ()
    weaknesses: tuple[str, ...] = ()
    suggestions: tuple[str, ...] = ()
    confidence: float = 0.0


@dataclass(frozen=True)
class DistilledMemory:
    agent_id: str = ""
    trajectory_id: str = ""
    strategy: str = ""
    container: str = ""
    embedding: list[float] = field(default_factory=list)
    quality: float = 0.0
    learnings: tuple[str, ...] = ()

    def to_memory_unit(self) -> MemoryUnit:
        return MemoryUnit(
            agent_id=self.agent_id,
            content=self.strategy,
            embedding=self.embedding,
            memory_type=MemoryType.DYNAMIC,
            confidence=self.quality,
            container=self.container,
            source_type="distillation",
            source_id=self.trajectory_id,
            provenance=f"Distilled from trajectory {self.trajectory_id}",
        )


@dataclass(frozen=True)
class ConsolidationResult:
    deduped: int = 0
    contradictions_found: int = 0
    contradictions_resolved: int = 0
    pruned: int = 0
    merged: int = 0


@dataclass(frozen=True)
class GCResult:
    expired_removed: int = 0
    decayed_removed: int = 0
    deduped: int = 0
    pruned: int = 0
    merged: int = 0
    patterns_merged: int = 0
    patterns_pruned: int = 0
    promotions_fired: int = 0


@dataclass(frozen=True)
class MemorySummaryProjection:
    agent_id: str = ""
    static_fact_count: int = 0
    dynamic_fact_count: int = 0
    active_habits: list = field(default_factory=list)
    top_patterns: list = field(default_factory=list)
    current_state: dict = field(default_factory=dict)
    recent_learnings: list = field(default_factory=list)
    recent_promotions: list = field(default_factory=list)
    generated_at: datetime = field(default_factory=utc_now)


@dataclass(frozen=True)
class MemoryPromotionEvent:
    agent_id: str = ""
    memory_id: str = ""
    from_type: str = ""
    to_type: str = ""
    reason: str = ""
    status: str = "promoted"
    timestamp: datetime = field(default_factory=utc_now)
