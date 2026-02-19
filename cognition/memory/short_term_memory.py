"""Short-term memory for recent cognitive traces."""

from typing import Any, Dict, List


class ShortTermMemory:
    """Keeps a bounded in-memory list of recent cognitive episodes."""

    def __init__(self, max_items: int = 20):
        self.max_items = max_items
        self._items: List[Dict[str, Any]] = []

    def add(self, item: Dict[str, Any]) -> None:
        self._items.append(item)
        if len(self._items) > self.max_items:
            self._items = self._items[-self.max_items :]

    def get_recent(self) -> List[Dict[str, Any]]:
        return list(self._items)

    def clear(self) -> None:
        self._items = []
