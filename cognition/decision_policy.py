"""Decision policy module for selecting and prioritizing next actions."""

from typing import Any, Dict, List


class DecisionPolicy:
    """Applies policy rules to choose practical next actions."""

    def choose(self, interpreted_state: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
        phases = plan.get("phases", [])
        objectives = interpreted_state.get("objectives", [])
        constraints = interpreted_state.get("constraints", {})

        next_actions: List[str] = []
        for phase in phases:
            phase_name = phase.get("phase", "")
            skills = phase.get("skills", [])
            if skills:
                next_actions.append(f"{phase_name}: run {', '.join(skills)}")
            else:
                next_actions.append(f"{phase_name}: proceed with generic PM analysis")

        priority = "high" if interpreted_state.get("signals", {}).get("mentions_users") else "medium"
        confidence = self._estimate_confidence(interpreted_state)
        requires_web_evidence = confidence < 0.7
        if requires_web_evidence:
            next_actions.insert(0, "understand: gather web evidence before final recommendation")

        return {
            "priority": priority,
            "next_actions": next_actions,
            "decision": "Proceed with phased discovery-to-delivery plan",
            "objective_focus": objectives,
            "confidence": confidence,
            "requires_web_evidence": requires_web_evidence,
            "has_context": constraints.get("has_context", False),
        }

    @staticmethod
    def _estimate_confidence(interpreted_state: Dict[str, Any]) -> float:
        constraints = interpreted_state.get("constraints", {})
        signals = interpreted_state.get("signals", {})
        skills_count = constraints.get("skills_count", 0)
        has_context = 1.0 if constraints.get("has_context") else 0.0
        signal_strength = 1.0 if any(bool(value) for value in signals.values()) else 0.0

        confidence = 0.35 + (0.25 * has_context) + (0.2 * min(skills_count / 5.0, 1.0)) + (
            0.2 * signal_strength
        )
        return round(min(confidence, 0.95), 2)
