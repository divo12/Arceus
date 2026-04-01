from arceus.core.hippocampus.backends.llm_engine import (
    AzureOpenAILLMEngine,
    has_azure_openai_credentials,
)
from arceus.core.hippocampus.backends.pgvector_store import PGVectorStore
from arceus.core.hippocampus.backends.postgres_relational import PostgreSQLRelationalStore
from arceus.core.hippocampus.backends.protocols import (
    EmbeddingEngine,
    LLMEngine,
    RelationalStore,
    VectorStore,
    WorkingMemoryBackend,
)
from arceus.core.hippocampus.backends.redis_cache import RedisCacheStore
from arceus.core.hippocampus.backends.sentence_transformers_embedding import (
    SentenceTransformerEmbeddingEngine,
)
from arceus.core.hippocampus.config import HippocampusConfig


def create_vector_store(backend: str, config: HippocampusConfig) -> VectorStore:
    if backend == "pgvector":
        return PGVectorStore(
            url=config.postgres_url,
            schema=config.postgres_schema,
            vector_index_type=config.vector_index_type,
            top_k_fetch_multiplier=config.vector_top_k_fetch_multiplier,
            dimensions=config.embedding_dimensions,
        )
    raise ValueError(f"Unsupported vector store backend: {backend}")


def create_cache(backend: str, config: HippocampusConfig) -> WorkingMemoryBackend:
    if backend == "redis":
        return RedisCacheStore(redis_url=config.redis_url)
    raise ValueError(f"Unsupported cache backend: {backend}")


def create_relational(backend: str, config: HippocampusConfig) -> RelationalStore:
    if backend == "postgresql":
        return PostgreSQLRelationalStore(
            url=config.postgres_url,
            schema=config.postgres_schema,
        )
    raise ValueError(f"Unsupported relational backend: {backend}")


def create_embedding_engine(
    backend: str,
    dimensions: int,
    *,
    device: str = "cpu",
    strict: bool = False,
) -> EmbeddingEngine:
    if not backend:
        raise ValueError("Embedding backend must not be empty")
    return SentenceTransformerEmbeddingEngine(
        model_name=backend,
        device=device,
        dimensions=dimensions,
        strict=strict,
    )


def create_llm_engine(model_name: str, config: HippocampusConfig) -> LLMEngine:
    if has_azure_openai_credentials(azure_endpoint=config.azure_openai_endpoint):
        return AzureOpenAILLMEngine(
            model_name=model_name,
            azure_endpoint=config.azure_openai_endpoint,
            api_version=config.azure_openai_api_version,
        )
    raise ValueError(
        f"LLM model {model_name!r} requires Azure OpenAI credentials. "
        "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY."
    )
