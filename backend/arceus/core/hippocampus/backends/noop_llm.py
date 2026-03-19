from __future__ import annotations


class NoopLLMEngine:
    """Local placeholder LLM engine for wiring Phase 2 without network calls."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name

    async def extract_structured(
        self,
        prompt: str,
        messages: list[dict],
        output_schema: type,
    ) -> list:
        del prompt, messages, output_schema
        return []

    async def decide(self, prompt: str, **kwargs) -> dict:
        del prompt, kwargs
        return {"action": "NONE", "target_id": "", "reason": f"{self._model_name} not configured"}

    async def analyze(self, prompt: str, **kwargs) -> dict:
        del prompt, kwargs
        return {}

    async def generate(self, prompt: str, **kwargs) -> str:
        del prompt, kwargs
        return ""

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
        del kwargs
        prompt_lower = prompt.lower()
        for option in options:
            if option in prompt_lower:
                return option

        keyword_map = {
            "depends_on": ("depends on", "relies on", "requires"),
            "part_of": ("part of", "component of"),
            "updates": ("updates", "replaces", "supersedes"),
            "extends": ("extends", "adds to"),
            "derives": ("derived from", "inferred from"),
            "uses": ("uses", "built with", "implemented with", "via"),
            "owns": ("owns", "responsible for"),
            "decided_in": ("decided in", "agreed in"),
        }
        for option, keywords in keyword_map.items():
            if option not in options:
                continue
            if any(keyword in prompt_lower for keyword in keywords):
                return option

        return "related_to" if "related_to" in options else options[0]
