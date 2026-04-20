#!/usr/bin/env bash
# mcp-smoke.sh — minimal curl-based smoke test for the internal MCP API.
#
# Usage:
#   BASE_URL=http://localhost:3001 \
#   ARCEUS_INTERNAL_TOKEN=dev-token \
#   ./scripts/mcp-smoke.sh
#
# Exits non-zero on the first failed assertion. Depends on curl + jq + uuidgen.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
TOKEN="${ARCEUS_INTERNAL_TOKEN:-${ARCEUS_TOKEN:-}}"
COMPANY_ID="${COMPANY_ID:-c_smoke}"
BEAT_ID="${BEAT_ID:-beat_smoke_$(date +%s)}"

if [[ -z "${TOKEN}" ]]; then
  echo "FATAL: ARCEUS_INTERNAL_TOKEN (or ARCEUS_TOKEN) must be set." >&2
  exit 2
fi
for bin in curl jq uuidgen; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FATAL: missing dependency: $bin" >&2; exit 2; }
done

pass=0
fail=0

# ── helpers ──────────────────────────────────────────────

_req() {
  # _req METHOD PATH ROLE IDEMPOTENCY_KEY BODY_JSON
  local method="$1" path="$2" role="$3" idem="$4" body="$5"
  curl -sS -o /tmp/mcp_body.$$ -w "%{http_code}" \
    -X "$method" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-beat-id: ${BEAT_ID}" \
    -H "x-company-id: ${COMPANY_ID}" \
    -H "x-agent-role: ${role}" \
    -H "Idempotency-Key: ${idem}" \
    -H "Content-Type: application/json" \
    --data "${body:-{}}" \
    "${BASE_URL}${path}"
}

assert_status() {
  # assert_status LABEL EXPECTED_STATUS ACTUAL_STATUS
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS  $label  (${actual})"
    pass=$((pass + 1))
  else
    echo "  FAIL  $label  expected=${expected} actual=${actual}"
    echo "        body: $(cat /tmp/mcp_body.$$ 2>/dev/null | head -c 400)"
    fail=$((fail + 1))
  fi
}

run_case() {
  # run_case LABEL EXPECTED_STATUS METHOD PATH ROLE BODY_JSON
  local label="$1" expected="$2" method="$3" path="$4" role="$5" body="${6:-{}}"
  local idem; idem="$(uuidgen)"
  local actual; actual="$(_req "$method" "$path" "$role" "$idem" "$body")"
  assert_status "$label" "$expected" "$actual"
}

# ── cases ────────────────────────────────────────────────

echo "Arceus MCP smoke → ${BASE_URL}"
echo "----------------------------------------------------------------"

# Auth
echo "[auth]"
actual="$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  --data '{}' \
  "${BASE_URL}/api/internal/v1/tasks")"
assert_status "POST /tasks without bearer → 401" 401 "$actual"

# Validation
echo "[validation]"
run_case "POST /tasks missing title → 422" 422 \
  POST /api/internal/v1/tasks developer '{}'

run_case "POST /artifacts bad kind → 422" 422 \
  POST /api/internal/v1/artifacts developer \
  '{"agent":"dev","kind":"banana","title":"x","content":"y"}'

run_case "POST /meetings bad type → 422" 422 \
  POST /api/internal/v1/meetings ceo \
  '{"type":"invalid","facilitatorRole":"ceo","participantRoles":["ceo"],"summary":"x","agenda":[]}'

run_case "POST /approvals unknown type → 422" 422 \
  POST /api/internal/v1/approvals developer \
  '{"type":"mystery","requestedByRole":"marketing","title":"x","description":"y"}'

run_case "POST /workspaces/preview-probes bad timeout → 422" 422 \
  POST /api/internal/v1/workspaces/preview-probes developer \
  '{"timeoutMs":50}'

# Not-found
echo "[not-found]"
run_case "POST /tasks/:id/completion on missing → 404" 404 \
  POST /api/internal/v1/tasks/tsk_smoke_missing/completion developer '{}'

# Governance
echo "[governance]"
run_case "POST /tasks/:id/verification as developer → 403" 403 \
  POST /api/internal/v1/tasks/tsk_whatever/verification developer \
  '{"verifiedBy":"agent_q"}'

run_case "POST /sprints/proposals as developer → 403" 403 \
  POST /api/internal/v1/sprints/proposals developer '{}'

# Happy path (creates)
echo "[happy-path]"
TASK_ID="tsk_smoke_$(uuidgen | tr -d '-' | head -c 10)"
run_case "POST /tasks creates → 201" 201 \
  POST /api/internal/v1/tasks developer \
  "{\"id\":\"${TASK_ID}\",\"title\":\"smoke task\"}"

run_case "POST /artifacts creates → 201" 201 \
  POST /api/internal/v1/artifacts developer \
  '{"agent":"developer","kind":"code","title":"snippet","content":"console.log(1);"}'

run_case "POST /meetings records → 201" 201 \
  POST /api/internal/v1/meetings ceo \
  '{"type":"daily_sync","facilitatorRole":"ceo","participantRoles":["ceo","cto"],"summary":"sync","agenda":[{"topic":"t","type":"update","content":"c","raisedByRole":"ceo"}]}'

# Async
echo "[async]"
run_case "POST /sprints/proposals as ceo → 202" 202 \
  POST /api/internal/v1/sprints/proposals ceo '{}'

# Idempotency replay
echo "[idempotency]"
REPLAY_ID="tsk_replay_$(uuidgen | tr -d '-' | head -c 10)"
REPLAY_KEY="$(uuidgen)"
REPLAY_BODY="{\"id\":\"${REPLAY_ID}\",\"title\":\"first\"}"
actual="$(_req POST /api/internal/v1/tasks developer "$REPLAY_KEY" "$REPLAY_BODY")"
assert_status "POST /tasks first call → 201" 201 "$actual"
actual="$(_req POST /api/internal/v1/tasks developer "$REPLAY_KEY" "$REPLAY_BODY")"
assert_status "POST /tasks same key+body replays → 201" 201 "$actual"
actual="$(_req POST /api/internal/v1/tasks developer "$REPLAY_KEY" "{\"id\":\"${REPLAY_ID}\",\"title\":\"different\"}")"
assert_status "POST /tasks same key different body → 409" 409 "$actual"

# ── summary ──────────────────────────────────────────────

echo "----------------------------------------------------------------"
echo "pass=${pass}  fail=${fail}"
rm -f /tmp/mcp_body.$$
[[ "$fail" -eq 0 ]]
