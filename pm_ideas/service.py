"""PM Ideas service: surf the web for ideas and create a todo list."""

import asyncio
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from datetime import datetime, timezone

if TYPE_CHECKING:
    from execution.agent_loop import AgentLoop

# High-level repo overview for agent context (Cursor-for-PMs problem)
REPO_OVERVIEW = """
## Arceus: High-Level Overview (for agent context)

**What Arceus is:** An iterative PM agent that, given a problem, thinks about what to build, gathers feedback (tools, web, subagents), and refines its plan. It is essentially "Cursor for product managers" — a tool that tells what to build next.

**Core flow:** Problem → Evidence → Options → Decision → Plan

**Architecture:**
- **ReACT-style loop:** context → cognition → provider → tools → feedback → iterate
- **PM cognition:** interpret → reason → plan → decide → reflect (with web evidence and subagent results)
- **Three-tier skills:** Essential (survival), Workspace (PM), Open (tool-level)
- **Subagents:** Main agent can spawn focused subagents via `spawn` tool (validation, research); feedback/learnings/new_angle are integrated each iteration
- **Gateway:** Heartbeat (HEARTBEAT.md tasks) + Cron (.arceus/cron.json) for 24/7 operation

**Key dirs:** agents/ (identity, context, skills, tools), cognition/ (plan/decide/reflect), execution/ (agent_loop, controller, subagent_manager), skills/ (essential, workspace_skills, open_skills), pm_ideas/ (ideas sweep → PM_IDEAS.md / new_ideas.md)
"""

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

NEW_IDEAS_PROMPT = f"""**Problem:** This project is designing Cursor for product managers — a tool that tells what to build next.

{REPO_OVERVIEW}

**Your task:** Explore what to build next for Arceus. Spawn multiple subagents to validate ideas (JTBD, PoL, prioritization), research trends, and surface gaps. Integrate their feedback, learnings, and new angles into your thinking.

**Your skills:**
- **Spawn subagent:** Use spawn to delegate focused validation (e.g. jobs-to-be-done, prioritization-advisor) or research. Pass skill_names to constrain. Result returns directly for you to integrate.
- **Web Search MCP** (if available): mcp_web_search_full-web-search, mcp_web_search_get-web-search-summaries, mcp_web_search_get-single-web-page-content.
- **Open skills:** web_search, searx_search, web_fetch. Use searx_search if web_search returns 422.
- **Support agent:** query_support_agent for "what's missing in workspace skills" or "what tools could help our PM".

**Search for:**
- Product ideas for AI PM agents (Cursor-for-PMs angle)
- What to build next for problem-to-build workflows
- Features that would improve PM agent tooling

**Output:** Create new_ideas.md with:
1. New ideas surfaced (from you + subagents)
2. Gaps in workspace_skills to add
3. Tools/capabilities to implement
4. Actionable todo list with checkboxes (- [ ])

Format: markdown with header and date. Use write_file to save new_ideas.md.
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


def run_new_ideas_sweep_with_loop(
    workspace: Path,
    loop: "AgentLoop",
    max_iterations: int = 12,
) -> str:
    """
    Run new ideas sweep: Cursor-for-PMs problem, repo context, spawn subagents, output to new_ideas.md.
    """
    result = loop.run_sync(
        problem_description=NEW_IDEAS_PROMPT,
        max_iterations=max_iterations,
        session_key="new_ideas:sweep",
        skill_sources=["essential", "open"],
    )
    content = result.get("final", {}).get("content", "No response")

    ideas_path = workspace / "new_ideas.md"
    if not ideas_path.exists() or ideas_path.stat().st_size == 0:
        header = f"# New Ideas — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}\n\n"
        ideas_path.write_text(header + content, encoding="utf-8")

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


def run_ideas_sweep(workspace: Path, max_iterations: int = 12) -> str:
    """
    Run the PM ideas sweep: main agent (Open skills) + support agent (workspace PM skills).
    Agent surfs the web, queries support for learning gaps, creates PM_IDEAS.md.
    """
    from execution.controller import Controller

    ctrl = Controller(workspace)
    return run_ideas_sweep_with_loop(workspace, ctrl.loop, max_iterations=max_iterations)


def run_new_ideas_sweep(workspace: Path, max_iterations: int = 12) -> str:
    """
    Run new ideas sweep: Cursor-for-PMs problem, repo context, spawn subagents, output to new_ideas.md.
    """
    from execution.controller import Controller

    ctrl = Controller(workspace)
    return run_new_ideas_sweep_with_loop(workspace, ctrl.loop, max_iterations=max_iterations)


async def run_ideas_sweep_async(workspace: Path) -> str:
    """Async wrapper for run_ideas_sweep."""
    return await asyncio.to_thread(run_ideas_sweep, workspace)


async def run_new_ideas_sweep_async(workspace: Path) -> str:
    """Async wrapper for run_new_ideas_sweep."""
    return await asyncio.to_thread(run_new_ideas_sweep, workspace)
