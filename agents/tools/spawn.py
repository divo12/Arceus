"""Spawn tool for PM skill-based validation and focused research tasks."""

from typing import Any, TYPE_CHECKING, Optional

from agents.tools.base import Tool

if TYPE_CHECKING:
    from typing import Protocol

    class SubagentManager(Protocol):
        def spawn(
            self,
            task: str,
            label: Optional[str],
            skill_names: Optional[list[str]],
        ) -> str:
            ...


class SpawnTool(Tool):
    """
    Spawn a subagent to complete a focused PM task (validation, research, skill application).

    The subagent runs synchronously and returns its result directly. Use for:
    - Validating hypotheses with a specific PM framework (e.g. JTBD, PoL)
    - Focused web research
    - Delegating a phase (e.g. validate) to a narrow-scope subagent
    """

    def __init__(self, manager: "SubagentManager"):
        self._manager = manager

    @property
    def name(self) -> str:
        return "spawn"

    @property
    def description(self) -> str:
        return (
            "Spawn a subagent to complete a focused task in the background. Use when you need to: "
            "validate a hypothesis with a PM framework (JTBD, PoL, etc.), "
            "run focused web research, or delegate a validation/research phase. "
            "The subagent runs in the background and its feedback, learnings, and new angles "
            "are integrated into the next iteration. Optionally pass skill_names "
            "to constrain which PM skills the subagent should focus on."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The task for the subagent to complete",
                },
                "label": {
                    "type": "string",
                    "description": "Optional short label for the task (for display)",
                },
                "skill_names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of PM skill names to focus on (e.g. jobs-to-be-done, pol-probe)",
                },
            },
            "required": ["task"],
        }

    async def execute(
        self,
        task: str,
        label: Optional[str] = None,
        skill_names: Optional[list[str]] = None,
        **kwargs: Any,
    ) -> str:
        """Spawn a subagent in the background. Returns immediately with status; results are queued for the main agent."""
        return self._manager.spawn(
            task=task,
            label=label,
            skill_names=skill_names,
        )
