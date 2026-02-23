from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Add project root to path (so `uv run python scripts/...` works)
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from integrations.publish import publish_packet_reference_to_jira


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish packet reference to Jira (comment on issue)."
    )
    parser.add_argument("--packet-id", required=True, help="Packet ID (folder name).")
    parser.add_argument("--issue-key", required=True, help="Jira issue key (e.g., PROJ-123).")
    parser.add_argument(
        "--workspace",
        default=str(Path(__file__).resolve().parents[1]),
        help="Workspace root (defaults to repo root).",
    )
    args = parser.parse_args()

    comment_id = publish_packet_reference_to_jira(
        workspace=Path(args.workspace),
        packet_id=args.packet_id,
        issue_key=args.issue_key,
    )
    print(comment_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

