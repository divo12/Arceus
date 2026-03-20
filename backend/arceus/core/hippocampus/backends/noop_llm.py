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
        return "NoopLLMEngine placeholder response."

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
        del prompt, kwargs
        if not options:
            raise ValueError("classify() requires at least one option")
        return options[0]
