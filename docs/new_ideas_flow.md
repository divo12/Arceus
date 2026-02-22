# New Ideas Flow: Cursor for Product Managers

Run the agent via cron + heartbeat to explore "what to build next" for Arceus (Cursor for PMs). The main agent spawns subagents, integrates their feedback, and writes ideas to `new_ideas.md`.

## Problem

**Arceus is designing Cursor for product managers** — a tool that tells what to build next. Given a problem, the agent uses PM knowledge and skills to solve it and recommend what to build.

## Flow

1. **Gateway** runs heartbeat + cron (`scripts/run_gateway.py run` or `main.py`)
2. **Cron job** fires on schedule (e.g. daily at 9am)
3. **Controller** dispatches to `run_new_ideas_sweep` when `payload.kind == "new_ideas"`
4. **Main agent** receives:
   - Problem: Cursor-for-PMs, what to build next
   - Repo overview (architecture, skills, subagents)
   - Instructions to spawn subagents and write to `new_ideas.md`
5. **Subagents** validate ideas (JTBD, PoL, prioritization), research trends
6. **Output** → `new_ideas.md` with new ideas, gaps, tools, todos

## Run once

```bash
uv run python scripts/run_gateway.py new_ideas
```

## Schedule via cron

```bash
# Daily at 9am
uv run python scripts/run_gateway.py add --new-ideas --cron "0 9 * * *"

# Every 24 hours
uv run python scripts/run_gateway.py add --new-ideas --every 86400
```

## Run gateway

```bash
uv run python scripts/run_gateway.py run
```

When the new_ideas cron job is due, it runs; output is written to `new_ideas.md`.

## Heartbeat (optional)

You can also trigger the sweep via HEARTBEAT.md. Add a task:

```markdown
# Tasks for next heartbeat

- [ ] Run new ideas sweep: Cursor for PMs — what to build next. Spawn subagents, write to new_ideas.md.
```

When heartbeat fires (every 30 min by default), the agent reads HEARTBEAT.md and executes the task.

## Repo context

The agent receives a high-level overview (from `pm_ideas/service.py` REPO_OVERVIEW):

- Arceus = iterative PM agent, Cursor-for-PMs
- Core flow: Problem → Evidence → Options → Decision → Plan
- Architecture: ReACT loop, PM cognition, three-tier skills, subagents, gateway
- Key dirs: agents/, cognition/, execution/, skills/, pm_ideas/
