from datetime import UTC, datetime


def utc_now() -> datetime:
    return datetime.now(UTC)


def parse_utc_iso(value: str) -> datetime:
    """Parse an ISO-8601 string and ensure it is timezone-aware (UTC)."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)
