"""Shared model/provider payload types."""

from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass
class ToolExecutionRecord:
    """Structured tool execution output for runtime traces."""

    tool: str
    arguments: Dict[str, Any]
    result: str


@dataclass
class IterationTrace:
    """Structured trace entry for each loop iteration."""

    run_id: str
    iteration: int
    timestamp: str
    confidence: float
    decision: Dict[str, Any]
    tool_results: List[ToolExecutionRecord] = field(default_factory=list)
