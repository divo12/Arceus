# `packages/shared/src/types/*`

Why it matters:

- This directory defines the shape of the data that moves across app layers.

What to focus on:

- each file usually corresponds to one domain area
- `types/index.ts` re-exports the domain modules
- the important skill is learning the pattern, not memorizing every file

Good first files:

- `agent.ts`
- `issue.ts`
- `heartbeat.ts`
- `hierarchy.ts`
- `role.ts`

What this directory teaches:

- contracts are organized by domain, not by frontend/backend ownership
- detail types often extend list/base types

Self-check:

- Which type files map directly to pages you have already studied?
- Which ones map directly to DB schema files?
- When would you add a new type here versus only on the server?

