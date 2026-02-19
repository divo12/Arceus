"""Simple provider used for deterministic local loop execution/tests."""

import json
from typing import Any, Dict, List

from providers.adapter import ProviderAdapter, ProviderResponse, ToolCall


class RuleBasedProvider(ProviderAdapter):
    """Heuristic provider that can request tools before finalizing."""

    def _extract_last_user_text(self, messages: List[Dict[str, Any]]) -> str:
        for message in reversed(messages):
            if message.get("role") == "user":
                content = message.get("content", "")
                if isinstance(content, str):
                    return content
                return json.dumps(content)
        return ""

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tool_schemas: List[Dict[str, Any]],
        iteration: int,
        runtime_context: Dict[str, Any],
    ) -> ProviderResponse:
        available_tools = {
            schema.get("function", {}).get("name", "")
            for schema in tool_schemas
            if schema.get("type") == "function"
        }
        web_evidence = runtime_context.get("web_evidence", [])
        require_web = runtime_context.get("require_web_evidence", False)
        problem = runtime_context.get("problem", "")
        last_user = self._extract_last_user_text(messages)
        query = problem or last_user or "product management problem analysis"

        if require_web and not web_evidence and "web_search" in available_tools:
            return ProviderResponse(
                content="Collecting external evidence before making recommendation.",
                tool_calls=[
                    ToolCall(
                        name="web_search",
                        arguments={"query": query, "count": 3},
                        call_id=f"web-search-{iteration}",
                    )
                ],
                confidence=0.4,
                done=False,
                rationale="Policy requires web evidence for low-confidence context.",
            )

        evidence_summary = ""
        if web_evidence:
            top_sources = [item.get("source", "") for item in web_evidence[:3] if item.get("source")]
            if top_sources:
                evidence_summary = f" Evidence sources: {', '.join(top_sources)}."

        return ProviderResponse(
            content=(
                "Recommendation prepared with phased PM analysis."
                f"{evidence_summary}"
            ),
            tool_calls=[],
            confidence=0.8 if web_evidence else 0.65,
            done=True,
            rationale="Sufficient context to finalize response.",
        )
