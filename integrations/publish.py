from __future__ import annotations

import json
from pathlib import Path

from integrations.jira import (
    JiraClient,
    format_packet_reference_comment,
    load_jira_auth_from_env,
)
from observability.events import track_event


def _load_latest(packet_root: Path) -> dict:
    path = packet_root / "latest.json"
    if not path.exists():
        raise FileNotFoundError(f"Packet latest.json not found at {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def publish_packet_reference_to_jira(
    *,
    workspace: Path,
    packet_id: str,
    issue_key: str,
    packet_root: Path | None = None,
) -> str:
    """
    Publish + reference (MVP): add a Jira comment pointing at a stable packet reference.

    Returns the Jira comment ID.
    """

    workspace = Path(workspace).expanduser().resolve()
    packet_root = packet_root or (workspace / "data" / "packets" / packet_id)

    latest = _load_latest(packet_root)
    packet_version = latest.get("packetVersion", "")
    stable_reference = str((packet_root / "latest.json").relative_to(workspace))

    comment = format_packet_reference_comment(
        packet_id=packet_id,
        packet_version=packet_version,
        stable_reference=stable_reference,
    )

    auth = load_jira_auth_from_env()
    if not auth:
        raise RuntimeError(
            "Jira auth not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN."
        )

    client = JiraClient(auth)
    try:
        comment_id = client.add_issue_comment(issue_key=issue_key, body=comment)
    finally:
        client.close()

    track_event(
        workspace=workspace,
        name="publish_packet_reference",
        properties={
            "destination": "jira",
            "issueKey": issue_key,
            "packetId": packet_id,
            "packetVersion": packet_version,
        },
    )

    return comment_id

