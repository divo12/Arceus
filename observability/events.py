from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


def track_event(
    *,
    workspace: Path,
    name: str,
    properties: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Minimal structured telemetry stored locally as JSONL.

    This avoids committing to an external analytics backend while still enabling
    funnels (e.g., generate_packet -> open_packet -> forward_packet).
    """

    workspace = Path(workspace).expanduser().resolve()
    events_dir = workspace / ".arceus" / "events"
    events_dir.mkdir(parents=True, exist_ok=True)
    path = events_dir / "events.jsonl"

    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "name": name,
        "properties": properties or {},
    }
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")

