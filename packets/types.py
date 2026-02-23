from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Literal, Optional


ExportScope = Literal["team", "org", "legal", "external"]
SourceType = Literal["evidence", "link", "document"]


@dataclass(frozen=True)
class SourceItem:
    id: str
    type: SourceType
    uri: str
    title: str = ""
    scope: str = ""
    hash: str = ""
    citedInDecisions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DecisionItem:
    id: str
    title: str
    decidedAt: str = ""
    owner: str = ""
    evidenceIds: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SourcesManifest:
    """
    sources.json manifest (v1).

    Mirrors docs/schemas/sources_manifest_v1.json.
    """

    version: int = 1
    packetVersion: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    packetId: str = ""
    exportedAt: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    exportedBy: str = ""
    exportScope: Optional[ExportScope] = None
    exportReason: str = ""
    sources: list[SourceItem] = field(default_factory=list)
    decisions: list[DecisionItem] = field(default_factory=list)

    def to_dict(self) -> dict:
        out = asdict(self)
        if out.get("exportScope") is None:
            out.pop("exportScope", None)
        return out

