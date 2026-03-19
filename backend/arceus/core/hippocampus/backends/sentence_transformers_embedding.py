from __future__ import annotations

import asyncio
import logging
from typing import Any

from arceus.core.hippocampus.backends.simple_embedding import MockEmbeddingEngine

logger = logging.getLogger(__name__)


class SentenceTransformerEmbeddingEngine:
    """Sentence-transformers embedding backend for the Hippocampus MVP spec."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        self._model_name = model_name
        self._model: Any | None = None
        self._fallback = MockEmbeddingEngine(dimensions=384)
        self._lock = asyncio.Lock()

    async def embed(self, text: str) -> list[float]:
        model = await self._get_model()
        if model is None:
            return await self._fallback.embed(text)
        vector = await asyncio.to_thread(
            model.encode,
            text,
            normalize_embeddings=True,
        )
        return vector.tolist() if hasattr(vector, "tolist") else list(vector)

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        model = await self._get_model()
        if model is None:
            return await self._fallback.embed_batch(texts)
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
                normalized_vectors.append(list(vector.tolist()))
            else:
                normalized_vectors.append(list(vector))
        return normalized_vectors

    async def _get_model(self) -> Any:
        if self._model is not None:
            return self._model

        async with self._lock:
            if self._model is None:
                from sentence_transformers import SentenceTransformer

                try:
                    self._model = await asyncio.to_thread(
                        SentenceTransformer,
                        self._model_name,
                    )
                except Exception as exc:
                    logger.warning(
                        "Falling back to simple embeddings because sentence-transformers "
                        "model %s could not be loaded: %s",
                        self._model_name,
                        exc,
                    )
                    self._model = None
        return self._model
