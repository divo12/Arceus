from arceus.core.hippocampus.backends.azure_openai_llm import (
    AzureOpenAILLMEngine,
    has_azure_openai_credentials,
)
from arceus.core.hippocampus.backends.dict_cache import DictCacheStore
from arceus.core.hippocampus.backends.in_memory_graph import InMemoryGraphStoreBackend
from arceus.core.hippocampus.backends.in_memory_vector import InMemoryVectorStore
from arceus.core.hippocampus.backends.neo4j_graph import (
    Neo4jGraphStoreBackend,
    has_neo4j_credentials,
)
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
    if backend == "in_memory":
        return InMemoryGraphStoreBackend()
    if backend == "neo4j":
        if not has_neo4j_credentials(
            uri=config.neo4j_uri,
            username=config.neo4j_username,
            password=config.neo4j_password,
        ):
            raise ValueError(
                "Neo4j backend requires credentials. Set NEO4J_URI, "
                "NEO4J_USERNAME, and NEO4J_PASSWORD or override HippocampusConfig."
            )
        return Neo4jGraphStoreBackend(
            uri=config.neo4j_uri,
            username=config.neo4j_username,
            password=config.neo4j_password,
            database=config.neo4j_database,
        )
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


def create_llm_engine(model_name: str, config: HippocampusConfig) -> LLMEngine:
    if model_name == "noop":
        return NoopLLMEngine(model_name=model_name)

    if has_azure_openai_credentials(azure_endpoint=config.azure_openai_endpoint):
        return AzureOpenAILLMEngine(
            model_name=model_name,
            azure_endpoint=config.azure_openai_endpoint,
            api_version=config.azure_openai_api_version,
        )
    raise ValueError(
        f"LLM model {model_name!r} requires Azure OpenAI credentials. "
        "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY or use model_name='noop'."
    )
