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

The heartbeat service periodically wakes the agent to check `HEARTBEAT.md` in the workspace. If the file contains actionable tasks, the agent executes them.

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
