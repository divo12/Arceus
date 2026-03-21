from __future__ import annotations

import pytest

from arceus.core.hippocampus.backends.sentence_transformers_embedding import (
    SentenceTransformerEmbeddingEngine,
)


class _FakeVector:
    def __init__(self, values: list[float]) -> None:
        self._values = values

    def tolist(self) -> list[float]:
        return self._values


@pytest.mark.asyncio
async def test_sentence_transformer_engine_passes_device_and_warms_up(monkeypatch) -> None:
    init_calls: list[tuple[str, str]] = []
    encode_calls: list[tuple[object, bool]] = []

    class FakeModel:
        def encode(self, payload, normalize_embeddings: bool = True):  # noqa: ANN001
            encode_calls.append((payload, normalize_embeddings))
            if isinstance(payload, list):
                return [_FakeVector([1.0, 0.0, 0.0])]
            return _FakeVector([0.0, 1.0, 0.0])

    class FakeSentenceTransformer:
        def __init__(self, model_name: str, device: str = "cpu") -> None:
            init_calls.append((model_name, device))
            self._model = FakeModel()

        def encode(self, payload, normalize_embeddings: bool = True):  # noqa: ANN001
            return self._model.encode(payload, normalize_embeddings=normalize_embeddings)

    monkeypatch.setattr(
        "sentence_transformers.SentenceTransformer",
        FakeSentenceTransformer,
    )

    engine = SentenceTransformerEmbeddingEngine(
        model_name="all-MiniLM-L6-v2",
        device="cuda",
        dimensions=3,
        strict=True,
    )

    await engine.warmup()
    result = await engine.embed("hello")

    assert init_calls == [("all-MiniLM-L6-v2", "cuda")]
    assert encode_calls[0] == (["warmup"], True)
    assert encode_calls[1] == ("hello", True)
    assert result == [0.0, 1.0, 0.0]


@pytest.mark.asyncio
async def test_sentence_transformer_engine_strict_mode_raises_on_load_failure(
    monkeypatch,
) -> None:
    class BrokenSentenceTransformer:
        def __init__(self, model_name: str, device: str = "cpu") -> None:
            raise RuntimeError(f"cannot load {model_name} on {device}")

    monkeypatch.setattr(
        "sentence_transformers.SentenceTransformer",
        BrokenSentenceTransformer,
    )

    engine = SentenceTransformerEmbeddingEngine(
        model_name="all-MiniLM-L6-v2",
        device="cpu",
        dimensions=3,
        strict=True,
    )

    with pytest.raises(RuntimeError, match="could not be loaded"):
        await engine.embed("hello")


@pytest.mark.asyncio
async def test_sentence_transformer_engine_rejects_dimension_mismatch(monkeypatch) -> None:
    class FakeModel:
        def encode(self, payload, normalize_embeddings: bool = True):  # noqa: ANN001
            if isinstance(payload, list):
                return [_FakeVector([1.0, 0.0])]
            return _FakeVector([1.0, 0.0])

    async def fake_get_model() -> FakeModel:
        return FakeModel()

    engine = SentenceTransformerEmbeddingEngine(dimensions=3, strict=True)
    monkeypatch.setattr(engine, "_get_model", fake_get_model)

    with pytest.raises(ValueError, match="dimension mismatch"):
        await engine.embed("hello")


@pytest.mark.asyncio
async def test_sentence_transformer_engine_non_strict_falls_back_to_mock(
    monkeypatch,
) -> None:
    class BrokenSentenceTransformer:
        def __init__(self, model_name: str, device: str = "cpu") -> None:
            raise RuntimeError(f"cannot load {model_name} on {device}")

    monkeypatch.setattr(
        "sentence_transformers.SentenceTransformer",
        BrokenSentenceTransformer,
    )

    engine = SentenceTransformerEmbeddingEngine(
        model_name="all-MiniLM-L6-v2",
        device="cpu",
        dimensions=5,
        strict=False,
    )

    values = await engine.embed("hello")

    assert len(values) == 5
