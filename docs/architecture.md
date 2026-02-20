# PM Core-First Runtime Architecture

## Overview

This repository now follows a nanobot-inspired core runtime specialized for product-management execution:

1. iterative execution loop (`context -> provider -> tools -> iterate`)
2. PM cognition cycle (`interpret -> reason -> plan -> decide -> act -> reflect`)
3. policy-gated web learning when confidence is low
4. memory traces with run and iteration metadata
5. skill-gap detection with draft-skill generation and human review gate
6. heartbeat service for periodic autonomous wake-up (nanobot-style)
7. cron service for scheduled reminders and recurring tasks (nanobot-style)

## Runtime Flow

1. `execution/agent_loop.py` starts a run with `run_id`.
2. `agents/base_agent.py` builds context (identity + skills + prompt references).
3. `cognition/cognitive_loop.py` produces plan/decision/reflection for each iteration.
4. `providers/adapter.py` contract drives provider output (content + optional tool calls).
5. `agents/tools/registry.py` executes tool calls and appends tool outputs to context.
6. Web evidence is captured from `web_search`/`web_fetch` results and reused in later iterations.
7. `cognition/memory/memory_manager.py` writes episodic traces + run summaries.
8. Repeated missing-skill phases produce draft specs under `skills/workspace_skills/_drafts/`.

## Core Modules

- `execution/agent_loop.py`: loop control, iteration budget, tool execution, evidence capture.
- `providers/adapter.py`: provider abstraction (`ProviderAdapter`, `ProviderResponse`, `ToolCall`).
- `providers/azure_openai_provider.py`: Azure OpenAI for LLM generation (credentials required).
- `cognition/cognitive_loop.py`: adds explicit `reflect` output used by loop and memory.
- `cognition/decision_policy.py`: confidence scoring + web-evidence requirement policy.
- `agents/skills.py`: skill-gap detection and draft skill file generation.
- `cognition/memory/long_term_memory.py`: hardened memory schema (`episodes`, `traces`, `runs`, `facts`).
- `heartbeat/service.py`: periodic agent wake-up; reads `HEARTBEAT.md` and executes tasks.
- `cron/service.py`: scheduled jobs; persists to `.arceus/cron.json`, runs agent when due.
- `session/manager.py`: conversation sessions; JSONL in `workspace/sessions/` keyed by `channel:chat_id` (from nanobot).
- `config/schema.py` + `config/loader.py`: JSON config (nanobot-style); agents, providers, tools, channels; config overrides env when both exist.
- `main.py`: Entrypoint; gateway (heartbeat + cron), `chat` (interactive REPL with Rich Markdown), `status`, `onboard`, or single problem.
- `observability/logger.py`: logging to `.arceus/logs/arceus.log`; rotation/retention configured.

## Heartbeat

The heartbeat service (from nanobot) periodically wakes the agent:

- Default interval: 30 minutes
- Agent reads `HEARTBEAT.md` via read_file, works through tasks, researches with web_search
- Runs with 12 iterations for relentless task execution
- Agent replies `HEARTBEAT_OK` when nothing to do
- Use `Controller.run_heartbeat_once()` or `Controller.run_gateway_sync()` for execution

Implementation: the controller's `_on_heartbeat` callback uses `await self.loop.run()` (async) so it can be invoked from within the heartbeat service's async `trigger_now` without nesting `asyncio.run()`.

## Cron

The cron service (from nanobot) schedules agent tasks:

- Jobs stored in `.arceus/cron.json`
- Supports `every` (interval), `cron` (cron expression), `at` (one-shot)
- When a job is due, the controller runs the agent with the job message
- Use `cron` tool (add/list/remove) when the agent has the cron skill
- Cron service starts with the gateway when `cron_enabled=True`

## Think & Research Relentlessly

The agent is instructed to work autonomously and persistently:

- **Research first**: Use web_search and web_fetch before making recommendations
- **Use skills**: Read SKILL.md files and apply PM frameworks
- **Iterate**: Do not finalize until substantive evidence supports the answer
- **Default 8 iterations** (12 for heartbeat) to allow multiple research passes
- **Web evidence required** when confidence < 0.7 (policy); high-confidence responses (≥0.85) can finalize without evidence

## Web Learning Policy

When decision confidence is low, `requires_web_evidence=true` is set by policy.

- The provider is expected to call `web_search`/`web_fetch`.
- The loop does not finalize until evidence is available or max iterations are reached.
- Final outputs include evidence metadata for traceability.

## Skill Drafting Gate

Draft skills are generated only as review artifacts:

- location: `skills/workspace_skills/_drafts/<skill-name>/SKILL.md`
- frontmatter includes:
  - `status: draft`
  - `review_required: true`
- drafts are not auto-enabled into active workspace skills.

## Chat Mode

Interactive chat (`main.py chat`) uses:
- **Rich** for Markdown-rendered responses; `--no-markdown` for plain text.
- **prompt_toolkit** + `FileHistory` for up/down arrow input history at `~/.arceus/history/cli_history`.

## Validation Commands

```bash
scripts/run_local.sh smoke
uv run python -m unittest tests/execution/test_agent_loop.py
scripts/run_local.sh test
scripts/run_local.sh lint
```
