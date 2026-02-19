"""Translate raw problem observations into structured internal state."""

from typing import Any, Dict, List, Optional


class StateInterpreter:
    """Interprets user input into a structured state representation."""

    def interpret(
        self,
        problem_description: str,
        context: Optional[Dict[str, Any]],
        available_skills: List[str],
    ) -> Dict[str, Any]:
        context = context or {}
        lowered = problem_description.lower()

        signals = {
            "mentions_users": "user" in lowered or "customer" in lowered,
            "mentions_growth": "growth" in lowered or "acquisition" in lowered,
            "mentions_performance": "slow" in lowered or "latency" in lowered,
            "mentions_revenue": "revenue" in lowered or "pricing" in lowered,
        }

        objectives: List[str] = []
        if signals["mentions_users"]:
            objectives.append("Improve user outcomes and experience")
        if signals["mentions_growth"]:
            objectives.append("Improve growth and acquisition efficiency")
        if signals["mentions_performance"]:
            objectives.append("Reduce friction in product performance")
        if signals["mentions_revenue"]:
            objectives.append("Improve monetization outcomes")
        if not objectives:
            objectives.append("Clarify problem, impact, and desired outcome")

        return {
            "problem": problem_description.strip(),
            "context": context,
            "objectives": objectives,
            "signals": signals,
            "available_skills": available_skills,
            "constraints": {
                "has_context": bool(context),
                "skills_count": len(available_skills),
            },
        }
