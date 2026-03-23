"""Shared fixtures for the embedded Hippocampus runtime tests."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

RUNTIME_SRC = Path(__file__).resolve().parents[1] / "python" / "src"
if str(RUNTIME_SRC) not in sys.path:
    sys.path.insert(0, str(RUNTIME_SRC))

import arceus.core.hippocampus.hippocampus as hippocampus_module

from .support.fakes.dict_cache import DictCacheStore
from .support.fakes.in_memory_graph import InMemoryGraphStoreBackend
from .support.fakes.in_memory_vector import InMemoryVectorStore
from .support.fakes.mock_embedding import MockEmbeddingEngine
from .support.fakes.noop_llm import NoopLLMEngine
from .support.fakes.sqlite_relational import SQLiteRelationalStore


@pytest.fixture
def patch_fake_hippocampus_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
):
    """Patch Hippocampus.create() factory hooks to use local test fakes."""

    def _patch(
        *,
        embedding_dimensions: int = 32,
        vector_store=None,
        relational_store=None,
        cache_backend=None,
        graph_backend=None,
        embedding_engine=None,
        llm_engine=None,
    ) -> SimpleNamespace:
        resolved_vector = vector_store or InMemoryVectorStore()
        resolved_relational = relational_store or SQLiteRelationalStore(
            str(tmp_path / "hippocampus.db")
        )
        resolved_cache = cache_backend or DictCacheStore()
        resolved_graph = graph_backend or InMemoryGraphStoreBackend()
        resolved_embedding = embedding_engine or MockEmbeddingEngine(
            dimensions=embedding_dimensions
        )

        def _create_llm(model_name: str):
            if llm_engine is not None:
                return llm_engine
            return NoopLLMEngine(model_name=model_name)

        monkeypatch.setattr(
            hippocampus_module,
            "create_vector_store",
            lambda backend, config: resolved_vector,
        )
        monkeypatch.setattr(
            hippocampus_module,
            "create_graph_store",
            lambda backend, config: resolved_graph,
        )
        monkeypatch.setattr(
            hippocampus_module,
            "create_cache",
            lambda backend, config: resolved_cache,
        )
        monkeypatch.setattr(
            hippocampus_module,
            "create_relational",
            lambda backend, config: resolved_relational,
        )
        monkeypatch.setattr(
            hippocampus_module,
            "create_embedding_engine",
            lambda backend, dimensions, *, device="cpu", strict=False: resolved_embedding,
        )
        monkeypatch.setattr(
            hippocampus_module,
            "create_llm_engine",
            lambda model_name, config: _create_llm(model_name),
        )

        return SimpleNamespace(
            vector_store=resolved_vector,
            relational_store=resolved_relational,
            cache_backend=resolved_cache,
            graph_backend=resolved_graph,
            embedding_engine=resolved_embedding,
            llm_engine=llm_engine,
        )

    return _patch
