"""Agent class for spawned subagents.

Used by the master agent (AgentLoop) via SubagentManager. Each spawned agent:
- Uses tools and PM skills to complete a focused task
- Produces feedback to improve the main agent's response
- Adds learnings to known skills
- Suggests a new angle on the problem for the main agent to consider

Spawned agents run in the background and cannot spawn other agents or use the spawn tool.
"""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from agents.context_builder import ContextBuilder
from agents.skills import SkillsLoader
from providers.adapter import ProviderAdapter, ToolCall


def _build_subagent_system_prompt(task: str, workspace: Path, skill_names: Optional[List[str]] = None) -> str:
    """Build focused system prompt for a spawned subagent."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M (%A) UTC")
    ws = str(workspace.expanduser().resolve())
    skill_hint = ""
    if skill_names:
        skill_hint = f"\n\nFocus on these skills: {', '.join(skill_names)}. Read their SKILL.md files as needed."

    return f"""# PM Subagent

## Current Time
{now}

You are a PM subagent spawned by the main agent to complete a specific task. Your output will be used to:
1. Give feedback to improve the main agent's approach
2. Add learnings to our skills/knowledge base
3. Suggest a new angle on the problem for the main agent to consider solving

## Task
{task}
{skill_hint}

## Rules
1. Stay focused - complete only the assigned task
2. Use tools (read_file, web_search, searx_search, web_fetch, exec) and skills as needed
3. Do not spawn other subagents or schedule cron jobs
4. Be concise but informative
5. Every response must include a NEW ANGLE - a different perspective or sub-problem the main agent should consider

## What You Can Do
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages
- Query the support agent for workspace context
- Read SKILL.md files to apply PM frameworks

## What You Cannot Do
- Spawn other subagents
- Schedule cron jobs
- Dictate or override the main agent

## Workspace
{ws}
Skills at: {ws}/skills/

## Output Format (REQUIRED)

When done, structure your response with these sections:

## Feedback
[Your feedback to improve the main agent's approach or response]

## Learnings
[What to add to our skills or knowledge base - actionable insights]

## New Angle
[A new problem, perspective, or sub-problem the main agent should validate and consider solving]

## Summary
[Brief summary of what you did and found]
"""


def _parse_subagent_output(content: str) -> Dict[str, str]:
    """Parse structured output from subagent into feedback, learnings, new_angle."""
    result = {"feedback": "", "learnings": "", "new_angle": "", "summary": "", "raw": content or ""}
    if not content or not content.strip():
        return result

    section_pattern = re.compile(
        r"##\s*(Feedback|Learnings|New Angle|Summary)\s*\n(.*?)(?=##\s|\Z)",
        re.DOTALL | re.IGNORECASE,
    )
    for m in section_pattern.finditer(content):
        name = m.group(1).strip().lower().replace(" ", "_")
        if name == "new_angle":
            name = "new_angle"
        elif name == "learnings":
            name = "learnings"
        elif name == "feedback":
            name = "feedback"
        elif name == "summary":
            name = "summary"
        value = m.group(2).strip()
        if name in result:
            result[name] = value

    if not result["feedback"] and not result["learnings"] and not result["new_angle"]:
        result["feedback"] = content[:2000]
        result["summary"] = content[:500]

    return result


class Agent:
    """
    Agent instance for spawned subagents.

    Created by the master agent via SubagentManager. Runs a focused task using
    tools and skills, produces feedback, learnings, and a new angle for the main agent.
    """

    def __init__(self, workspace: Path, skill_names: Optional[List[str]] = None):
        self.workspace = Path(workspace).expanduser().resolve()
        self.skill_names = skill_names or []
        self.skills = SkillsLoader(self.workspace)
        self.context_builder = ContextBuilder(self.workspace)

    def get_available_skills(self) -> List[Dict[str, str]]:
        """Get list of available skills (for subagent context)."""
        return self.skills.list_skills(filter_unavailable=False)

    def build_messages(self, task: str) -> List[Dict[str, Any]]:
        """Build initial messages for subagent run."""
        system_prompt = _build_subagent_system_prompt(
            task=task,
            workspace=self.workspace,
            skill_names=self.skill_names or None,
        )
        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": task},
        ]

    async def run(
        self,
        task: str,
        tools: Any,
        provider: ProviderAdapter,
        max_iterations: int = 15,
    ) -> Dict[str, Any]:
        """
        Run the subagent loop. Returns structured result with feedback, learnings, new_angle.

        Similar to main agent loop but: no spawn tool, no cron, focused prompt.
        """
        messages = self.build_messages(task)
        final_result: Optional[str] = None

        for iteration in range(1, max_iterations + 1):
            runtime_ctx: Dict[str, Any] = {"problem": task, "iteration": iteration}
            response = await provider.complete(
                messages=messages,
                tool_schemas=tools.get_definitions(),
                iteration=iteration,
                runtime_context=runtime_ctx,
            )

            if response.tool_calls:
                tool_call_dicts = [
                    {
                        "id": tc.call_id,
                        "type": "function",
                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
                    }
                    for tc in response.tool_calls
                    if isinstance(tc, ToolCall)
                ]
                messages.append({
                    "role": "assistant",
                    "content": response.content or "",
                    "tool_calls": tool_call_dicts,
                })
                for call in response.tool_calls:
                    if not isinstance(call, ToolCall):
                        continue
                    result = await tools.execute(call.name, call.arguments)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call.call_id,
                        "name": call.name,
                        "content": result,
                    })
            else:
                final_result = response.content or ""
                break

        if final_result is None:
            final_result = "Task completed but no final response was generated."

        parsed = _parse_subagent_output(final_result)
        return {
            "feedback": parsed["feedback"],
            "learnings": parsed["learnings"],
            "new_angle": parsed["new_angle"],
            "summary": parsed["summary"],
            "raw": parsed["raw"],
        }
