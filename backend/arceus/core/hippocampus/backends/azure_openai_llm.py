from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, get_args, get_origin

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from arceus.config.settings import settings
from arceus.core.hippocampus.types import ExtractedFact, MemoryType

logger = logging.getLogger(__name__)


def _get_retryable_exceptions() -> tuple[type[BaseException], ...]:
    from openai import APIConnectionError, APITimeoutError, RateLimitError

    return (RateLimitError, APITimeoutError, APIConnectionError)


class AzureOpenAILLMEngine:
    """Azure OpenAI-backed implementation of the Hippocampus LLM protocol."""

    def __init__(
        self,
        model_name: str,
        *,
        azure_endpoint: str = "",
        api_key: str = "",
        api_version: str = "",
        client: Any | None = None,
    ) -> None:
        self._model_name = model_name
        self._azure_endpoint = azure_endpoint or settings.azure_openai_endpoint
        self._api_key = api_key or settings.azure_openai_api_key.get_secret_value()
        self._api_version = api_version or settings.azure_openai_api_version
        self._client = client

    async def extract_structured(
        self,
        prompt: str,
        messages: list[dict],
        output_schema: type,
    ) -> list:
        response = await self._complete_json(
            system_prompt=prompt,
            user_payload=json.dumps({"messages": messages}, default=str),
        )
        if _is_extracted_fact_list(output_schema):
            items = response.get("facts", response) if isinstance(response, dict) else response
            if not isinstance(items, list):
                return []
            extracted: list[ExtractedFact] = []
            for item in items:
                fact = self._coerce_extracted_fact(item)
                if fact is not None:
                    extracted.append(fact)
            return extracted
        return response

    async def decide(self, prompt: str, **kwargs) -> dict:
        response = await self._complete_json(
            system_prompt=prompt,
            user_payload=json.dumps(kwargs, default=str),
        )
        return {
            "action": str(response.get("action", "NONE")),
            "target_id": str(response.get("target_id", "")),
            "reason": str(response.get("reason", "")),
        }

    async def analyze(self, prompt: str, **kwargs) -> dict:
        response = await self._complete_json(
            system_prompt=prompt,
            user_payload=json.dumps(kwargs, default=str),
        )
        return response if isinstance(response, dict) else {"result": response}

    async def generate(self, prompt: str, **kwargs) -> str:
        payload = json.dumps(kwargs, default=str) if kwargs else ""
        return await self._complete_text(prompt, payload)

    async def classify(self, prompt: str, options: list[str], **kwargs) -> str:
        options_text = "\n".join(f"- {option}" for option in options)
        payload_parts = [f"Allowed options:\n{options_text}"]
        if kwargs:
            payload_parts.append(json.dumps(kwargs, default=str))
        text = await self._complete_text(prompt, "\n\n".join(payload_parts))
        normalized = text.strip().strip('"').strip().lower()
        for option in options:
            if normalized == option.lower():
                return option
        return options[0]

    async def _complete_json(self, system_prompt: str, user_payload: str) -> Any:
        text = await self._create_completion(
            system_prompt=_ensure_json_instruction(system_prompt),
            user_payload=user_payload,
            response_format={"type": "json_object"},
        )
        return _load_json(text)

    async def _complete_text(self, system_prompt: str, user_payload: str) -> str:
        return await self._create_completion(
            system_prompt=system_prompt,
            user_payload=user_payload,
            response_format=None,
        )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        retry=retry_if_exception_type(_get_retryable_exceptions()),
        before_sleep=lambda rs: logger.warning(
            "Azure OpenAI transient error (attempt %d): %s",
            rs.attempt_number,
            rs.outcome.exception(),
        ),
    )
    async def _create_completion(
        self,
        *,
        system_prompt: str,
        user_payload: str,
        response_format: dict[str, str] | None,
    ) -> str:
        client = self._get_client()
        messages = [{"role": "system", "content": system_prompt}]
        if user_payload:
            messages.append({"role": "user", "content": user_payload})

        request: dict[str, Any] = {
            "model": self._model_name,
            "messages": messages,
        }
        if response_format is not None:
            request["response_format"] = response_format

        response = await client.chat.completions.create(**request)
        content = response.choices[0].message.content
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            text_parts: list[str] = []
            for part in content:
                if isinstance(part, dict):
                    text_parts.append(str(part.get("text", "")))
                else:
                    text_parts.append(str(getattr(part, "text", "")))
            return "".join(text_parts)
        return ""

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        if not (self._azure_endpoint and self._api_key):
            raise ValueError("Azure OpenAI credentials are missing")

        from openai import AsyncAzureOpenAI

        self._client = AsyncAzureOpenAI(
            azure_endpoint=self._azure_endpoint,
            api_key=self._api_key,
            api_version=self._api_version,
        )
        return self._client

    def _coerce_extracted_fact(self, payload: Any) -> ExtractedFact | None:
        if not isinstance(payload, dict):
            return None
        fact_type = str(payload.get("memory_type") or payload.get("type") or "dynamic").lower()
        expires_at = payload.get("expires_at")
        text = str(payload.get("text", "")).strip()
        if not text:
            text = self._synthesize_fact_text(payload)
        if not text:
            return None
        return ExtractedFact(
            text=text,
            memory_type=_coerce_memory_type(fact_type),
            confidence=float(payload.get("confidence", 0.0) or 0.0),
            source_type=str(payload.get("source_type", "") or "").strip() or "remember",
            is_permanent=bool(
                payload.get("is_permanent", fact_type == MemoryType.STATIC.value)
            ),
            is_procedural=bool(
                payload.get("is_procedural", fact_type == MemoryType.PROCEDURAL.value)
            ),
            is_temporal=bool(payload.get("is_temporal", False)),
            expires_at=_parse_datetime(expires_at),
            entities=tuple(str(item) for item in payload.get("entities", []) or []),
            relationships=tuple(
                tuple(str(part) for part in relation[:3])
                for relation in payload.get("relationships", []) or []
            ),
        )

    def _synthesize_fact_text(self, payload: dict[str, Any]) -> str:
        relationships = payload.get("relationships", []) or []
        if relationships:
            source, relation, target = relationships[0][:3]
            return f"{source} {relation} {target}".strip()
        entities = payload.get("entities", []) or []
        if entities:
            return ", ".join(str(entity) for entity in entities)
        return ""


def has_azure_openai_credentials(
    *,
    azure_endpoint: str = "",
    api_key: str = "",
) -> bool:
    return bool(
        (azure_endpoint or settings.azure_openai_endpoint)
        and (api_key or settings.azure_openai_api_key.get_secret_value())
    )


def _strip_json_fence(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1]).strip()
    return text


def _load_json(value: str) -> Any:
    text = _strip_json_fence(value)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        start = text.find("[")
        end = text.rfind("]")
        if start != -1 and end != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def _ensure_json_instruction(system_prompt: str) -> str:
    if "json" in system_prompt.lower():
        return system_prompt
    return f"{system_prompt.rstrip()}\n\nReturn valid JSON only."


def _coerce_memory_type(value: str) -> MemoryType:
    try:
        return MemoryType(value)
    except ValueError:
        return MemoryType.DYNAMIC


def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


def _is_extracted_fact_list(output_schema: type) -> bool:
    return get_origin(output_schema) is list and get_args(output_schema) == (ExtractedFact,)
