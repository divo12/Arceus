"""Memory manager that coordinates short-term and long-term memory."""

from pathlib import Path
from typing import Any, Dict

from cognition.memory.short_term_memory import ShortTermMemory
from cognition.memory.long_term_memory import LongTermMemory


class MemoryManager:
    """Coordinates memory read/write for the cognitive loop."""

    def __init__(self, workspace: Path):
        self.short_term = ShortTermMemory()
        self.long_term = LongTermMemory(workspace)

    def record_episode(self, episode: Dict[str, Any]) -> None:
        self.short_term.add(episode)
        self.long_term.append_episode(episode)

    def get_memory_snapshot(self) -> Dict[str, Any]:
        return {
            "recent": self.short_term.get_recent(),
            "persistent": self.long_term.read(),
        }
