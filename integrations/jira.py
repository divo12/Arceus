from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import httpx


@dataclass(frozen=True)
class JiraAuth:
    base_url: str
    email: str
    api_token: str


def load_jira_auth_from_env() -> Optional[JiraAuth]:
    base_url = (os.getenv("JIRA_BASE_URL") or "").strip().rstrip("/")
    email = (os.getenv("JIRA_EMAIL") or "").strip()
    api_token = (os.getenv("JIRA_API_TOKEN") or "").strip()
    if not base_url or not email or not api_token:
        return None
    return JiraAuth(base_url=base_url, email=email, api_token=api_token)


class JiraClient:
    def __init__(self, auth: JiraAuth, timeout_s: float = 20.0):
        self.auth = auth
        self._client = httpx.Client(timeout=timeout_s, auth=(auth.email, auth.api_token))

    def close(self) -> None:
        self._client.close()

    def add_issue_comment(self, issue_key: str, body: str) -> str:
        """
        Add a comment to a Jira issue.

        Note: Uses Jira Cloud REST API v3. `body` is treated as plain text.
        """

        issue_key = issue_key.strip()
        if not issue_key:
            raise ValueError("issue_key is required")

        url = f"{self.auth.base_url}/rest/api/3/issue/{issue_key}/comment"
        r = self._client.post(url, json={"body": body})
        r.raise_for_status()
        data = r.json()
        return str(data.get("id") or "")


def format_packet_reference_comment(
    *,
    packet_id: str,
    packet_version: str,
    stable_reference: str,
    summary: str = "",
) -> str:
    lines = []
    lines.append("Arceus Packet (publish + reference)")
    lines.append("")
    lines.append(f"- packetId: {packet_id}")
    lines.append(f"- packetVersion: {packet_version}")
    lines.append(f"- reference: {stable_reference}")
    if summary:
        lines.append("")
        lines.append(summary.strip())
    return "\n".join(lines).rstrip()

