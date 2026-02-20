---
name: heartbeat
description: Use HEARTBEAT.md for periodic autonomous tasks. When the heartbeat service runs, it reads this file and executes any instructions. Use for recurring PM tasks like backlog review, research checks, or status updates.
always: false
---

# Heartbeat

Use this skill when the agent is running in gateway mode with heartbeat enabled.

## What It Does

The heartbeat service periodically wakes the agent and reads `HEARTBEAT.md` in the workspace. If the file contains actionable tasks, the agent executes them. If nothing needs attention, the agent replies `HEARTBEAT_OK`.

## When To Use

- Recurring PM tasks (backlog triage, roadmap status, research sweep)
- Proactive checks (new competitor moves, market signals)
- Scheduled follow-ups (stakeholder updates, metric reviews)

## HEARTBEAT.md Format

Place tasks in `HEARTBEAT.md` at workspace root:

```markdown
# Tasks for next heartbeat

- [ ] Review backlog and flag stale items
- [ ] Check for new PM research on [topic]
- [ ] Update roadmap draft status
```

Empty lines, headers, and unchecked/checked boxes are ignored. Any other content is treated as actionable.

## Guardrails

- Keep tasks concise and tool-executable
- Prefer skills (web-search, problem-statement, etc.) for complex work
- If nothing to do, reply with exactly: HEARTBEAT_OK
