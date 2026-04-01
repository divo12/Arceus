# `server/src/routes/authz.ts`

Why it matters:

- This file exposes permission and access-related API behavior.

Read focus:

- what access questions the frontend or operators can ask
- how authorization state is surfaced, not just enforced

Connections:

- Works with membership, grants, and actor resolution.
- Complements `middleware/auth.ts` by exposing authz data at route level.

Questions:

- What is the difference between auth and authz in this repo?
- Which access concepts are explicit enough to need routes?
- How does company scoping show up in permission APIs?

