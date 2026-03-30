# Shared Contracts

This guide explains the `packages/shared` files that matter when you work on the database.

The short answer to "do shared files matter for DB work?" is:

yes, very often.

`packages/db` defines how data is stored.

`packages/shared` defines how that data is named, typed, validated, and transported across the rest of the app.

If you change one without checking the other, the system drifts.

## 1. What `packages/shared` Owns

The shared package is the cross-layer contract package.

It holds:

- constants and enums
- domain DTO types
- validators
- API path constants
- configuration schema

It is used by:

- `packages/db`
- `server`
- `ui`

That makes it one of the most important "glue" packages in the repo.

## 2. The Most Important Shared Files For DB Work

If you are doing database work, these are the shared files you usually need to inspect:

- `packages/shared/src/index.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/types/index.ts`
- `packages/shared/src/validators/index.ts`
- `packages/shared/src/api.ts`
- `packages/shared/src/config-schema.ts`

## 3. `packages/shared/src/index.ts`

This is the public barrel export for the shared package.

It re-exports:

- constants and literal unions
- domain types
- validators

Why this matters for DB work:

- DB schema files often import shared types from `@paperclipai/shared`
- server and UI also consume the same exports
- if a new enum-like domain value is introduced, this barrel is often part of the change surface

## 4. `constants.ts`

This is where many of the app-wide literal value sets live.

Examples include:

- deployment modes
- agent roles
- agent kinds
- delegation styles
- hierarchy statuses
- issue statuses and priorities
- routine statuses
- approval statuses
- meeting statuses
- secret/storage providers
- heartbeat and runtime event statuses
- plugin constants

Why this matters for DB work:

- many DB text columns are typed using these shared domain values
- changing an allowed value often means a DB-compatible change plus server/UI behavior updates

Example pattern from DB schema:

```ts
delegationStyle: text("delegation_style").$type<DelegationStyle>()
```

That means the DB column is plain text, but its intended domain comes from shared constants and types.

## 5. `types/index.ts`

This is the barrel export for shared DTO/domain types.

It aggregates types like:

- `Agent`
- `RoleDefinition`
- `HierarchySnapshot`
- `Project`
- `Issue`
- `HeartbeatRun`
- `Approval`
- `Routine`
- `BudgetPolicy`
- `FinanceEvent`
- plugin and portability types

Why this matters for DB work:

- if a DB field changes shape, some shared output/input types may need to change too
- these types usually represent what server and UI agree a resource looks like

Important idea:

- DB schema types are storage-centric
- shared types are contract-centric

They are related, but not identical.

## 6. `validators/index.ts`

This is the barrel export for Zod validators used by routes and clients.

It re-exports domain validators for:

- agents
- roles
- hierarchy
- projects
- issues
- approvals
- meetings
- secrets
- routines
- budgets
- finance
- company portability
- and more

Why this matters for DB work:

- if you add a new required field in the DB, request validators may need to require it too
- if you add a new optional field, create/update schemas may need to expose it
- if you add a new enum value, validators may need to allow it

This is often the first place where a DB change becomes an API contract change.

## 7. `api.ts`

This file holds stable API path constants such as:

- `/api/health`
- `/api/companies`
- `/api/agents`
- `/api/projects`
- `/api/issues`

This usually does not change just because a DB column changed.

But it matters when:

- you add a new resource family because of a DB-level new domain
- you split old resources into new endpoints

So it is less central than types/validators/constants for most schema edits, but still part of the contract surface.

## 8. `config-schema.ts`

This file matters a lot for operational DB work.

It defines shared config schema for:

- database mode
- database connection string
- embedded Postgres data directory and port
- backup config
- server/auth/storage/secrets config

Why this matters:

- DB runtime behavior is partly contract-defined here
- config changes around embedded Postgres, backup, or environment shape should stay aligned with both server config loading and operational docs

This is also one of the places where older DB terminology can surface during implementation evolution.

## 9. How `packages/shared` Interacts With `packages/db`

This is the practical relationship.

### DB schema imports shared domain types

Examples:

- `AgentKind`
- `DelegationStyle`
- `EmployeeRole`

So shared types help annotate DB columns.

### Server routes/services use shared DTOs and validators

That means a DB change often requires matching updates in:

- shared validators
- shared DTO types
- server route handling

### UI uses the same shared contracts

So a DB change that affects resource shape can ripple all the way to forms, tables, filters, or dashboards.

## 10. A Good Mental Model

Use this model:

- `packages/db` = storage truth
- `packages/shared` = contract truth
- `server` = behavior truth
- `ui` = presentation truth

If storage truth changes, contract truth often needs to change too.

## 11. Which Shared Files Matter For Which Kind Of DB Change

### New enum-like status or role value

Check:

- `constants.ts`
- related validator file
- related type file

### New field on a resource

Check:

- related type file in `types/`
- related validator file in `validators/`
- maybe `types/index.ts` or `validators/index.ts` exports if a new domain file was added

### Config or operational DB change

Check:

- `config-schema.ts`

### New resource family

Check:

- `types/`
- `validators/`
- `api.ts`

## 12. Shared Files You Should Search First

When a schema change touches one of these domains, start with matching shared files:

- agents -> `types/agent.ts`, `validators/agent.ts`
- roles -> `types/role.ts`, `validators/role.ts`
- hierarchy -> `types/hierarchy.ts`, `validators/hierarchy.ts`
- issues -> `types/issue.ts`, `validators/issue.ts`
- projects -> `types/project.ts`, `validators/project.ts`
- heartbeat/runtime -> `types/heartbeat.ts`
- meetings -> `types/meeting.ts`, `validators/meeting.ts`
- secrets -> `types/secrets.ts`, `validators/secret.ts`

## 13. What I Had Covered Before

The first pass of the DB handbook mentioned shared files as part of the cross-layer sync story, but it did not have a dedicated guide just for them.

This file closes that gap.

So now the handbook covers:

- DB package internals
- migration/runtime behavior
- Hippocampus storage
- shared contract files

as one connected system.

## 14. Practical Shared-Contract Checklist

After a DB change, ask:

1. Did I change a value set that belongs in shared constants?
2. Did I change a resource shape that belongs in shared types?
3. Did I change request/response requirements that belong in shared validators?
4. Did I change operational DB config shape that belongs in `config-schema.ts`?
5. Did I add a resource family that needs API path constants?

If the answer is yes to any of those, the shared package is part of your PR.
