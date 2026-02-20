"""Centralized logger with file sink. All logs stored in workspace/.arceus/logs/."""

from pathlib import Path
from typing import Optional

from loguru import logger

_LOG_SINK_ID: Optional[int] = None


def configure_logging(workspace: Path) -> Path:
    """
    Add file sink for all logs. Logs written to workspace/.arceus/logs/arceus.log.
    Call once at startup (e.g. from main.py).

    Returns:
        Path to the log file.
    """
    global _LOG_SINK_ID

    if _LOG_SINK_ID is not None:
        logger.remove(_LOG_SINK_ID)

    log_dir = Path(workspace).expanduser().resolve() / ".arceus" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "arceus.log"

    _LOG_SINK_ID = logger.add(
        log_file,
        rotation="10 MB",
        retention="7 days",
        level="DEBUG",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}",
    )

    return log_file
