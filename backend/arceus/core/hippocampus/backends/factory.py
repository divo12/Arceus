from arceus.core.hippocampus.backends.dict_cache import DictCacheStore
from arceus.core.hippocampus.backends.in_memory_graph import InMemoryGraphStoreBackend
from arceus.core.hippocampus.backends.in_memory_vector import InMemoryVectorStore
from arceus.core.hippocampus.backends.noop_llm import NoopLLMEngine
from arceus.core.hippocampus.backends.protocols import EmbeddingEngine, GraphStoreBackend, LLMEngine
from arceus.core.hippocampus.backends.sentence_transformers_embedding import (
    SentenceTransformerEmbeddingEngine,
)
from arceus.core.hippocampus.backends.simple_embedding import MockEmbeddingEngine
from arceus.core.hippocampus.backends.sqlite_relational import SQLiteRelationalStore
from arceus.core.hippocampus.config import HippocampusConfig


def create_vector_store(backend: str, config: HippocampusConfig) -> InMemoryVectorStore:
    if backend == "in_memory":
        return InMemoryVectorStore()
    raise ValueError(f"Unsupported vector store backend: {backend}")


def create_cache(backend: str, config: HippocampusConfig) -> DictCacheStore:
    if backend == "dict":
        return DictCacheStore()
    raise ValueError(f"Unsupported cache backend: {backend}")


def create_relational(backend: str, config: HippocampusConfig) -> SQLiteRelationalStore:
    if backend == "sqlite":
        return SQLiteRelationalStore(config.sqlite_path)
    raise ValueError(f"Unsupported relational backend: {backend}")


def create_graph_store(backend: str, config: HippocampusConfig) -> GraphStoreBackend:
    del config
    if backend == "in_memory":
        return InMemoryGraphStoreBackend()
    if backend == "neo4j":
        raise ValueError("Neo4j backend not yet implemented, use 'in_memory'")
    raise ValueError(f"Unsupported graph backend: {backend}")


def create_embedding_engine(
    backend: str,
    dimensions: int,
) -> EmbeddingEngine:
    if backend == "simple":
        return MockEmbeddingEngine(dimensions=dimensions)
    if backend == "all-MiniLM-L6-v2":
        return SentenceTransformerEmbeddingEngine(model_name=backend)
    raise ValueError(f"Unsupported embedding backend: {backend}")


def create_llm_engine(model_name: str) -> LLMEngine:
    return NoopLLMEngine(model_name=model_name)
