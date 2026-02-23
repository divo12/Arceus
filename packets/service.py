from __future__ import annotations

import hashlib
import json
import re
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from observability.events import track_event
from packets.types import DecisionItem, SourceItem, SourcesManifest


_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _safe_id(value: str) -> str:
    value = (value or "").strip()
    value = _SAFE_ID_RE.sub("-", value)
    value = value.strip("-")
    return value or "packet"


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _normalize_uri(uri: str) -> str:
    return (uri or "").strip()


def _fill_source_hashes(
    sources: list[SourceItem],
) -> list[SourceItem]:
    """
    Best-effort hashing.

    If a hash isn't provided, hash the normalized URI so manifests are stable and
    diff-friendly even without fetching remote content.
    """

    out: list[SourceItem] = []
    for s in sources:
        if s.hash:
            out.append(s)
            continue
        uri = _normalize_uri(s.uri)
        out.append(replace(s, hash=_sha256_text(uri)))
    return out


def render_packet_markdown(
    *,
    packet_id: str,
    decisions: list[DecisionItem],
    sources: list[SourceItem],
    packet_version: str,
) -> str:
    exported = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = []
    lines.append(f"# Packet — `{packet_id}`")
    lines.append("")
    lines.append(f"- Exported: **{exported}**")
    lines.append(f"- Version: **{packet_version}**")
    lines.append("")

    lines.append("## Decisions")
    lines.append("")
    if not decisions:
        lines.append("_No decisions included._")
    else:
        for d in decisions:
            decided_at = f" — {d.decidedAt}" if d.decidedAt else ""
            lines.append(f"### {d.title} (`{d.id}`){decided_at}")
            if d.owner:
                lines.append(f"- Owner: {d.owner}")
            if d.evidenceIds:
                lines.append("- Evidence:")
                for eid in d.evidenceIds:
                    lines.append(f"  - `{eid}`")
            lines.append("")

    lines.append("## Sources")
    lines.append("")
    if not sources:
        lines.append("_No sources included._")
    else:
        for s in sources:
            title = s.title or s.uri
            lines.append(f"- **{title}** (`{s.id}`)")
            lines.append(f"  - Type: `{s.type}`")
            lines.append(f"  - URI: {s.uri}")
            if s.scope:
                lines.append(f"  - Scope: {s.scope}")
            if s.hash:
                lines.append(f"  - Hash: `{s.hash[:12]}…`")
            if s.citedInDecisions:
                lines.append(
                    "  - Cited in: " + ", ".join(f"`{x}`" for x in s.citedInDecisions)
                )
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _next_version_dir(packet_root: Path) -> tuple[int, Path]:
    packet_root.mkdir(parents=True, exist_ok=True)
    versions: list[int] = []
    for child in packet_root.iterdir():
        if not child.is_dir():
            continue
        m = re.fullmatch(r"v(\d+)", child.name)
        if m:
            versions.append(int(m.group(1)))
    next_v = (max(versions) + 1) if versions else 1
    return next_v, packet_root / f"v{next_v}"


def write_packet_bundle(
    *,
    workspace: Path,
    packet_id: str,
    decisions: list[DecisionItem],
    sources: list[SourceItem],
    exported_by: str = "",
    export_scope: str | None = None,
    export_reason: str = "",
    output_root: Path | None = None,
) -> Path:
    """
    Create a packet bundle under data/packets/<packetId>/v<N>/.

    Returns the created version directory.
    """

    packet_id = _safe_id(packet_id)
    output_root = output_root or (workspace / "data" / "packets")
    packet_root = output_root / packet_id
    version_number, version_dir = _next_version_dir(packet_root)
    version_dir.mkdir(parents=True, exist_ok=False)

    packet_version = f"v{version_number}"
    sources_hashed = _fill_source_hashes(sources)

    manifest = SourcesManifest(
        packetId=packet_id,
        packetVersion=packet_version,
        exportedBy=exported_by,
        exportScope=export_scope,  # type: ignore[arg-type]
        exportReason=export_reason,
        sources=sources_hashed,
        decisions=decisions,
    )

    packet_md = render_packet_markdown(
        packet_id=packet_id,
        decisions=decisions,
        sources=sources_hashed,
        packet_version=packet_version,
    )

    (version_dir / "packet.md").write_text(packet_md, encoding="utf-8")
    (version_dir / "sources.json").write_text(
        json.dumps(manifest.to_dict(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    (packet_root / "LATEST").write_text(packet_version + "\n", encoding="utf-8")
    (packet_root / "latest.json").write_text(
        json.dumps(
            {
                "packetId": packet_id,
                "packetVersion": packet_version,
                "path": str(version_dir.relative_to(workspace)),
                "updatedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    track_event(
        workspace=workspace,
        name="generate_packet",
        properties={
            "packetId": packet_id,
            "packetVersion": packet_version,
            "decisions": len(decisions),
            "sources": len(sources_hashed),
        },
    )

    return version_dir

