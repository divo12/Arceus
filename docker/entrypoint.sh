#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] Starting OpenCode server on port 4098..."
opencode serve --hostname 127.0.0.1 --port 4098 &
OPENCODE_PID=$!

cleanup() {
  if kill -0 "${OPENCODE_PID}" >/dev/null 2>&1; then
    kill "${OPENCODE_PID}" >/dev/null 2>&1 || true
    wait "${OPENCODE_PID}" || true
  fi
}

trap cleanup EXIT INT TERM

for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4098/config >/dev/null 2>&1; then
    echo "[entrypoint] OpenCode server ready"
    break
  fi
  if [ "${i}" -eq 30 ]; then
    echo "[entrypoint] WARNING: OpenCode server did not become ready within 15 seconds"
  fi
  sleep 0.5
done

echo "[entrypoint] Starting Arceus server on port ${PORT:-3100}..."
exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
