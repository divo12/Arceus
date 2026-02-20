# Arceus Development Workflow (uv + Python 3.11)

## Prerequisites

- Install `uv` (https://docs.astral.sh/uv/getting-started/installation/).
- Use a shell on macOS/Linux with project root at `Arceus/`.

## One-command setup

From project root:

```bash
scripts/run_local.sh setup
```

This command:
- creates `.venv` pinned to Python 3.11
- syncs dependencies from `pyproject.toml` using `uv sync`

## Daily commands

From project root:

```bash
scripts/run_local.sh smoke
```

Runs:
- interpreter check (`Python 3.11.x`)
- selected smoke test suites:
  - `tests/agents/test_skills.py`
  - `tests/cognition/test_cognition.py`
  - `tests/cognition/test_prompt_integration.py`

Run full unit discovery:

```bash
scripts/run_local.sh test
```

Run the loop-focused suite:

```bash
uv run python -m unittest tests/execution/test_agent_loop.py
```

Run lightweight lint-style check (bytecode compile):

```bash
scripts/run_local.sh lint
```

## Manual uv workflow (optional)

If you prefer direct commands:

```bash
uv venv --python 3.11 .venv
uv sync
uv run python --version
uv run python -m unittest discover -s tests -p "test_*.py"
```

## Configuration (config loader)

Arceus loads configuration from JSON (nanobot-style). Config file overrides environment variables when both exist.

**Search order:** `workspace/.arceus/config.json` → `workspace/config.json` → `~/.arceus/config.json` → `cwd/.arceus/config.json` → `cwd/config.json`

**Example `.arceus/config.json`:**

```json
{
  "agents": {
    "defaults": {
      "model": "gpt-5.2",
      "maxIterations": 8,
      "temperature": 0.3,
      "maxTokens": 8192
    }
  },
  "providers": {
    "azure": {
      "apiKey": "",
      "endpoint": "",
      "deployment": "gpt-5.2"
    }
  },
  "tools": {
    "web": { "apiKey": "", "maxResults": 5 },
    "exec": { "timeout": 60 },
    "restrictToWorkspace": false
  }
}
```

Use `config.load_config()` and `config.save_config()` for programmatic access.

## Azure OpenAI (LLM provider)

When `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` are set in `.env` (or in config), the agent uses Azure OpenAI for real LLM generation. Otherwise it falls back to the rule-based provider (deterministic, for tests).

Set `AZURE_OPENAI_DEPLOYMENT` to your Azure deployment name (e.g. `gpt-5.2`, `gpt-4o`). Default is `gpt-5.2`.

## Sessions (multi-turn conversations)

When you pass `session_key` (e.g. `"console:user123"`), the agent loads prior conversation history and persists new messages. Use for multi-turn chats.

```bash
uv run python -c "
from pathlib import Path
from execution.controller import Controller
c = Controller(Path('.'))
c.run_problem('What is PM?', session_key='console:demo')
c.run_problem('Explain the first principle in more detail', session_key='console:demo')
"
```

Sessions are stored as JSONL in `workspace/sessions/`.

## Run the PM core loop

Minimal direct invocation from repo root:

```bash
uv run python -c "from pathlib import Path; from execution.agent_loop import AgentLoop; out=AgentLoop(Path('.')).run_sync('Users drop during onboarding'); print(out['final'])"
```

The output includes:
- final response content + confidence
- per-iteration traces
- web evidence captured during runtime
- drafted skill paths (when repeated capability gaps are detected)

## Heartbeat (periodic autonomous wake-up)

The heartbeat service periodically wakes the agent to check `HEARTBEAT.md` in the workspace. The agent reads the file, works through each task, researches with web_search, and persists until done. Use for relentless autonomous PM work (backlog review, research sweeps, status updates).

**Run one heartbeat tick:**

```bash
uv run python -c "from pathlib import Path; from execution.controller import Controller; c=Controller(Path('.')); print(c.run_heartbeat_once())"
```

**Run gateway (heartbeat loop, 30 min default):**

```bash
uv run python -c "from pathlib import Path; from execution.controller import Controller; c=Controller(Path('.')); c.run_gateway_sync(heartbeat_interval_s=60)"
```

Create `HEARTBEAT.md` in the workspace with tasks:

```markdown
# Tasks for next heartbeat

- [ ] Review backlog and flag stale items
- [ ] Check for new PM research on [topic]
```

If nothing needs attention, the agent replies `HEARTBEAT_OK`.

## Cron (scheduled tasks)

The cron service lets the agent schedule reminders and recurring tasks. Jobs are persisted in `.arceus/cron.json`. When the gateway runs, due jobs execute and the agent processes each job's message.

**Use the cron tool** (when the agent has the cron skill):

- `cron(action="add", message="Break time!", every_seconds=1200)` — every 20 min
- `cron(action="add", message="Morning standup", cron_expr="0 9 * * 1-5", tz="America/Vancouver")`
- `cron(action="list")` — list jobs
- `cron(action="remove", job_id="abc123")` — remove a job

**Gateway** (heartbeat + cron):

```bash
uv run python -c "from pathlib import Path; from execution.controller import Controller; c=Controller(Path('.')); c.run_gateway_sync(heartbeat_interval_s=60, cron_enabled=True)"
```

## Troubleshooting

- If Python is not 3.11, re-run:
  - `uv venv --python 3.11 .venv`
- If dependency resolution changes:
  - `uv sync`
- If command permissions fail for helper script:
  - `chmod +x scripts/run_local.sh`
