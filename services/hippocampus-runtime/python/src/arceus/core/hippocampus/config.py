from dataclasses import dataclass


@dataclass(slots=True)
class HippocampusConfig:
    # Backends
    vector_store_backend: str = "pgvector"
    cache_backend: str = "redis"
    relational_backend: str = "postgresql"
    postgres_url: str = ""
    postgres_schema: str = "hippocampus"
    redis_url: str = ""
    vector_index_type: str = "hnsw"
    vector_top_k_fetch_multiplier: int = 3

    # Memory tuning
    dynamic_memory_half_life_days: float = 30.0
    decay_threshold: float = 0.1
    gc_interval_hours: float = 6.0

    # Retrieval
    retrieval_k: int = 3
    mmr_lambda: float = 0.7
    static_boost: float = 1.5
    dynamic_boost: float = 1.0
    procedural_boost: float = 1.2
    task_scope_boost: float = 1.3

    # ReasoningBank
    distillation_threshold: float = 0.6

    # PatternLearner
    pattern_learning_rate: float = 0.1
    habit_usage_threshold: int = 10
    habit_success_threshold: float = 0.8

    # Promotion
    promotion_access_threshold: int = 10
    promotion_confidence_threshold: float = 0.8
    promotion_age_days: int = 14

    # Extraction
    extraction_frequency: str = "per_task_and_meeting"
    extraction_model: str = "gpt-4.1"

    # Embeddings
    embedding_model: str = "all-MiniLM-L6-v2"
    embedding_dimensions: int = 384  # must match embedding_model output size
    embedding_device: str = "cpu"
    embedding_strict: bool = False
    embedding_warmup: bool = False

    # Azure OpenAI
    azure_openai_endpoint: str = ""
    azure_openai_api_version: str = "2024-12-01-preview"
    azure_openai_deployment_reasoning: str = "gpt-4.1"
    azure_openai_deployment_lightweight: str = "gpt-4.1-mini"

    # LLM
    reasoning_model: str = "gpt-4.1"
    lightweight_model: str = "gpt-4.1-mini"
