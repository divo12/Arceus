from __future__ import annotations

import sys
from pathlib import Path


RUNTIME_SRC = Path(__file__).resolve().parents[1] / "python" / "src"
if str(RUNTIME_SRC) not in sys.path:
    sys.path.insert(0, str(RUNTIME_SRC))


def test_runtime_exports_import() -> None:
    from arceus.core.hippocampus import HippocampusConfig, MemoryType

    config = HippocampusConfig()

    assert config.vector_store_backend == "pgvector"
    assert MemoryType.DYNAMIC.value == "dynamic"


def test_runtime_settings_shim_loads() -> None:
    from arceus.config.settings import settings

    assert settings.hippocampus_postgres_schema == "hippocampus"
