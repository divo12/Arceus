#!/usr/bin/env python3
"""
Artifact generator CLI: produce markdown artifacts from structured input.

Usage:
  uv run python scripts/arceus_artifacts.py --kind decision_record --input input.json
  uv run python scripts/arceus_artifacts.py --kind evidence_brief --input input.json --output docs/
  uv run python scripts/arceus_artifacts.py --kind options_set --input input.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from artifacts.renderer import (
    render_decision_record,
    render_evidence_brief,
    render_options_set,
)


def _load_input(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate markdown artifacts (decision_record, evidence_brief, options_set)."
    )
    parser.add_argument(
        "--kind",
        required=True,
        choices=["decision_record", "evidence_brief", "options_set"],
        help="Artifact type.",
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to JSON input.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output directory (default: docs/ or pm_ideas/).",
    )
    parser.add_argument(
        "--workspace",
        default=str(ROOT),
        help="Workspace root.",
    )
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    payload = _load_input(Path(args.input).resolve())

    renderers = {
        "decision_record": render_decision_record,
        "evidence_brief": render_evidence_brief,
        "options_set": render_options_set,
    }
    content = renderers[args.kind](payload)

    out_dir = Path(args.output) if args.output else (workspace / "docs")
    out_dir = Path(out_dir) if not out_dir.is_absolute() else out_dir
    if not out_dir.is_absolute():
        out_dir = workspace / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    slug = args.kind.replace("_", "-")
    title = payload.get("title", payload.get("topic", "artifact"))
    safe_title = "".join(c if c.isalnum() or c in " -_" else "-" for c in str(title))[:50]
    out_path = out_dir / f"{slug}_{safe_title.strip()}.md"
    out_path.write_text(content, encoding="utf-8")
    print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
