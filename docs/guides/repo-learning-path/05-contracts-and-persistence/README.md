# Phase 5: Contracts And Persistence

This phase is about learning where system truth lives once you move below pages, routes, and services.

If Phase 3 taught you how one feature flows across the stack, Phase 5 teaches you why the stack stays aligned at all.

At a high level, this phase is about two packages:

- `packages/shared`
- `packages/db`

They solve different problems.

## 1. The Big Split

### `packages/shared`

This package defines shared meaning.

It answers questions like:

- what statuses are legal?
- what does an `Agent` or `Issue` look like as a cross-layer record?
- what input shape may a route accept?
- which values are valid for roles, adapters, approvals, hierarchy states, and heartbeat sources?

### `packages/db`

This package defines durable storage.

It answers questions like:

- which table stores this concept?
- which fields are actually persisted?
- which relationships exist between entities?
- which indexes reflect expected query patterns?

So the split is:

- `shared` = semantic contract
- `db` = persistence contract

Both are “truth,” but they are truth at different layers.

## 2. Why This Phase Matters

A lot of repo confusion comes from mixing these two levels up.

For example:

- a shared type may include enriched fields that are not stored in one table
- a validator may allow only part of a type because it models incoming input, not full persisted output
- a DB table may use text columns, while `shared/constants.ts` defines the allowed value universe those columns are supposed to contain

If you do not understand that split, schema and API work starts feeling inconsistent when it is actually layered.

## 3. Read Order

1. [`shared-index-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/shared-index-ts.md)
2. [`shared-constants-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/shared-constants-ts.md)
3. [`shared-types-and-validators.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/shared-types-and-validators.md)
4. [`db-schema-index-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/db-schema-index-ts.md)
5. [`db-schema-agents-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/db-schema-agents-ts.md)
6. [`db-schema-issues-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/db-schema-issues-ts.md)
7. [`db-schema-heartbeat-runs-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/05-contracts-and-persistence/db-schema-heartbeat-runs-ts.md)

## 4. The Best Mental Model For This Phase

Think of a feature like `Agent` as existing in four layers:

1. constants
2. shared types
3. validators
4. schema

### Constants

These define the allowed vocabularies:

- statuses
- roles
- adapter types
- invocation sources

### Shared types

These define the cross-layer record shapes the UI and server agree on.

### Validators

These define what untrusted input is allowed to enter the system at runtime.

### Schema

This defines how the durable subset of that concept is stored in Postgres.

That layered model is one of the most important things to carry out of this phase.

## 5. A Concrete Example: `Agent`

For one concept like `Agent`, you should be able to find:

- legal values like `AGENT_STATUSES`, `AGENT_ADAPTER_TYPES`, `AGENT_ROLES`
- the shared `Agent` and `AgentDetail` interfaces
- validators like `createAgentSchema` and `updateAgentSchema`
- the `agents` table schema
- neighboring persistence tables like:
  - `agent_api_keys`
  - `agent_runtime_state`
  - `agent_task_sessions`
  - `agent_wakeup_requests`

That immediately teaches you something important:

an “agent” in the product is larger than one DB row, but the main `agents` table is still the durable core record.

## 6. Another Example: `HeartbeatRun`

For `HeartbeatRun`, you should be able to find:

- invocation and status vocabularies in constants
- `HeartbeatRun` / `HeartbeatRunEvent` shared types
- wakeup and runtime-related validator inputs
- the `heartbeat_runs` table

That teaches a different lesson:

some concepts are runtime-heavy and observability-heavy, so their schema includes a lot of diagnostic and history information that is not just user-facing business data.

## 7. How To Read These Files Without Getting Lost

### In `packages/shared`

Ask:

- Is this file defining legal values, record shapes, or input schemas?
- Is it intended for both UI and server?
- Is it modeling “full object shape” or “incoming mutation payload”?

### In `packages/db`

Ask:

- Is this the core entity table or a neighboring operational table?
- Which columns are identity/configuration versus runtime/diagnostic state?
- Which indexes reveal expected query patterns?
- Which relationships show how this entity participates in the larger system?

## 8. Why Drift Usually Starts Here

When a feature changes, drift often begins in one of these places:

- a new DB column is added but not exposed through shared types
- a new enum value is added to the UI but not to shared constants
- a route starts accepting a field that validators do not allow
- a type suggests a field always exists, but the schema or service does not actually guarantee it

That is why these packages are worth learning deeply.

They are the first place inconsistency shows up.

## 9. What You Should Be Able To Explain After This Phase

- why constants, types, validators, and schema are different layers of truth
- why text columns in schema still rely on shared constant sets
- why a validator is not just the same thing as a TypeScript interface
- why some shared types are richer than any single DB table
- how to trace one concept like `Issue` or `HeartbeatRun` from contract to storage

## 10. Practical Change Workflow

If you change a data model or API contract, a healthy workflow usually touches:

1. shared constants, if vocabularies changed
2. shared types, if the cross-layer object shape changed
3. validators, if incoming payload rules changed
4. schema, if durable storage changed
5. routes/services/UI, because they consume those contracts

That is the practical engineering payoff of this phase.

## Self-Check

- Can you explain the difference between “shared meaning” and “durable storage”?
- Can you trace one concept through constants, types, validators, and schema?
- Can you explain why a validator and a shared interface are not interchangeable?
