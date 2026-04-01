# `packages/db/src/schema/index.ts`

Why it matters:

- This is the schema export barrel.

What to focus on:

- what tables exist
- how many subsystems persist data
- which names match domains you have already seen in UI/routes/services

What this file teaches:

- Paperclip persists far more than just agents
- heartbeat, approvals, workspaces, activity, memory-adjacent metadata, and plugins all have storage

Connections:

- `services/agents.ts` uses `agents`
- `routes/issues.ts` and issue services use `issues`
- `heartbeat.ts` uses `heartbeatRuns` and related tables

Self-check:

- Which exported tables belong to the agent execution lifecycle?
- Which ones belong to governance?
- Which ones look like infrastructure support tables?

