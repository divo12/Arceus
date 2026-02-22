"""PM Ideas service: surf the web for ideas and create a todo list."""

import asyncio
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from datetime import datetime, timezone

if TYPE_CHECKING:
    from execution.agent_loop import AgentLoop

IDEAS_PROMPT = """PM Ideas Sweep: Search the web for product ideas, trends, and what-to-build-next.

This project: Given a Problem, the agent uses PM knowledge and skills to solve it and tell what to build next.

**Your skills:**
- **Spawn subagent**: Use spawn to delegate focused validation (e.g. JTBD framework, PoL) or research. Pass skill_names to constrain (e.g. ["jobs-to-be-done"]). Result returns directly for you to integrate.
- **Web Search MCP** (if available): Use mcp_web_search_full-web-search, mcp_web_search_get-web-search-summaries, mcp_web_search_get-single-web-page-content for rich web research. Prefer these when present.
- **Open skills** (skills/open_skills/): Use web_search, searx_search (free SearXNG fallback), web_fetch. If web_search returns 422 or "not configured", use searx_search instead.
- **Support agent**: Call query_support_agent when you need "where to learn more" or "what's missing in our workspace skills" or "what tools could help our PM". The support agent has workspace PM skills context and will point you to relevant skills and gaps.

**Search for:**
- Product ideas for AI PM agents
- Trends in product management tools
- What to build next (product discovery, prioritization, roadmapping)
- Features that would improve problem-to-build workflows

**Then create PM_IDEAS.md** with:
1. Gaps: What's not in our workspace_skills that we should add
2. Tools: What tools we could implement to help the PM agent
3. Learning: Where to learn more (from support agent)
4. Todo list: Actionable items with checkboxes (- [ ])

Format: markdown with header and date. Use write_file to save PM_IDEAS.md.
"""


def run_ideas_sweep_with_loop(
    workspace: Path,
    loop: "AgentLoop",
    max_iterations: int = 12,
) -> str:
    """
    Run PM Ideas sweep with main+support agent architecture.
    Main agent: Open skills only. Support agent (query_support_agent tool): workspace PM skills.
    """
    result = loop.run_sync(
        problem_description=IDEAS_PROMPT,
        max_iterations=max_iterations,
        session_key="pm_ideas:sweep",
        skill_sources=["essential", "open"],
    )
    content = result.get("final", {}).get("content", "No response")

    # Fallback: write response if agent didn't write PM_IDEAS.md
    ideas_path = workspace / "PM_IDEAS.md"
    if not ideas_path.exists() or ideas_path.stat().st_size == 0:
        header = f"# PM Ideas — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n"
        ideas_path.write_text(header + content, encoding="utf-8")

    # Create PR if PM_IDEAS.md was updated and gh is available
    _maybe_create_pr(workspace, ideas_path)

    return content


def _maybe_create_pr(workspace: Path, ideas_path: Path) -> None:
    """If PM_IDEAS.md has new content, commit, push, and optionally create PR (when PM_IDEAS_CREATE_PR=1)."""
    import os
    if not ideas_path.exists() or ideas_path.stat().st_size < 50:
        return
    if not os.environ.get("PM_IDEAS_CREATE_PR", "").strip() in ("1", "true", "yes"):
        return

    # Check if there are uncommitted changes
    r = subprocess.run(
        ["git", "status", "--porcelain", str(ideas_path)],
        capture_output=True,
        text=True,
        cwd=str(workspace),
    )
    if not r.stdout.strip():
        return

    subprocess.run(
        ["git", "add", str(ideas_path)],
        check=True,
        cwd=str(workspace),
    )
    msg = f"chore: update PM_IDEAS.md — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"
    subprocess.run(
        ["git", "commit", "-m", msg],
        capture_output=True,
        cwd=str(workspace),
    )
    subprocess.run(
        ["git", "push"],
        capture_output=True,
        cwd=str(workspace),
    )
    subprocess.run(
        ["gh", "pr", "create", "--fill", "--title", msg],
        capture_output=True,
        cwd=str(workspace),
    )


def run_ideas_sweep(workspace: Path) -> str:
    """
    Run the PM ideas sweep: main agent (Open skills) + support agent (workspace PM skills).
    Agent surfs the web, queries support for learning gaps, creates PM_IDEAS.md.
    """
    from execution.controller import Controller

    ctrl = Controller(workspace)
    return ctrl.run_ideas_sweep(max_iterations=12)


async def run_ideas_sweep_async(workspace: Path) -> str:
    """Async wrapper for run_ideas_sweep."""
    return await asyncio.to_thread(run_ideas_sweep, workspace)
