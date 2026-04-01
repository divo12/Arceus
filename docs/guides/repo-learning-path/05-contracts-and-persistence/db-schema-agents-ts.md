# `packages/db/src/schema/agents.ts`

This guide explains [`packages/db/src/schema/agents.ts`](/Users/divyansh/Arceus/packages/db/src/schema/agents.ts) as the durable core record for agents.

If you want one sentence first:

the `agents` table stores who an agent is, how it is configured, where it sits in the org, and enough lifecycle state to manage it as a company worker.

## 1. Why This Table Is Core

The `agents` table is one of the backbone tables of the system.

Many other tables depend on it:

- API keys
- runtime state
- task sessions
- wakeup requests
- heartbeat runs
- issue assignment
- hierarchy relationships

So this is not “just one entity among many.”

It is one of the central anchors of the control plane.

## 2. How To Read The Table

Do not read the column list flatly.

Read it in groups:

1. identity and company scope
2. org/governance fields
3. execution configuration
4. budget/lifecycle state
5. permissions/metadata/timestamps
6. indexes

That grouping matches the actual role of the table.

## 3. Identity and company scope

The first fields are:

- `id`
- `companyId`
- `name`

These define the most basic truth:

an agent always belongs to a company.

That is consistent with the repo-wide rule that core business entities are company-scoped.

This is one of the most important invariants to keep in your head when reading routes and services later.

## 4. Org and governance fields

Then you get:

- `role`
- `roleDefinitionId`
- `delegationStyle`
- `kind`
- `reportsTo`
- `spawnedByAgentId`

This cluster is very revealing.

It says an agent is not only a runtime worker.

It is also:

- an organizational role holder
- a participant in the reporting tree
- a participant in spawn lineage
- a governed delegator with a style of operation

That is why the agent domain touches hierarchy and governance so much elsewhere in the repo.

### `roleDefinitionId`

This is especially important because it links the agent not just to a raw role string, but potentially to a richer role-definition entity.

That means the product distinguishes between:

- the role label/category
- the richer structured role definition

## 5. Execution configuration fields

The next important group is:

- `capabilities`
- `adapterType`
- `adapterConfig`
- `runtimeConfig`

This is the durable execution identity of the agent.

### `adapterType`

This tells the backend what kind of runtime or adapter family should execute the agent.

### `adapterConfig`

This stores adapter-specific configuration.

It is JSON because different adapters need different knobs.

### `runtimeConfig`

This stores additional execution/runtime-specific settings that are not always the same thing as adapter configuration.

This split is useful because:

- adapter config answers “how do I talk to this execution backend?”
- runtime config answers “how should this agent behave at runtime?”

## 6. Budget and lifecycle state

This group includes:

- `budgetMonthlyCents`
- `spentMonthlyCents`
- `pauseReason`
- `pausedAt`
- `lastHeartbeatAt`
- `status`

This is where the table stops being only identity/config and starts becoming a control-plane management record.

### Why keep some operational state here?

Because the board needs a quick durable summary of the agent’s current lifecycle condition:

- is it active?
- paused?
- errored?
- terminated?
- when did it last heartbeat?

That does not replace deeper runtime history in neighboring tables.

It gives the main agent record a compact operational summary.

## 7. Permissions and metadata

Then you see:

- `permissions`
- `metadata`

These JSON fields allow the system to attach richer structured state without exploding the base table into dozens of narrow columns.

The important thing here is not “JSON is flexible.”

The important thing is that these fields support feature growth while the core table still stays conceptually readable.

## 8. Timestamps

Standard:

- `createdAt`
- `updatedAt`

Nothing surprising there, but they matter for:

- auditing
- ordering
- UI recency
- sync/revision flows

## 9. What Is Not In This Table

This is one of the most important reading habits for schema work.

Notice what is not stored here:

- API key tokens
- runtime session continuity
- task-session continuity
- wakeup requests
- run history
- run logs

Those live in neighboring tables.

That is good schema design.

It keeps the main entity table focused on:

- persistent definition
- organizational placement
- high-level lifecycle summary

not every runtime artifact.

## 10. Indexes Matter A Lot Here

The table defines indexes like:

- company + status
- company + `reportsTo`
- company + `kind`
- company + `spawnedByAgentId`
- company + `roleDefinitionId`

These tell you what kinds of lookups the backend expects to do often.

### What this implies

The agent domain is optimized around:

- company-scoped browsing
- org-tree traversal
- spawned lineage lookup
- grouping by kind or role-definition link

That matches the UI and service patterns in the repo.

## 11. Relationship To Shared Types

The shared `Agent` type is close to this table, but not identical in architectural role.

This table stores the durable core.

The shared `Agent` type represents the cross-layer object shape the app talks about.

Sometimes those line up closely.

Sometimes services enrich the shared shape beyond the raw row.

That distinction matters when revamping data models.

## 12. What To Remember

- `agents` is the durable core agent record
- it combines company scope, org structure, execution config, and lifecycle summary
- it intentionally does not store the entire runtime story
- its indexes reveal the primary agent query patterns of the system

## Self-Check

- Which columns make the agent an org/governance object instead of only an execution worker?
- Which columns make it an execution-configured object instead of only a person-like record?
- Which runtime concerns are intentionally pushed into neighboring tables instead of staying here?
