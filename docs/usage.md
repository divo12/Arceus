# Arceus Development Workflow (uv + Python 3.11)

## Entrypoint commands

| Command | Description |
|---------|-------------|
| `main.py` | Run gateway (heartbeat + cron) |
| `main.py --no-cron` | Run gateway without cron |
| `main.py chat` | Interactive chat (Markdown) |
| `main.py chat --no-markdown` | Chat with plain text |
| `main.py status` | Config path, provider, cron, sessions |
| `main.py onboard` | Create .arceus/config.json, sessions/, skills/ |
| `main.py "problem"` | Run single problem |

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
    "restrictToWorkspace": false,
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      }
    }
  }
}
```

Use `config.load_config()` and `config.loader.save_config()` for programmatic access.

**Status and onboard:**

```bash
uv run python main.py status    # Config path, provider, cron jobs, sessions
uv run python main.py onboard   # Create .arceus/config.json, sessions/, skills/, HEARTBEAT.md
```

**Tests for MCP, status, onboard:**

```bash
uv run python -m unittest tests.config_loader_tests.test_config.TestConfigLoader.test_mcp_servers_in_config_schema tests.config_loader_tests.test_config.TestConfigLoader.test_status_command_output tests.config_loader_tests.test_config.TestConfigLoader.test_onboard_creates_files tests.config_loader_tests.test_config.TestConfigLoader.test_onboard_idempotent tests.execution.test_agent_loop.TestCron.test_mcp_empty_config_runs_ok tests.execution.test_agent_loop.TestCron.test_mcp_invalid_command_skipped_run_completes -v
```

## Azure OpenAI (LLM provider)

When `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` are set in `.env` (or in config), the agent uses Azure OpenAI for LLM generation. Both are required; if missing, the agent will raise a clear error.

Set `AZURE_OPENAI_DEPLOYMENT` to your Azure deployment name (e.g. `gpt-5.2`, `gpt-4o`). Default is `gpt-5.2`.

**Connection errors:** If you see `APIConnectionError` or "Connection error", check:
1. **Endpoint format:** `https://<resource>.openai.azure.com` (no trailing path)
2. **Network:** Run from a terminal with outbound HTTPS allowed (e.g. not a sandboxed environment)
3. **Proxy/VPN:** Ensure Azure endpoints are reachable

## Sessions (multi-turn conversations)

When you pass `session_key` (e.g. `"console:user123"`), the agent loads prior conversation history and persists new messages. Use for multi-turn chats.

**Interactive chat mode** (nanobot-style):

```bash
uv run python main.py chat              # Markdown-rendered responses
uv run python main.py chat --no-markdown  # Plain text output
```

Type your problem, get a response, continue the conversation. Use `exit`, `quit`, or `:q` to end. Sessions persist in `workspace/sessions/`. Use ↑/↓ for input history (`~/.arceus/history/cli_history`).

**Programmatic:**

```bash
uv run python -c "
from pathlib import Path
from execution.controller import Controller
c = Controller(Path('.'))
c.run_problem('What is PM?', session_key='console:demo')
c.run_problem('Explain the first principle in more detail', session_key='console:demo')
"
```

## Run single problem

```bash
uv run python main.py "your problem"
```

Runs one problem through the agent and prints the final response.

## Run the PM core loop (programmatic)

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
uv run python main.py                              # Gateway with heartbeat + cron
uv run python main.py --no-cron                    # Gateway without cron jobs
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

### CLI (add jobs without running the agent)

```bash
# Add a job (every 20 min)
uv run python scripts/run_gateway.py add --message "Break time!" --every 1200

# Add with cron expression (weekdays 9am Vancouver)
uv run python scripts/run_gateway.py add --message "Morning standup" --cron "0 9 * * 1-5" --tz "America/Vancouver"

# List jobs
uv run python scripts/run_gateway.py list

# Remove a job
uv run python scripts/run_gateway.py remove <job_id>

# Run gateway (heartbeat + cron) - keeps running until Ctrl+C
uv run python scripts/run_gateway.py run --heartbeat-interval 1800
```

### Via agent (cron skill)

When the agent has the cron skill, it can add jobs via the `cron` tool:

- `cron(action="add", message="Break time!", every_seconds=1200)` — every 20 min
- `cron(action="add", message="Morning standup", cron_expr="0 9 * * 1-5", tz="America/Vancouver")`
- `cron(action="list")` — list jobs
- `cron(action="remove", job_id="abc123")` — remove a job

### What you need

1. **Add jobs** — Use the CLI above or ask the agent to schedule something.
2. **Run the gateway** — `uv run python scripts/run_gateway.py run` (or `run_gateway_sync` in code). The gateway must stay running for cron jobs to execute.
3. **Azure/LLM** — Cron jobs run the agent; ensure `.env` has Azure credentials if you want real LLM responses.

### Cronitor monitoring (optional)

Set `CRONITOR_API_KEY` in `.env` to send run/complete/fail pings to [Cronitor](https://cronitor.io). Each job execution will ping: `run` at start, `complete` on success, `fail` on error.

## Observability (logging)

All logs are stored in `workspace/.arceus/logs/arceus.log`. Configured automatically when running `main.py` or `scripts/run_gateway.py`.

- **Rotation:** 10 MB
- **Retention:** 7 days
- **Format:** `{time} | {level} | {name}:{function}:{line} - {message}`

## Troubleshooting

- If Python is not 3.11, re-run:
  - `uv venv --python 3.11 .venv`
- If dependency resolution changes:
  - `uv sync`
- If command permissions fail for helper script:
  - `chmod +x scripts/run_local.sh`
