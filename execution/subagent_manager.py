"""Subagent manager for background task execution.

Spawned agents run in the background. They use tools and PM skills to:
- Give feedback to improve the main agent's response
- Add learnings to known skills
- Suggest a new angle for the main agent to validate and solve

Results are queued for the main agent to consume between iterations.
"""

import asyncio
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from loguru import logger

from agents.agent import Agent
from agents.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from agents.tools.registry import ToolRegistry
from agents.tools.shell import ExecTool
from agents.tools.support_query import SupportQueryTool
from agents.tools.web import SearXSearchTool, WebFetchTool, WebSearchTool

if TYPE_CHECKING:
    from config import Config
    from providers.adapter import ProviderAdapter


class SubagentManager:
    """
    Manages background subagent execution.

    Subagents run in the background (asyncio.create_task). When they complete,
    results (feedback, learnings, new_angle) are pushed to a queue for the main
    agent to consume. Subagents cannot spawn other agents or use the spawn tool.
    """

    def __init__(
        self,
        provider: "ProviderAdapter",
        workspace: Path,
        config: "Config",
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_iterations: int = 15,
    ):
        self.provider = provider
        self.workspace = Path(workspace).expanduser().resolve()
        self.config = config
        self.model = model
        self.temperature = temperature
        self.max_iterations = max_iterations
        self._running_tasks: Dict[str, asyncio.Task[None]] = {}
        self._completed_results: List[Dict[str, Any]] = []

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

    def spawn(
        self,
        task: str,
        label: Optional[str] = None,
        skill_names: Optional[List[str]] = None,
    ) -> str:
        """
        Spawn a subagent to execute a task in the background.

        Returns immediately with a status message. Results are queued for
        the main agent to consume via get_completed_results().
        """
        task_id = str(uuid.uuid4())[:8]
        display_label = label or (task[:40] + "..." if len(task) > 40 else task)

        bg_task = asyncio.create_task(
            self._run_subagent(task_id, task, display_label, skill_names)
        )
        self._running_tasks[task_id] = bg_task
        bg_task.add_done_callback(lambda _: self._running_tasks.pop(task_id, None))

        logger.info("Spawned subagent [%s]: %s", task_id, display_label)
        return f"Subagent [{display_label}] started (id: {task_id}). I'll integrate results when ready."

    async def _run_subagent(
        self,
        task_id: str,
        task: str,
        label: str,
        skill_names: Optional[List[str]],
    ) -> None:
        """Execute the subagent task and push result to completed queue."""
        logger.info("Subagent [%s] starting: %s", task_id, label)

        try:
            tools = self._build_subagent_registry()
            agent = Agent(workspace=self.workspace, skill_names=skill_names)
            result = await agent.run(
                task=task,
                tools=tools,
                provider=self.provider,
                max_iterations=self.max_iterations,
            )

            completed = {
                "task_id": task_id,
                "label": label,
                "task": task,
                "feedback": result.get("feedback", ""),
                "learnings": result.get("learnings", ""),
                "new_angle": result.get("new_angle", ""),
                "summary": result.get("summary", ""),
                "raw": result.get("raw", ""),
                "status": "ok",
            }
            self._completed_results.append(completed)
            logger.info("Subagent [%s] completed successfully", task_id)

        except Exception as e:
            error_msg = str(e)
            logger.error("Subagent [%s] failed: %s", task_id, e)
            self._completed_results.append({
                "task_id": task_id,
                "label": label,
                "task": task,
                "feedback": f"Error: {error_msg}",
                "learnings": "",
                "new_angle": "",
                "summary": f"Subagent failed: {error_msg}",
                "raw": "",
                "status": "error",
            })

    def get_completed_results(self) -> List[Dict[str, Any]]:
        """
        Pop and return all completed subagent results.

        Main agent calls this at the start of each iteration to integrate
        feedback, learnings, and new angles.
        """
        results = self._completed_results.copy()
        self._completed_results.clear()
        return results

    def get_running_count(self) -> int:
        """Return the number of currently running subagents."""
        return len(self._running_tasks)
