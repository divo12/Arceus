from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Add project root to path (so `uv run python scripts/...` works)
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from packets.service import write_packet_bundle
from packets.types import DecisionItem, SourceItem


def _load_input(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate a versioned packet bundle (packet.md + sources.json)."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to JSON describing packetId, decisions[], sources[].",
    )
    parser.add_argument(
        "--workspace",
        default=str(Path(__file__).resolve().parents[1]),
        help="Workspace root (defaults to repo root).",
    )
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    payload = _load_input(Path(args.input).resolve())

    packet_id = payload.get("packetId") or payload.get("packet_id") or "packet"
    exported_by = payload.get("exportedBy", "")
    export_scope = payload.get("exportScope")
    export_reason = payload.get("exportReason", "")

    decisions = [DecisionItem(**d) for d in payload.get("decisions", [])]
    sources = [SourceItem(**s) for s in payload.get("sources", [])]

    version_dir = write_packet_bundle(
        workspace=workspace,
        packet_id=packet_id,
        decisions=decisions,
        sources=sources,
        exported_by=exported_by,
        export_scope=export_scope,
        export_reason=export_reason,
    )

    print(str(version_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

