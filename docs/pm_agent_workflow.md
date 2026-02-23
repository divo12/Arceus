# PM Agent Workflow

This workflow turns Arceus into a continuous PM iteration engine:

1. Idea/Problem input
2. Evidence -> Options -> Decision
3. Execution plan + packet
4. Feedback collection (real or simulated)
5. Derive next problems
6. Repeat

## Runtime modes

- CLI one-off: `uv run python main.py pm-next "your idea"`
- Gateway cron job: `uv run python scripts/run_gateway.py add --pm-loop --every 900`
- Gateway runner: `uv run python scripts/run_gateway.py run --heartbeat-interval 300`
- Direct PM loop: `uv run python scripts/run_gateway.py pm_loop --idea "your idea" --max-cycles 2`

## Core files

- `execution/agent_loop.py`:
  - `run_pm_loop(...)`
  - `run_pm_loop_sync(...)`
  - PM loop state persistence under `data/state/workflows/`
- `execution/controller.py`:
  - `run_pm_problem(...)`
  - cron dispatch for payload kind `pm_loop`
- `cron/types.py`:
  - `CronPayload.kind` supports `pm_loop`

## Loop state and reports

- State: `data/state/workflows/<loop_id>.json`
- Report: `data/state/workflows/<loop_id>_report.json`

State tracks:
- current cycle
- queued/processed problems
- last feedback
- last decision summary
- rolling cycle summaries (bounded context window used in next run prompts)

## Governance controls

Configured in `config/schema.py` under `agents.pm_loop`:

- `enabled`
- `max_cycles_per_run`
- `single_run_infinite` (when true, one cron-triggered PM loop run continues indefinitely)
- `cooldown_seconds`
- `simulate_feedback`
- `deduplicate_problems`
- `recent_cycle_summaries` (default `2`, i.e. N-2 + N-1 summaries)
- `kill_switch`

## Events emitted

- `pm_workflow_started`
- `pm_feedback_generated`
- `pm_next_problem_derived`
- `pm_cycle_completed`

