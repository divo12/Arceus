"""Decision policy module for selecting and prioritizing next actions."""

from typing import Any, Dict, List


class DecisionPolicy:
    """Applies policy rules to choose practical next actions."""

    def choose(self, interpreted_state: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
        phases = plan.get("phases", [])
        objectives = interpreted_state.get("objectives", [])

        next_actions: List[str] = []
        for phase in phases:
            phase_name = phase.get("phase", "")
            skills = phase.get("skills", [])
            if skills:
                next_actions.append(f"{phase_name}: run {', '.join(skills)}")
            else:
                next_actions.append(f"{phase_name}: proceed with generic PM analysis")

        priority = "high" if interpreted_state.get("signals", {}).get("mentions_users") else "medium"

        return {
            "priority": priority,
            "next_actions": next_actions,
            "decision": "Proceed with phased discovery-to-delivery plan",
            "objective_focus": objectives,
        }
