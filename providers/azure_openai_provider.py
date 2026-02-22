"""Azure OpenAI provider for the agent loop."""

import asyncio
import json
from typing import Any, Dict, List

from openai import APIConnectionError, APITimeoutError, AsyncAzureOpenAI, RateLimitError

from providers.adapter import ProviderAdapter, ProviderResponse, ToolCall
from settings import Settings
from utils.logger import logger

# Retry config for transient connection errors
MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0  # seconds
MAX_RATE_LIMIT_RETRIES = 5


class AzureOpenAIProvider(ProviderAdapter):
    """Provider that uses Azure OpenAI for real LLM generation."""

    def __init__(
        self,
        model: str | None = None,
        temperature: float = 0.3,
        deployment_name: str | None = None,
        api_key: str | None = None,
        endpoint: str | None = None,
    ):
        from settings import Settings
        self.model = (
            deployment_name or model or getattr(Settings, "AZURE_OPENAI_DEPLOYMENT", None)
            or "gpt-5.2"
        )
        self.temperature = temperature
        ep = endpoint or Settings.AZURE_OPENAI_ENDPOINT or ""
        key = api_key or Settings.AZURE_OPENAI_API_KEY or ""
        self.client = AsyncAzureOpenAI(
            azure_endpoint=ep,
            api_key=key,
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

    def _parse_response(self, response: Any) -> ProviderResponse:
        """Parse non-streaming chat completion response into ProviderResponse."""
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

    async def _complete_stream(
        self, kwargs: Dict[str, Any], stream_callback: Any
    ) -> ProviderResponse:
        """Stream completion, call stream_callback with each content chunk, return full response."""
        stream = await self.client.chat.completions.create(**kwargs)
        content_parts: List[str] = []
        tool_calls_acc: Dict[int, Dict[str, Any]] = {}

        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if not delta:
                continue
            if getattr(delta, "content", None) and delta.content:
                content_parts.append(delta.content)
                stream_callback(delta.content)
            tc_deltas = getattr(delta, "tool_calls", None) or []
            for tc in tc_deltas:
                idx = getattr(tc, "index", 0)
                if idx not in tool_calls_acc:
                    tool_calls_acc[idx] = {"id": "", "name": "", "arguments": ""}
                acc = tool_calls_acc[idx]
                if getattr(tc, "id", None):
                    acc["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn:
                    if getattr(fn, "name", None):
                        acc["name"] = fn.name
                    if getattr(fn, "arguments", None):
                        acc["arguments"] = acc.get("arguments", "") + fn.arguments

        content = "".join(content_parts)
        raw_tool_calls = []
        for idx in sorted(tool_calls_acc.keys()):
            a = tool_calls_acc[idx]
            if a["id"] or a["name"]:
                raw_tool_calls.append({
                    "id": a["id"],
                    "function": {"name": a["name"], "arguments": a.get("arguments", "")},
                })
        tool_calls = self._parse_tool_calls(raw_tool_calls) if raw_tool_calls else []
        done = len(tool_calls) == 0
        confidence = 0.8 if done else 0.6
        return ProviderResponse(
            content=content,
            tool_calls=tool_calls,
            confidence=confidence,
            done=done,
            rationale="finish_reason=stop" if done else "stream_with_tools",
        )

    async def complete(
        self,
        messages: List[Dict[str, Any]],
        tool_schemas: List[Dict[str, Any]],
        iteration: int,
        runtime_context: Dict[str, Any],
    ) -> ProviderResponse:
        """Produce a response via Azure OpenAI chat completion. Streams tokens when stream_callback in runtime_context."""
        tools = self._tools_for_api(tool_schemas)
        stream_callback = runtime_context.get("stream_callback")
        stream = bool(stream_callback)

        kwargs: Dict[str, Any] = {
            "model": self.model,
            "temperature": self.temperature,
            "messages": messages,
            "stream": stream,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"

        last_error: Exception | None = None
        rate_limit_attempts = 0
        for attempt in range(MAX_RETRIES + 1):
            try:
                if stream:
                    return await self._complete_stream(kwargs, stream_callback)
                response = await self.client.chat.completions.create(**kwargs)
                return self._parse_response(response)
            except RateLimitError as e:
                # Azure returns retry guidance in error text ("Please retry after X seconds")
                rate_limit_attempts += 1
                retry_after = 3.0
                msg = str(e)
                try:
                    import re
                    m = re.search(r"retry after\s+(\d+)\s+seconds", msg, flags=re.I)
                    if m:
                        retry_after = float(m.group(1))
                except Exception:
                    pass

                if rate_limit_attempts <= MAX_RATE_LIMIT_RETRIES:
                    logger.warning(
                        "Azure OpenAI rate-limited (%d/%d). Retrying in %.1fs",
                        rate_limit_attempts,
                        MAX_RATE_LIMIT_RETRIES,
                        retry_after,
                    )
                    await asyncio.sleep(retry_after)
                    continue

                logger.error(
                    "Azure OpenAI rate limit exceeded after %d retries: %s",
                    MAX_RATE_LIMIT_RETRIES,
                    e,
                )
                return ProviderResponse(
                    content=f"Error: Rate limited by Azure OpenAI after retries. {msg}",
                    confidence=0.0,
                    done=True,
                    rationale="RateLimitError after retries",
                )
            except (APIConnectionError, APITimeoutError, ConnectionError, OSError, asyncio.TimeoutError) as e:
                last_error = e
                if attempt < MAX_RETRIES:
                    delay = RETRY_BASE_DELAY * (2**attempt)
                    logger.warning(
                        f"Azure OpenAI connection attempt {attempt + 1}/{MAX_RETRIES + 1} failed: {e}. "
                        f"Retrying in {delay:.1f}s..."
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(f"Azure OpenAI completion failed after {MAX_RETRIES + 1} attempts: {e}")
            except Exception as e:
                logger.error(f"Azure OpenAI completion failed: {e}")
                return ProviderResponse(
                    content=f"Error: {str(e)}",
                    confidence=0.0,
                    done=True,
                    rationale=f"Exception: {type(e).__name__}",
                )

        err_msg = str(last_error)
        hint = (
            " Check: (1) endpoint format (https://<resource>.openai.azure.com), "
            "(2) network/proxy access, (3) run from terminal with network enabled."
        )
        return ProviderResponse(
            content=f"Error: {err_msg}{hint}",
            confidence=0.0,
            done=True,
            rationale="Connection failed after retries",
        )
