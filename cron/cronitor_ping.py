"""Cronitor telemetry ping integration for Arceus cron jobs."""

import os
from typing import Optional

import httpx

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

CRONITOR_BASE = "https://cronitor.link/p"


def _get_api_key() -> str:
    """Get Cronitor API key from env or config."""
    return os.environ.get("CRONITOR_API_KEY", "")


def _monitor_key(job_id: str, job_name: str) -> str:
    """Build a Cronitor monitor key from job id and name."""
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in job_name[:30])
    return f"arceus-{job_id}-{safe_name}".strip("-")


async def ping(
    job_id: str,
    job_name: str,
    state: str,
    *,
    message: Optional[str] = None,
    duration_seconds: Optional[float] = None,
    series: Optional[str] = None,
) -> bool:
    """
    Send a telemetry ping to Cronitor.

    Args:
        job_id: Arceus job ID.
        job_name: Job display name.
        state: One of 'run', 'complete', 'fail'.
        message: Optional error/message (for fail).
        duration_seconds: Optional duration (for complete).
        series: Optional series ID to correlate run/complete.

    Returns:
        True if ping succeeded, False otherwise.
    """
    api_key = _get_api_key()
    if not api_key:
        return False

    monitor_key = _monitor_key(job_id, job_name)
    url = f"{CRONITOR_BASE}/{api_key}/{monitor_key}"
    params = {"state": state}
    if message:
        params["message"] = message[:2000]
    if duration_seconds is not None:
        params["metric"] = f"duration:{duration_seconds:.1f}"
    if series:
        params["series"] = series

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url, params=params)
            return r.status_code == 200
    except Exception:
        return False
