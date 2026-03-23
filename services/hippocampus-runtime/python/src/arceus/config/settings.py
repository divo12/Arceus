from pathlib import Path

from dotenv import load_dotenv
from pydantic import SecretStr
from pydantic_settings import BaseSettings

_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"
load_dotenv(_ENV_FILE, override=True)


class Settings(BaseSettings):
    model_config = {
        "env_prefix": "ARCEUS_",
        "env_file": str(_ENV_FILE),
        "extra": "ignore",
    }

    debug: bool = False
    database_url: str = ""

    redis_url: str = "redis://localhost:6379/0"
    hippocampus_postgres_url: str = ""
    hippocampus_postgres_schema: str = "hippocampus"
    hippocampus_redis_url: str = ""
    hippocampus_vector_index_type: str = "hnsw"
    hippocampus_vector_top_k_fetch_multiplier: int = 3

    azure_openai_endpoint: str = ""
    azure_openai_api_key: SecretStr = SecretStr("")
    azure_openai_api_version: str = "2025-03-01-preview"

    neo4j_uri: str = ""
    neo4j_username: str = ""
    neo4j_password: SecretStr = SecretStr("")
    neo4j_database: str = "neo4j"


settings = Settings()
