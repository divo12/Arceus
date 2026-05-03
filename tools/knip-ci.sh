#!/usr/bin/env bash
# tools/knip-ci.sh — CI gate for dead-code regressions.
#
# Runs knip and compares the total signal count to the baseline stored
# in tools/knip-baseline.json. Fails the CI job if the count INCREASES;
# tolerates decreases (and updates the baseline locally if the
# `--update` flag is passed).
#
# Why a baseline instead of zero? PR 3 cleared most signals but
# ~70 remain — DI-injected helpers (knip false positives), future-state
# resilience primitives, web2 mockup schemas not yet consumed, etc.
# Forcing them to zero would block legitimate work. The baseline keeps
# us honest going forward without blocking the present.
#
# Usage:
#   tools/knip-ci.sh              # check (CI mode)
#   tools/knip-ci.sh --update     # rebaseline (after intentional cleanup)
#
# Exit codes:
#   0 = signals ≤ baseline
#   1 = signals > baseline (regression)
#   2 = baseline file missing or unreadable

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BASELINE_FILE="tools/knip-baseline.json"
UPDATE=0
[[ "${1:-}" == "--update" ]] && UPDATE=1

if [[ ! -f "$BASELINE_FILE" ]] && [[ "$UPDATE" -eq 0 ]]; then
  echo "✗ Baseline file missing: $BASELINE_FILE" >&2
  echo "  Run 'tools/knip-ci.sh --update' once to seed it." >&2
  exit 2
fi

# Run knip and parse the summary line counts.
#
# Knip's summary lines look like:
#   Unused files (38)
#   Unused exports (11)
#   Unused exported types (17)
#   Duplicate exports (2)
SUMMARY=$(npx knip --reporter compact 2>&1 | grep -E "Unused (files|exports|exported types|dependencies|devDependencies)|Duplicate exports" || true)

count_metric() {
  local label="$1"
  local count
  count=$(echo "$SUMMARY" | grep -E "^${label} \(" | sed -E 's/.*\(([0-9]+)\)/\1/' | head -1)
  echo "${count:-0}"
}

CURRENT_FILES=$(count_metric "Unused files")
CURRENT_EXPORTS=$(count_metric "Unused exports")
CURRENT_TYPES=$(count_metric "Unused exported types")
CURRENT_DEPS=$(count_metric "Unused dependencies")
CURRENT_DEV_DEPS=$(count_metric "Unused devDependencies")
CURRENT_DUPS=$(count_metric "Duplicate exports")

CURRENT_TOTAL=$((CURRENT_FILES + CURRENT_EXPORTS + CURRENT_TYPES + CURRENT_DEPS + CURRENT_DEV_DEPS + CURRENT_DUPS))

if [[ "$UPDATE" -eq 1 ]]; then
  cat > "$BASELINE_FILE" <<EOF
{
  "files": $CURRENT_FILES,
  "exports": $CURRENT_EXPORTS,
  "types": $CURRENT_TYPES,
  "dependencies": $CURRENT_DEPS,
  "devDependencies": $CURRENT_DEV_DEPS,
  "duplicates": $CURRENT_DUPS,
  "total": $CURRENT_TOTAL
}
EOF
  echo "✓ Baseline written → $BASELINE_FILE"
  echo "  files=$CURRENT_FILES exports=$CURRENT_EXPORTS types=$CURRENT_TYPES deps=$CURRENT_DEPS dev=$CURRENT_DEV_DEPS dups=$CURRENT_DUPS total=$CURRENT_TOTAL"
  exit 0
fi

# Read baseline. Tolerate missing fields → 0.
BASE_TOTAL=$(jq -r '.total // 0' "$BASELINE_FILE" 2>/dev/null || echo 0)

echo "Knip signal totals:"
echo "  files=$CURRENT_FILES exports=$CURRENT_EXPORTS types=$CURRENT_TYPES deps=$CURRENT_DEPS dev=$CURRENT_DEV_DEPS dups=$CURRENT_DUPS"
echo "  current=$CURRENT_TOTAL  baseline=$BASE_TOTAL"

if [[ "$CURRENT_TOTAL" -gt "$BASE_TOTAL" ]]; then
  echo ""
  echo "✗ Knip regression: $CURRENT_TOTAL > $BASE_TOTAL (+$((CURRENT_TOTAL - BASE_TOTAL)))" >&2
  echo ""
  echo "  New dead exports were introduced. Either fix them, or if intentional," >&2
  echo "  rebaseline with: tools/knip-ci.sh --update" >&2
  exit 1
fi

if [[ "$CURRENT_TOTAL" -lt "$BASE_TOTAL" ]]; then
  echo ""
  echo "✓ Knip improved: $CURRENT_TOTAL < $BASE_TOTAL ($((BASE_TOTAL - CURRENT_TOTAL)) cleared)"
  echo "  Consider running 'tools/knip-ci.sh --update' to lock in the gain."
else
  echo ""
  echo "✓ Knip stable at $CURRENT_TOTAL"
fi
