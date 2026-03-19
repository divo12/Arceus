from __future__ import annotations

import hashlib
import math
import re


class SimpleEmbeddingEngine:
    """Deterministic local embedding fallback for implementable Phase 0/1 work."""

    def __init__(self, dimensions: int = 384) -> None:
        self._dimensions = dimensions

    async def embed(self, text: str) -> list[float]:
        tokens = re.findall(r"[a-z0-9]+", text.lower())
        vector = [0.0] * self._dimensions
        if not tokens:
            return vector

        for token in tokens:
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self._dimensions
            vector[index] += 1.0

        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0:
            return vector

        return [value / norm for value in vector]

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [await self.embed(text) for text in texts]
