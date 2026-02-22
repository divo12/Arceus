"""Subagent manager for PM skill-based validation and focused research tasks.

Adapted from nanobot's subagent pattern. Runs synchronously (no MessageBus);
result is returned directly as tool output.
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from loguru import logger

from agents.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from agents.tools.registry import ToolRegistry
from agents.tools.shell import ExecTool
from agents.tools.support_query import SupportQueryTool
from agents.tools.web import SearXSearchTool, WebFetchTool, WebSearchTool

if TYPE_CHECKING:
    from config import Config
    from providers.adapter import ProviderAdapter


def _build_subagent_prompt(task: str, skill_names: Optional[List[str]] = None) -> str:
    """Build a focused system prompt for the subagent."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M (%A) UTC")
    skill_hint = ""
    if skill_names:
        skill_hint = f"\nFocus on these skills: {', '.join(skill_names)}. Read their SKILL.md files as needed."
    return f"""# PM Subagent

## Current Time
{now}

You are a PM subagent spawned by the main agent to complete a specific task.

## Task
{task}
{skill_hint}

## Rules
1. Stay focused - complete only the assigned task, nothing else
2. Your final response will be returned to the main agent
3. Do not initiate side tasks or broad explorations
4. Be concise but informative in your findings
5. Use web_search, searx_search, or web_fetch to validate claims when needed

## What You Can Do
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages
- Query the support agent for workspace context

## What You Cannot Do
- Spawn other subagents
- Schedule cron jobs

## Workspace
Workspace: {{workspace}}
Skills at: {{workspace}}/skills/ (read SKILL.md as needed)

When done, provide a clear summary of your findings or actions."""


class SubagentManager:
    """
    Manages synchronous subagent execution for PM validation and research tasks.

    Subagents run with a focused prompt and limited tools (no spawn, no cron).
    Result is returned directly to the caller.
    """

    def __init__(
        self,
        provider: "ProviderAdapter",
        workspace: Path,
        config: "Config",
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_iterations: int = 10,
    ):
        self.provider = provider
        self.workspace = Path(workspace).expanduser().resolve()
        self.config = config
        self.model = model
        self.temperature = temperature
        self.max_iterations = max_iterations

    def _build_subagent_registry(self) -> ToolRegistry:
        """Build tool registry for subagent (no spawn, no cron)."""
        registry = ToolRegistry()
        allowed_dir = self.workspace
        restrict = self.config.tools.restrict_to_workspace

        registry.register(ReadFileTool(allowed_dir))
        registry.register(WriteFileTool(allowed_dir))
        registry.register(EditFileTool(allowed_dir))
        registry.register(ListDirTool(allowed_dir))
        registry.register(
            ExecTool(
                working_dir=str(self.workspace),
                restrict_to_workspace=restrict,
                timeout=self.config.tools.exec.timeout,
            )
        )
        web_key = self.config.get_web_search_api_key()
        registry.register(
            WebSearchTool(api_key=web_key or None, max_results=self.config.tools.web.max_results)
        )
        registry.register(SearXSearchTool(max_results=self.config.tools.web.max_results))
        registry.register(WebFetchTool())
        registry.register(SupportQueryTool(self.workspace))
        return registry

    async def spawn(
        self,
        task: str,
        label: Optional[str] = None,
        skill_names: Optional[List[str]] = None,
    ) -> str:
        """
        Run a subagent to complete the task synchronously. Returns the final result.

        Args:
            task: The task description for the subagent.
            label: Optional short label (for logging).
            skill_names: Optional list of PM skills to focus on.

        Returns:
            The subagent's final response string.
        """
        display_label = label or (task[:40] + "..." if len(task) > 40 else task)
        logger.info("Subagent starting: %s", display_label)

        try:
            tools = self._build_subagent_registry()
            system_prompt = _build_subagent_prompt(task, skill_names).replace(
                "{workspace}", str(self.workspace)
            )

            messages: List[Dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task},
            ]

            final_result: Optional[str] = None
            for iteration in range(1, self.max_iterations + 1):
                runtime_ctx: Dict[str, Any] = {
                    "problem": task,
                    "iteration": iteration,
                }
                response = await self.provider.complete(
                    messages=messages,
                    tool_schemas=tools.get_definitions(),
                    iteration=iteration,
                    runtime_context=runtime_ctx,
                )

                if response.tool_calls:
                    from providers.adapter import ToolCall

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

            logger.info("Subagent completed: %s", display_label)
            return final_result

        except Exception as e:
            logger.error("Subagent failed: %s", e)
            return f"Error: {str(e)}"
