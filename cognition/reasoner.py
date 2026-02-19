"""Reasoning module for synthesizing findings and hypotheses."""

from typing import Any, Dict, List


class Reasoner:
    """Performs lightweight semantic reasoning over interpreted state."""

    def reason(self, interpreted_state: Dict[str, Any]) -> Dict[str, Any]:
        signals = interpreted_state.get("signals", {})
        objectives = interpreted_state.get("objectives", [])

        hypotheses: List[str] = []
        risks: List[str] = []

        if signals.get("mentions_users"):
            hypotheses.append("Current experience likely fails key user jobs-to-be-done.")
            risks.append("Building quickly without user validation may miss root cause.")

        if signals.get("mentions_performance"):
            hypotheses.append("Perceived slowness likely impacts activation and retention.")
            risks.append("Optimizing only backend metrics may not fix perceived UX latency.")

        if signals.get("mentions_growth"):
            hypotheses.append("Acquisition channel quality may not match target ICP.")
            risks.append("Over-investing in one channel may reduce portfolio resilience.")

        if signals.get("mentions_revenue"):
            hypotheses.append("Pricing value metric may be misaligned with customer value realization.")
            risks.append("Pricing changes without segmentation may reduce conversion.")

        if not hypotheses:
            hypotheses.append("Problem statement may be underspecified; discovery is required first.")

        return {
            "objectives": objectives,
            "hypotheses": hypotheses,
            "risks": risks,
            "reasoning_summary": "Use discovery before commitment, then prioritize by impact vs effort.",
        }
