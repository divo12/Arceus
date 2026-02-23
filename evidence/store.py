"""Evidence store: repo-consistent persistence for evidence items (trust & audit oriented)."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

EVIDENCE_STORE_PATH = Path("data/state/evidence_store.json")
CLAIMS_PATH = Path("data/state/claims.json")


def _idempotency_key(source_system: str, source_id: str, source_version: str = "") -> str:
    """Stable key for deduplication."""
    raw = f"{source_system}:{source_id}:{source_version}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _read_json(workspace: Path, rel_path: Path, default: dict) -> dict:
    path = workspace / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        return default
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else default
    except (json.JSONDecodeError, OSError):
        return default


def _write_json(workspace: Path, rel_path: Path, data: dict) -> None:
    path = workspace / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def upsert_evidence(
    workspace: Path,
    *,
    uri: str,
    source_system: str,
    source_id: str,
    source_version: str = "",
    title: str = "",
    type: str = "evidence",
    content_hash: str = "",
    parser_version: str = "",
    chunker_version: str = "",
    chunk_ids: list[str] | None = None,
    scope: str = "",
    metadata: dict | None = None,
) -> str:
    """
    Upsert an evidence item. Idempotent on (source_system, source_id, source_version).

    Returns:
        evidence_id (stable Arceus ID).
    """
    workspace = Path(workspace).expanduser().resolve()
    key = _idempotency_key(source_system, source_id, source_version)
    data = _read_json(workspace, EVIDENCE_STORE_PATH, {"version": 1, "items": {}, "by_key": {}})
    items = data.setdefault("items", {})
    by_key = data.setdefault("by_key", {})

    if key in by_key:
        eid = by_key[key]
        entry = items.get(eid, {})
        entry.update({
            "uri": uri,
            "title": title or entry.get("title", ""),
            "type": type,
            "source_version": source_version,
            "hash": content_hash or entry.get("hash", ""),
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "parser_version": parser_version or entry.get("parser_version", ""),
            "chunker_version": chunker_version or entry.get("chunker_version", ""),
            "chunk_ids": chunk_ids or entry.get("chunk_ids", []),
            "scope": scope or entry.get("scope", ""),
            "metadata": metadata or entry.get("metadata", {}),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
        items[eid] = entry
    else:
        eid = f"EVD-{key}"
        items[eid] = {
            "id": eid,
            "uri": uri,
            "title": title,
            "type": type,
            "source_system": source_system,
            "source_id": source_id,
            "source_version": source_version,
            "hash": content_hash,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "parser_version": parser_version,
            "chunker_version": chunker_version,
            "chunk_ids": chunk_ids or [],
            "scope": scope,
            "metadata": metadata or {},
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        by_key[key] = eid

    _write_json(workspace, EVIDENCE_STORE_PATH, data)
    return eid


def get_evidence(workspace: Path, evidence_id: str) -> dict | None:
    """Get a single evidence item by ID."""
    workspace = Path(workspace).expanduser().resolve()
    data = _read_json(workspace, EVIDENCE_STORE_PATH, {"items": {}})
    return data.get("items", {}).get(evidence_id)


def list_evidence(workspace: Path, limit: int = 100) -> list[dict]:
    """List evidence items (most recently updated first)."""
    workspace = Path(workspace).expanduser().resolve()
    data = _read_json(workspace, EVIDENCE_STORE_PATH, {"items": {}})
    items = list(data.get("items", {}).values())
    items.sort(key=lambda x: x.get("updated_at", "") or x.get("created_at", ""), reverse=True)
    return items[:limit]


def add_claim(
    workspace: Path,
    *,
    claim: str,
    evidence_chunk_ids: list[str],
    confidence: float,
    decision_id: str = "",
) -> str:
    """
    Add a claim to the claims ledger. Returns claim_id.
    """
    workspace = Path(workspace).expanduser().resolve()
    data = _read_json(workspace, CLAIMS_PATH, {"version": 1, "claims": []})
    claims = data.setdefault("claims", [])
    claim_id = f"CLM-{len(claims) + 1:06d}"
    claims.append({
        "id": claim_id,
        "claim": claim,
        "evidence_chunk_ids": evidence_chunk_ids,
        "confidence": confidence,
        "decision_id": decision_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    _write_json(workspace, CLAIMS_PATH, data)
    return claim_id


def list_claims(workspace: Path, decision_id: str = "", limit: int = 50) -> list[dict]:
    """List claims, optionally filtered by decision_id."""
    workspace = Path(workspace).expanduser().resolve()
    data = _read_json(workspace, CLAIMS_PATH, {"claims": []})
    claims = data.get("claims", [])
    if decision_id:
        claims = [c for c in claims if c.get("decision_id") == decision_id]
    return claims[-limit:][::-1]
