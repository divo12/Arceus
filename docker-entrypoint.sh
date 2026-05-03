#!/bin/sh
# ─────────────────────────────────────────────────────────────────
# Arceus API container entrypoint.
# Seeds OpenCode's auth.json with the configured Azure endpoint BEFORE
# the API process starts. OpenCode's azure provider otherwise builds
# URLs as https://{AZURE_RESOURCE_NAME}.openai.azure.com/... — wrong
# for Azure AI Foundry endpoints (*.cognitiveservices.azure.com).
# ─────────────────────────────────────────────────────────────────
set -e

if [ -n "$ARCEUS_AZURE_OPENAI_API_KEY" ] && [ -n "$ARCEUS_AZURE_OPENAI_ENDPOINT" ]; then
  AUTH_DIR="$HOME/.local/share/opencode"
  mkdir -p "$AUTH_DIR"
  # Strip trailing slash from endpoint
  ENDPOINT="${ARCEUS_AZURE_OPENAI_ENDPOINT%/}"
  cat > "$AUTH_DIR/auth.json" <<EOF
{
  "azure": {
    "type": "api",
    "key": "$ARCEUS_AZURE_OPENAI_API_KEY"
  }
}
EOF
  chmod 600 "$AUTH_DIR/auth.json"

  # Override OpenCode's azure provider with the explicit endpoint so the
  # @ai-sdk/azure provider uses our cognitiveservices.azure.com URL
  # instead of building https://{resource}.openai.azure.com/... by default.
  CONFIG_DIR="$HOME/.config/opencode"
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "azure": {
      "options": {
        "baseURL": "$ENDPOINT/openai",
        "apiVersion": "preview"
      }
    }
  }
}
EOF
  echo "[entrypoint] OpenCode auth + provider override seeded (baseURL=$ENDPOINT/openai)"
fi

exec "$@"
