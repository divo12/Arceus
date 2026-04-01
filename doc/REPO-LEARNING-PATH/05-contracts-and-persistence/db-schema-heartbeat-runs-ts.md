# `packages/db/src/schema/heartbeat_runs.ts`

Why it matters:

- This is the main persistence record for agent executions.

What to focus on:

- lifecycle timestamps
- result and usage fields
- session before/after fields
- log metadata
- process tracking fields
- `contextSnapshot`

What this file teaches:

- heartbeat runs are first-class persisted entities
- the system cares about execution history, not just current agent status

Self-check:

- Which fields describe process/runtime mechanics?
- Which fields describe model output and usage?
- Why is `contextSnapshot` valuable for debugging and replay reasoning?

