# Arceus Flow-Tester

Standalone browser-agent QA service. Give it a product URL + a goal; an
`browser-use` LLM agent drives a real Chromium, exercises the core user flow,
and returns a verdict (works? broken? god-tier or basic?) + a screenshot.

Runs as its OWN Railway service — the browser never touches the slim Arceus API
container (the reason the old in-container probe was removed).

## API
- `GET /health` → `{ "ok": true }`
- `POST /flow-test` `{ "url": "...", "goal"?: "...", "max_steps"?: 25 }`
  → `{ ok, is_successful, verdict, action_trace, final_url, screenshot_b64 }`
  Auth: `Authorization: Bearer $FLOW_TESTER_TOKEN`.

## Env
| Var | Purpose |
|-----|---------|
| `FLOW_TESTER_TOKEN` | shared secret the Arceus API sends as Bearer |
| `BROWSER_USE_LLM_MODEL` | vision-capable model the agent uses (e.g. `gpt-4o`, or an azure deployment) |
| provider creds | per the chosen model: `OPENAI_API_KEY`, or `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_VERSION` |
| `PORT` | set by Railway |

## Deploy on Railway (same project, private network)
1. New Service → **GitHub Repository** → `divo12/Arceus`.
2. Settings → **Root Directory** = `services/flow-tester` (it builds this Dockerfile).
3. Set the env vars above. No public domain needed — the Arceus API calls it at
   `http://<service-name>.railway.internal:8080`.

`browseruse_session.py` + `browseruse_core.py` are vendored from the eu-swarm
`browser-use` toolkit (the agentic browser layer); `app.py` is the thin wrapper.
