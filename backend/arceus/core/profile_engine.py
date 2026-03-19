"""
ArceusProfileEngine — generates EmployeeProfile from Hippocampus tiers.

Spec reference: hippocampus_design_v6.md section 8.2
"""
from __future__ import annotations

from dataclasses import dataclass, field

from arceus.core.hippocampus.hippocampus import Hippocampus
from arceus.core.memory_scope import ArceusMemoryScope


@dataclass(frozen=True)
class EmployeeProfile:
    role: str = ""
    core_knowledge: list = field(default_factory=list)
    current_context: list = field(default_factory=list)
    habits: list = field(default_factory=list)
    state: dict = field(default_factory=dict)


class ArceusProfileEngine:
    """
    Generates EmployeeProfile from Hippocampus tiers.
    Arceus-domain logic: knows about Employee roles.
    """

    def __init__(self, scope: ArceusMemoryScope | None = None) -> None:
        self._scope = scope or ArceusMemoryScope()

    async def generate_profile(
        self,
        hippocampus: Hippocampus,
        agent_id: str,
        startup_id: str,
        role: str,
    ) -> EmployeeProfile:
        container = self._scope.employee_container(startup_id, agent_id)

        static_facts = await hippocampus.static_memory.search(
            query="",
            container=container,
            top_k=50,
        )
        dynamic_facts = await hippocampus.dynamic_memory.search(
            query="",
            container=container,
            top_k=20,
        )
        habits = []
        if hippocampus.procedural_memory is not None:
            active_habits = await hippocampus.procedural_memory.get_active()
            habits = [
                {
                    "trigger": habit.trigger_condition,
                    "action": habit.action,
                    "confidence": habit.confidence,
                }
                for habit in active_habits
            ]
        state = {}
        if hippocampus.priming_memory is not None:
            state = await hippocampus.priming_memory.get_current_state()

        return EmployeeProfile(
            role=role,
            core_knowledge=[m.content for m in static_facts],
            current_context=[m.content for m in dynamic_facts],
            habits=habits,
            state=state,
        )
