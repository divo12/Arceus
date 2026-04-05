from pathlib import Path

from dotenv import load_dotenv
from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings

_ENV_FILE = Path(__file__).resolve().parents[6] / ".env"
load_dotenv(_ENV_FILE, override=False)


class Settings(BaseSettings):
    model_config = {
        "env_prefix": "ARCEUS_",
        "env_file": str(_ENV_FILE),
        "extra": "ignore",
    }

    debug: bool = False
    database_url: str = ""

    redis_url: str = Field(
        default="redis://localhost:6379/0",
        validation_alias=AliasChoices("ARCEUS_REDIS_URL", "REDIS_URL"),
    )
    hippocampus_postgres_url: str = ""
    hippocampus_postgres_schema: str = "public"
    hippocampus_redis_url: str = Field(
        default="",
        validation_alias=AliasChoices(
            "ARCEUS_HIPPOCAMPUS_REDIS_URL",
            "ARCEUS_REDIS_URL",
            "REDIS_URL",
        ),
    )
    hippocampus_vector_index_type: str = "hnsw"
    hippocampus_vector_top_k_fetch_multiplier: int = 3

    azure_openai_endpoint: str = ""
    azure_openai_api_key: SecretStr = SecretStr("")
    azure_openai_api_version: str = "2025-03-01-preview"


settings = Settings()
