"""Provider adapter interfaces for loop execution."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Protocol


@dataclass
class ToolCall:
    """Represents a single tool call proposed by a provider."""

    name: str
    arguments: Dict[str, Any]
    call_id: str


@dataclass
class ProviderResponse:
    """Normalized provider output consumed by the loop."""

    content: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    confidence: float = 0.5
    done: bool = False
    rationale: str = ""


class ProviderAdapter(Protocol):
    """Minimal provider contract for iterative runtime."""

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tool_schemas: List[Dict[str, Any]],
        iteration: int,
        runtime_context: Dict[str, Any],
    ) -> ProviderResponse:
        """Produce a response for the current loop iteration."""
