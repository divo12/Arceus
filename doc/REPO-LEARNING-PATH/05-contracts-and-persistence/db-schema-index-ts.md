# `packages/db/src/schema/index.ts`

Why it matters:

- This is the persistence export barrel.

What to focus on:

- which tables cluster around agents, issues, execution, governance, and plugins
- which names match the services and routes you have already seen

What this file teaches:

- the repo is deeply stateful
- “agent company” behavior is backed by many coordinated tables, not one giant table

Self-check:

- Which table names clearly belong to the heartbeat subsystem?
- Which names belong to access/governance?
- Which names suggest transient runtime state that still needs persistence?

