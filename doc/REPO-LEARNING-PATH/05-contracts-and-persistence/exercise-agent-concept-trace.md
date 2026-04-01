# Exercise: Trace the `Agent` concept across layers

Chosen concept: `Agent`

## 1. Persistence truth

`packages/db/src/schema/agents.ts`

This defines what an agent is in storage:

- identity
- role
- hierarchy links
- runtime config
- budget state
- lifecycle timestamps

## 2. Shared contract truth

`packages/shared/src/types/agent.ts`

This defines what the UI and server agree an `Agent` looks like in application code.

Important difference:

- the shared type is a contract shape
- the DB schema is a storage shape

They are related, but not identical in purpose.

## 3. Server behavior

`server/src/services/agents.ts`

This turns raw rows into domain behavior:

- create/update/delete
- normalization
- org constraints
- permission-related behavior

`server/src/routes/agents.ts`

This turns that behavior into HTTP endpoints and access-checked responses.

## 4. UI representation

`ui/src/api/agents.ts`

- frontend contract wrapper for fetching agent data

`ui/src/pages/Agents.tsx`

- agent list and org display

`ui/src/pages/AgentDetail.tsx`

- deep operational view of one agent

## 5. What you learn from this trace

- DB says what can persist
- shared types say what the app agrees to exchange
- services say how it behaves
- routes say how it is exposed
- UI pages say how humans experience it

## 6. Self-check

- If you add a new agent field, which four layers probably need attention?
- Which layer is most likely to enforce invariants?
- Which layer is most likely to change labels or presentation only?

