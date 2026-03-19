from dataclasses import dataclass


@dataclass(slots=True)
class HippocampusConfig:
    # Backends
    vector_store_backend: str = "in_memory"
    graph_store_backend: str = "neo4j"
    cache_backend: str = "dict"
    relational_backend: str = "sqlite"
    sqlite_path: str = "hippocampus.db"
    neo4j_uri: str = ""
    neo4j_username: str = ""
    neo4j_password: str = ""
    neo4j_database: str = "neo4j"

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
    embedding_dimensions: int = 384
    embedding_device: str = "cpu"

    # Azure OpenAI
    azure_openai_endpoint: str = ""
    azure_openai_api_version: str = "2024-12-01-preview"
    azure_openai_deployment_reasoning: str = "gpt-4.1"
    azure_openai_deployment_lightweight: str = "gpt-4.1-mini"

    # LLM
    reasoning_model: str = "gpt-4.1"
    lightweight_model: str = "gpt-4.1-mini"
