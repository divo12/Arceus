# `server/src/routes/agents.ts`

Why it matters:

- This is one of the best “system map” files in the backend.

Read focus:

- route registration
- auth and company checks
- agent CRUD and wakeup endpoints
- instructions, skills, keys, runtime-state, heartbeat-run endpoints

Connections:

- It hands domain work to `services/agents.ts`, `heartbeat.ts`, approvals, hierarchy, and access systems.
- It shows what the API surface for agents really is.

Questions:

- What is handled as HTTP concern here?
- Which endpoints only validate and delegate?
- Which other services does the agent domain depend on?

