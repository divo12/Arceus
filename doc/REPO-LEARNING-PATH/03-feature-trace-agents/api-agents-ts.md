# `ui/src/api/agents.ts`

Why it matters:

- This is the main frontend HTTP wrapper for the agent domain.

What to focus on:

- `agentPath(...)`
- `list`, `org`, `get`, `create`, `hire`, `update`
- runtime-related calls like `runtimeState`, `taskSessions`, `wakeup`, and `invoke`

What this file teaches:

- frontend API files mirror backend route shape closely
- company scoping is pushed into helper functions early
- type imports from `@paperclipai/shared` define the contract the UI expects

Connections:

- used heavily by `Agents.tsx` and `AgentDetail.tsx`
- maps to backend routes in `server/src/routes/agents.ts`

Self-check:

- Which methods here are pure CRUD?
- Which ones are really runtime-control operations?
- Why is the shared types package imported so heavily here?

