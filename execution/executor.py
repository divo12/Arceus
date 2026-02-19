"""Simple action executor for loop-level operations."""

from typing import Any, Dict

from agents.tools.registry import ToolRegistry


class Executor:
    """Executes concrete tool actions selected by the runtime."""

    def __init__(self, tool_registry: ToolRegistry):
        self.registry = tool_registry

    async def execute_action(self, action: Dict[str, Any]) -> str:
        name = action.get("tool")
        params = action.get("params", {})
        if not name:
            return "Error: action is missing 'tool'"
        return await self.registry.execute(name, params)
