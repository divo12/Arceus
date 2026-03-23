from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class SentenceTransformerEmbeddingEngine:
    """Sentence-transformers embedding backend for the Hippocampus MVP spec."""

    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        *,
        device: str = "cpu",
        dimensions: int | None = None,
        strict: bool = False,
    ) -> None:
        self._model_name = model_name
        self._device = device
        self._dimensions = dimensions
        self._strict = strict
        self._model: Any | None = None
        self._lock = asyncio.Lock()

    async def warmup(self) -> None:
        model = await self._get_model()
        vector = await asyncio.to_thread(
            model.encode,
            ["warmup"],
            normalize_embeddings=True,
        )
        if hasattr(vector, "tolist"):
            vector = vector.tolist()
        if vector:
            sample = vector[0]
            self._ensure_dimensions(
                sample.tolist() if hasattr(sample, "tolist") else list(sample)
            )

    async def embed(self, text: str) -> list[float]:
        model = await self._get_model()
        vector = await asyncio.to_thread(
            model.encode,
            text,
            normalize_embeddings=True,
        )
        values = vector.tolist() if hasattr(vector, "tolist") else list(vector)
        self._ensure_dimensions(values)
        return values

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        model = await self._get_model()
        vectors = await asyncio.to_thread(
            model.encode,
            texts,
            normalize_embeddings=True,
        )
        if hasattr(vectors, "tolist"):
            vectors = vectors.tolist()
        normalized_vectors: list[list[float]] = []
        for vector in vectors:
            if hasattr(vector, "tolist"):
                values = list(vector.tolist())
            else:
                values = list(vector)
            self._ensure_dimensions(values)
            normalized_vectors.append(values)
        return normalized_vectors

    async def _get_model(self) -> Any:
        if self._model is not None:
            return self._model

        async with self._lock:
            if self._model is not None:
                return self._model
            try:
                from sentence_transformers import SentenceTransformer

                self._model = await asyncio.to_thread(
                    SentenceTransformer,
                    self._model_name,
                    device=self._device,
                )
            except Exception as exc:
                logger.error(
                    "Sentence-transformers model %s on device %s could not be loaded: %s",
                    self._model_name,
                    self._device,
                    exc,
                )
                raise RuntimeError(
                    "Sentence-transformers model "
                    f"{self._model_name} could not be loaded on device {self._device}"
                ) from exc
        return self._model

    def _ensure_dimensions(self, values: list[float]) -> None:
        if self._dimensions is None:
            return
        if len(values) != self._dimensions:
            raise ValueError(
                "Sentence-transformers embedding dimension mismatch: "
                f"expected {self._dimensions}, got {len(values)}"
            )
