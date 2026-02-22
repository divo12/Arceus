"""Support query tool: query workspace PM skills context."""

from pathlib import Path
from typing import Any

from agents.skills import SkillsLoader
from agents.tools.base import Tool


class SupportQueryTool(Tool):
    """
    Query workspace PM skills for context: where to learn more, what's missing,
    what tools could help the PM. Uses workspace_skills and skill summaries.
    """

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace).expanduser().resolve()
        self.skills = SkillsLoader(self.workspace)

    @property
    def name(self) -> str:
        return "query_support_agent"

    @property
    def description(self) -> str:
        return (
            "Query the support agent for workspace PM skills context. Use when you need: "
            "where to learn more about a topic, what's missing in our workspace skills, "
            "or what tools could help our PM. Returns relevant skill names and paths."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The question or topic to look up (e.g. 'prioritization', 'user research', 'what skills are missing')",
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str, **kwargs: Any) -> str:
        all_skills = self.skills.list_skills(filter_unavailable=False)
        workspace_skills = [s for s in all_skills if s["source"] == "workspace"]
        q_lower = (query or "").lower()

        matches: list[dict[str, str]] = []
        for s in workspace_skills:
            name = s.get("name", "")
            if q_lower in name.lower():
                matches.append(s)
            elif q_lower in s.get("path", "").lower():
                matches.append(s)

        if not matches:
            matches = workspace_skills[:8]

        lines = [f"- {m['name']}: {m.get('path', '')}" for m in matches]
        summary = (
            f"Workspace PM skills ({len(workspace_skills)} total). "
            f"Query: '{query}'. Relevant: {len(matches)} skills.\n\n" + "\n".join(lines)
        )
        return summary
