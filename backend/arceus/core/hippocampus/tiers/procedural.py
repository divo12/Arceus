from __future__ import annotations

from arceus.core.hippocampus.backends.protocols import LLMEngine, RelationalStore
from arceus.core.hippocampus.prompts import TRIGGER_EVALUATION_PROMPT
from arceus.core.hippocampus.types import Habit


class ProceduralMemory:
    def __init__(
        self,
        agent_id: str,
        relational_store: RelationalStore,
        llm_light: LLMEngine,
    ) -> None:
        self._agent_id = agent_id
        self._store = relational_store
        self._llm = llm_light

    async def add_habit(self, habit: Habit) -> Habit:
        await self._store.insert_habit(habit)
        return habit

    async def get_matching_habits(self, context: str) -> list[Habit]:
        habits = await self._store.list_habits(agent_id=self._agent_id, is_active=True)
        if not habits:
            return []

        triggers_text = "\n".join(
            f"{index}. {habit.trigger_condition}"
            for index, habit in enumerate(habits)
        )
        result = await self._llm.decide(
            prompt=TRIGGER_EVALUATION_PROMPT.format(
                context=context,
                triggers=triggers_text,
            )
        )
        items = result if isinstance(result, list) else result.get("items", [])

        matches: list[Habit] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            index = item.get("index")
            relevant = item.get("relevant")
            if isinstance(index, int) and relevant is True and 0 <= index < len(habits):
                matches.append(habits[index])
        return matches

    async def get_active(self) -> list[Habit]:
        return await self._store.list_habits(agent_id=self._agent_id, is_active=True)

    async def record_usage(self, habit_id: str, was_useful: bool) -> Habit:
        lr = 0.1
        signal = 1.0 if was_useful else 0.0
        return await self._store.record_habit_usage(habit_id, lr, signal)
