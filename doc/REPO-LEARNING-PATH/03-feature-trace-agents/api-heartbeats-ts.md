# `ui/src/api/heartbeats.ts`

Why it matters:

- This file exposes run and live-execution data to the UI.

What to focus on:

- list/live-run/transcript-oriented methods
- company-scoped run queries
- how heartbeat data is fetched separately from agent records

Connections:

- `Agents.tsx` uses it for live status hints
- `AgentDetail.tsx` uses it for run history and live execution context
- backend source is the heartbeat-related endpoints in `routes/agents.ts`

Self-check:

- Why are heartbeat runs fetched separately from agents?
- What UI state becomes possible once you have run-level data?
- Which screens would break if heartbeat APIs disappeared?

