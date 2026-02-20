"""Application settings loaded from environment variables."""

import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    # ========================================
    # Database Configuration
    # ========================================
    MONGODB_CREDENTIALS_DEV = os.getenv("MONGODB_CREDENTIALS_DEV")
    MONGODB_CREDENTIALS_PROD = os.getenv("MONGODB_CREDENTIALS_PROD")

    # Database Names
    WEB_CRAWLER_DB = "web_crawler"
    FLUX_PROD_DB = "flux_prod"

    # Collections
    MANUAL_DEEP_TRIGGERS_COLLECTION = "manual_deep_triggers"
    MANUAL_DEEP_TRIGGERS_TEST_COLLECTION = "manual_deep_triggers_test"
    COLLECTION_DATA_CHANNEL_MESSAGES = "data_channel_messages"
    COLLECTION_LEADS = "leads"
    COLLECTION_CORESIGNAL_COMPANY_PROFILES = "coresignal_company_profiles"
    COLLECTION_THEIRSTACK_COMPANY_PROFILES = "theirstack_company_profiles"
    INCUBATOR_LEADS_COLLECTION = "incubator_leads"
    SALES_COMPETITOR_ENGAGEMENTS_COLLECTION = "sales_competitor_engagements"
    ICP_COMPETITOR_INTERACTIONS_COLLECTION = "icp_competitor_interactions"

    # ========================================
    # AWS Configuration
    # ========================================
    AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
    AWS_REGION = os.getenv("AWS_REGION")

    # ========================================
    # AI & LLM Configuration
    # ========================================
    AZURE_OPENAI_API_KEY = os.getenv("AZURE_OPENAI_API_KEY")
    AZURE_OPENAI_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "")
    AZURE_OPENAI_DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5.2")

    # ========================================
    # Search Engine Configuration
    # ========================================
    GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
    GOOGLE_SEARCH_ENGINE_ID = os.getenv("GOOGLE_SEARCH_ENGINE_ID")
    SEARCHAPI_API_KEY = os.getenv("SEARCHAPI_API_KEY")
    EXA_API_KEY = os.getenv("EXA_API_KEY")

    # GEMINI / VERTEX AI CONFIG
    GCP_GEMINI_API_KEY = os.getenv("GCP_GEMINI_API_KEY")
    GCP_PROJECT_ID = "testproject-453916"
    GCP_LOCATION = "us-central1"

    # ========================================
    # External API Keys - Data Providers
    # ========================================
    THEIRSTACK_API_KEY = os.getenv("THEIRSTACK_API_KEY")
    PDL_API_KEY = os.getenv("PDL_API_KEY")
    CORESIGNAL_API_KEY = os.getenv("CORESIGNAL_API_KEY")
    BUILTWITH_API_KEY = os.getenv("BUILTWITH_API_KEY")
    APOLLO_API_KEY = os.getenv("APOLLO_API_KEY")
    INTELLIZENCE_API_KEY = os.getenv("INTELLIZENCE_API_KEY")
    SEMRUSH_API_KEY = os.getenv("SEMRUSH_API_KEY")

    # ========================================
    # External API Keys - RapidAPI
    # ========================================
    RAPIDAPI_API_KEY = os.getenv("RAPIDAPI_API_KEY")
    RAPIDAPI_API_KEY_1 = os.getenv("RAPIDAPI_API_KEY_1")
    RAPIDAPI_TWITTER_V1_KEY = os.getenv("RAPIDAPI_TWITTER_V1_KEY")

    # ========================================
    # External API Keys - Social Media
    # ========================================
    TWITTER_ENTERPRISE_PROVIDER_API_KEY = os.getenv(
        "TWITTER_ENTERPRISE_PROVIDER_API_KEY"
    )
    RAPIDAPI_FACEBOOK_KEY = os.getenv("RAPIDAPI_FACEBOOK_KEY")

    # ========================================
    # MongoDB Optimizer
    # ========================================
    MONGODB_OPTIMIZER_URI = os.getenv("MONGODB_OPTIMIZER_URI")

    # ========================================
    # Logging Configuration
    # ========================================
    LOGGING_LEVEL = "DEBUG"

    # Collection names
    OPTIMIZATION_LOGS_COLLECTION = "optimization_dashboard_logs"
    STRATEGY_LOGS_COLLECTION = "strategy_optimization_logs"
