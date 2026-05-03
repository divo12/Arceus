#!/usr/bin/env bash
# tools/churn-analysis.sh — git-based hotspot ranker.
#
# Lists files by commit churn over a window. High-churn files are
# refactor candidates: changes concentrate where the design is wrong.
#
# Usage:
#   tools/churn-analysis.sh              # default: last 90 days, top 20
#   tools/churn-analysis.sh 30 10        # last 30 days, top 10
#   tools/churn-analysis.sh 90 20 apps/api/src   # filter to subtree
#
# Exit code: 0 always (informational tool, never fails CI).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

DAYS="${1:-90}"
LIMIT="${2:-20}"
PATH_FILTER="${3:-}"

echo "Churn analysis — last $DAYS days, top $LIMIT files"
[[ -n "$PATH_FILTER" ]] && echo "  scoped to: $PATH_FILTER"
echo ""

# Strategy:
#   1. git log --name-only over the window
#   2. Filter out blank lines and commit-header lines
#   3. Optionally filter to a subtree
#   4. Count occurrences per file
#   5. Sort descending, head -LIMIT
#   6. Cross-reference with current LoC for context

CHURN=$(git log --since="$DAYS days ago" --name-only --pretty=format: \
  | grep -v '^$' \
  | { [[ -n "$PATH_FILTER" ]] && grep "^${PATH_FILTER}" || cat; } \
  | sort | uniq -c \
  | sort -rn \
  | head -n "$LIMIT")

# Pretty-print with current LoC.
printf "  %-7s %-7s %s\n" "COMMITS" "LINES" "FILE"
printf "  %-7s %-7s %s\n" "-------" "-----" "----"

while read -r line; do
  count=$(echo "$line" | awk '{print $1}')
  file=$(echo "$line" | awk '{print $2}')
  if [[ -f "$file" ]]; then
    loc=$(wc -l < "$file" 2>/dev/null | tr -d ' ')
  else
    loc="(deleted)"
  fi
  printf "  %-7s %-7s %s\n" "$count" "$loc" "$file"
done <<< "$CHURN"

echo ""
echo "Hotspots (high churn + high LoC) are refactor candidates."
echo "See plans/specs/34-folder-restructure-v3.md for current decomposition plan."
