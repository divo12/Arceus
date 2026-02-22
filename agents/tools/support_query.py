"""Support query tool: LLM-powered analysis of problems/skills with research context.

Subagents use this to find learnings in skills, discover new angles, and suggest
improvements. Only available to subagents, not the main agent loop.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from agents.skills import SkillsLoader
from agents.tools.base import Tool

if TYPE_CHECKING:
    from providers.adapter import ProviderAdapter


def _append_skill_learning(workspace: Path, skill_name: str, learning: str) -> None:
    """Append a learning to a skill's references/Learnings.md. Does not modify SKILL.md."""
    skills_loader = SkillsLoader(workspace)
    all_skills = skills_loader.list_skills(filter_unavailable=False)
    skill_path = None
    for s in all_skills:
        if s.get("name") == skill_name:
            skill_path = Path(s.get("path", "")).parent
            break
    if not skill_path or not skill_path.exists():
        return
    ref_dir = skill_path / "references"
    ref_dir.mkdir(parents=True, exist_ok=True)
    learnings_file = ref_dir / "Learnings.md"
    header = f"\n\n---\n\n## Learning ({datetime.now(timezone.utc).strftime('%Y-%m-%d')})\n\n"
    content = header + learning.strip() + "\n"
    if learnings_file.exists():
        learnings_file.write_text(learnings_file.read_text(encoding="utf-8") + content, encoding="utf-8")
    else:
        learnings_file.write_text(
            f"# Learnings for {skill_name}\n\nImprovements and insights discovered during agent runs.\n{content}",
            encoding="utf-8",
        )


class SupportQueryTool(Tool):
    """
    LLM-powered query for workspace PM skills and problems.

    Given a problem/skill and research context from the subagent, suggests:
    - New angles to the problem
    - How the problem could be structured
    - For skills: gaps, improvements, learnings
    """

    def __init__(
        self,
        workspace: Path,
        provider: Optional["ProviderAdapter"] = None,
    ):
        self.workspace = Path(workspace).expanduser().resolve()
        self.skills = SkillsLoader(self.workspace)
        self.provider = provider

    @property
    def name(self) -> str:
        return "query_support_agent"

    @property
    def description(self) -> str:
        return (
            "Query the support agent for workspace PM skills context. Use when you need: "
            "where to learn more about a topic, what's missing in our workspace skills, "
            "new angles to a problem, how to structure a problem, or improvements/learnings for a skill. "
            "Provide problem_or_skill and research_context when available for LLM-powered analysis."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The question or topic to look up (e.g. 'prioritization', 'user research')",
                },
                "problem_or_skill": {
                    "type": "string",
                    "description": "The problem statement or skill name being analyzed",
                },
                "research_context": {
                    "type": "string",
                    "description": "Context from your research (web search, etc.) to inform the analysis",
                },
            },
            "required": ["query"],
        }

    async def _llm_analyze(
        self,
        query: str,
        problem_or_skill: Optional[str] = None,
        research_context: Optional[str] = None,
    ) -> str:
        """Use LLM to produce structured analysis."""
        all_skills = self.skills.list_skills(filter_unavailable=False)
        workspace_skills = [s for s in all_skills if s["source"] == "workspace"]
        skill_list = "\n".join(f"- {s['name']}: {s.get('path', '')}" for s in workspace_skills[:20])

        problem_section = ""
        if problem_or_skill:
            problem_section = f"""
## Problem or Skill Being Analyzed
{problem_or_skill}
"""
        research_section = ""
        if research_context:
            research_section = f"""
## Research Context (from subagent)
{research_context[:3000]}
"""

        system = f"""You are a PM support analyst. Given a query, problem/skill, and optional research context, produce a structured analysis.

## Available Workspace Skills
{skill_list}
{problem_section}
{research_section}

Respond with these sections (use ## headers):

## New Angles
[Different perspectives or sub-problems to consider]

## Problem Structure
[How this problem could be framed or decomposed]

## Gaps and Improvements
[If analyzing a skill: what's missing, what could be improved. If analyzing a problem: capability gaps.]

## Learnings
[Actionable insights to add to skills or apply to the problem]
"""

        user = f"Query: {query}"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        try:
            response = await self.provider.complete(
                messages=messages,
                tool_schemas=[],
                iteration=1,
                runtime_context={"problem": query},
            )
            return response.content or ""
        except Exception as e:
            return f"LLM analysis failed: {e}. Falling back to skill search."

    async def execute(
        self,
        query: str,
        problem_or_skill: Optional[str] = None,
        research_context: Optional[str] = None,
        **kwargs: Any,
    ) -> str:
        all_skills = self.skills.list_skills(filter_unavailable=False)
        workspace_skills = [s for s in all_skills if s["source"] == "workspace"]
        q_lower = (query or "").lower()

        matches: list[dict[str, str]] = []
        for s in workspace_skills:
            name = s.get("name", "")
            if q_lower in name.lower() or q_lower in s.get("path", "").lower():
                matches.append(s)
        if not matches:
            matches = workspace_skills[:8]

        if self.provider and (problem_or_skill or research_context):
            analysis = await self._llm_analyze(
                query=query,
                problem_or_skill=problem_or_skill,
                research_context=research_context,
            )
            lines = [f"- {m['name']}: {m.get('path', '')}" for m in matches]
            skill_ref = "Relevant skills:\n" + "\n".join(lines)
            result = f"{analysis}\n\n---\n\n{skill_ref}"

            if problem_or_skill and "## Learnings" in analysis:
                try:
                    learnings_section = analysis.split("## Learnings")[1].split("##")[0].strip()
                    if learnings_section and len(learnings_section) > 20:
                        pob = (problem_or_skill or "").strip().lower()
                        for m in matches:
                            if m["name"].lower() == pob or pob in m["name"].lower():
                                _append_skill_learning(self.workspace, m["name"], learnings_section[:2000])
                                break
                except Exception:
                    pass
            return result

        lines = [f"- {m['name']}: {m.get('path', '')}" for m in matches]
        return (
            f"Workspace PM skills ({len(workspace_skills)} total). "
            f"Query: '{query}'. Relevant: {len(matches)} skills.\n\n" + "\n".join(lines)
        )
