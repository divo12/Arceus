from __future__ import annotations

from arceus.core.hippocampus.runtime import (
    HippocampusRuntimeServer,
    JSONRPC_VERSION,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    TEST_PROFILE,
    main,
)

__all__ = [
    "HippocampusRuntimeServer",
    "INTERNAL_ERROR",
    "INVALID_PARAMS",
    "INVALID_REQUEST",
    "JSONRPC_VERSION",
    "METHOD_NOT_FOUND",
    "PARSE_ERROR",
    "TEST_PROFILE",
    "main",
]


if __name__ == "__main__":
    raise SystemExit(main())
