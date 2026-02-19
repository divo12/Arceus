"""Controller entrypoint for running the PM agent loop."""

from pathlib import Path
from typing import Any, Dict, Optional

from execution.agent_loop import AgentLoop


class Controller:
    """Thin orchestration layer over AgentLoop."""

    def __init__(self, workspace: Path):
        self.loop = AgentLoop(workspace)

    def run_problem(
        self, problem_description: str, context: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        return self.loop.run_sync(problem_description=problem_description, context=context)
