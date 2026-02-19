#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  echo "Usage: scripts/run_local.sh <setup|smoke|test|lint>"
}

if [ $# -ne 1 ]; then
  usage
  exit 1
fi

case "$1" in
  setup)
    uv venv --python 3.11 .venv
    uv sync
    ;;
  smoke)
    uv run python --version
    uv run python -m unittest tests/agents/test_skills.py
    uv run python -m unittest tests/cognition/test_cognition.py
    uv run python -m unittest tests/cognition/test_prompt_integration.py
    ;;
  test)
    uv run python -m unittest discover -s tests -t . -p "test_*.py"
    ;;
  lint)
    uv run python -m compileall agents cognition execution tests
    ;;
  *)
    usage
    exit 1
    ;;
esac
