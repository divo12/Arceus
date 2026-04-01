# `packages/db/src/schema/agents.ts`

Why it matters:

- This is the storage truth for agent records.

What to focus on:

- identity fields
- org fields like `reportsTo` and `spawnedByAgentId`
- runtime config fields
- budget and pause fields
- indexes that reflect common query patterns

What this file teaches:

- the agent record mixes identity, governance, runtime, and budget state
- the DB stores enough information to rebuild most operational views of an agent

Self-check:

- Which columns are about org structure?
- Which columns are about runtime behavior?
- Which columns would a simple “chatbot registry” not normally have?

