from pathlib import Path

from pydantic_settings import BaseSettings

_ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = {"env_prefix": "ARCEUS_", "env_file": str(_ENV_FILE), "extra": "ignore"}

    # App
    app_name: str = "Arceus"
    debug: bool = False

    # Database (SQLite for local dev, PostgreSQL for production)
    database_url: str = "sqlite+aiosqlite:///./arceus.db"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Celery
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    # Azure OpenAI
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_api_version: str = "2025-03-01-preview"

    # Model deployments
    model_ceo: str = "gpt-5"
    model_employee: str = "gpt-4.1-mini"
    model_spawned: str = "gpt-4.1-nano"
    model_embedding: str = "text-embedding-3-small"

    # Mem0
    mem0_url: str = "http://localhost:8080"

    # E2B
    e2b_api_key: str = ""

    # CORS
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:3003", "http://localhost:3004", "http://localhost:3005"]


settings = Settings()
