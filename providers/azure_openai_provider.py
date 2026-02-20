"""Azure OpenAI provider for the agent loop."""

import json
from typing import Any, Dict, List

from openai import AsyncAzureOpenAI

from providers.adapter import ProviderAdapter, ProviderResponse, ToolCall
from settings import Settings
from utils.logger import logger


class AzureOpenAIProvider(ProviderAdapter):
    """Provider that uses Azure OpenAI for real LLM generation."""

    def __init__(
        self,
        model: str | None = None,
        temperature: float = 0.3,
        deployment_name: str | None = None,
    ):
        from settings import Settings
        self.model = (
            deployment_name or model or getattr(Settings, "AZURE_OPENAI_DEPLOYMENT", None)
            or "gpt-5.2"
        )
        self.temperature = temperature
        self.client = AsyncAzureOpenAI(
            azure_endpoint=Settings.AZURE_OPENAI_ENDPOINT,
            api_key=Settings.AZURE_OPENAI_API_KEY,
            api_version="2025-04-01-preview",
            timeout=120,
        )

    def _tools_for_api(self, tool_schemas: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert registry schemas to OpenAI tools format."""
        tools = []
        for schema in tool_schemas:
            if schema.get("type") == "function" and schema.get("function"):
                tools.append(schema)
        return tools if tools else []

    def _parse_tool_calls(
        self, raw_tool_calls: List[Any]
    ) -> List[ToolCall]:
        """Convert OpenAI tool_calls to ProviderResponse format."""
        result = []
        for tc in raw_tool_calls or []:
            fn = tc.function if hasattr(tc, "function") else tc.get("function", {})
            name = fn.name if hasattr(fn, "name") else fn.get("name", "")
            args_str = fn.arguments if hasattr(fn, "arguments") else fn.get("arguments", "{}")
            call_id = tc.id if hasattr(tc, "id") else tc.get("id", "")
            try:
                arguments = json.loads(args_str) if isinstance(args_str, str) else args_str
            except json.JSONDecodeError:
                arguments = {}
            result.append(ToolCall(name=name, arguments=arguments, call_id=call_id))
        return result

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tool_schemas: List[Dict[str, Any]],
        iteration: int,
        runtime_context: Dict[str, Any],
    ) -> ProviderResponse:
        """Produce a response via Azure OpenAI chat completion."""
        tools = self._tools_for_api(tool_schemas)
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "temperature": self.temperature,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        try:
            response = await self.client.chat.completions.create(**kwargs)
            choice = response.choices[0] if response.choices else None
            if not choice:
                logger.error("Azure OpenAI returned no choices")
                return ProviderResponse(
                    content="Error: No response from model.",
                    confidence=0.0,
                    done=True,
                    rationale="API returned empty choices.",
                )

            msg = choice.message
            content = msg.content or ""
            raw_tool_calls = msg.tool_calls if hasattr(msg, "tool_calls") else []

            tool_calls = self._parse_tool_calls(list(raw_tool_calls) if raw_tool_calls else [])

            # Heuristic: done when no tool calls; confidence based on finish reason
            done = len(tool_calls) == 0
            finish = getattr(choice, "finish_reason", None) or ""
            confidence = 0.8 if done and finish == "stop" else 0.6
            rationale = f"finish_reason={finish}" if finish else ""

            return ProviderResponse(
                content=content,
                tool_calls=tool_calls,
                confidence=confidence,
                done=done,
                rationale=rationale,
            )
        except Exception as e:
            logger.error(f"Azure OpenAI completion failed: {e}")
            return ProviderResponse(
                content=f"Error: {str(e)}",
                confidence=0.0,
                done=True,
                rationale=f"Exception: {type(e).__name__}",
            )
