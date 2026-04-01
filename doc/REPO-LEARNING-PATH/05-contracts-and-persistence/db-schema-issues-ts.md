# `packages/db/src/schema/issues.ts`

Why it matters:

- Issues are the main work-unit model, so this file is central to understanding execution.

What to focus on:

- assignment fields
- execution lock and run linkage
- project/goal/workspace linkage
- origin and identifier fields

What this file teaches:

- an issue is not just a ticket; it is tied to execution ownership and workspace strategy
- work units are deeply connected to agents and heartbeat runs

Self-check:

- Which fields link issues to agents?
- Which fields link issues to execution runs and workspaces?
- What does the schema reveal about checkout/locking behavior?

