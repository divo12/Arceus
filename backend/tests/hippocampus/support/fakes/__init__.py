"""Test fakes for Hippocampus unit and adapter tests."""

from tests.hippocampus.support.fakes.dict_cache import DictCacheStore
from tests.hippocampus.support.fakes.in_memory_graph import InMemoryGraphStoreBackend
from tests.hippocampus.support.fakes.in_memory_pattern import InMemoryPatternStore
from tests.hippocampus.support.fakes.in_memory_vector import InMemoryVectorStore
from tests.hippocampus.support.fakes.mock_embedding import MockEmbeddingEngine
from tests.hippocampus.support.fakes.noop_llm import NoopLLMEngine
from tests.hippocampus.support.fakes.sqlite_relational import SQLiteRelationalStore

__all__ = [
    "DictCacheStore",
    "InMemoryGraphStoreBackend",
    "InMemoryPatternStore",
    "InMemoryVectorStore",
    "MockEmbeddingEngine",
    "NoopLLMEngine",
    "SQLiteRelationalStore",
]
