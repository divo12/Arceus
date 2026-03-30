# Schema Architecture

This guide explains how schema is organized and what modeling patterns the repo uses.

## 1. Where Schema Lives

The schema lives in:

- `packages/db/src/schema/`

Each file usually represents one table or one closely related table group.

Examples:

- `companies.ts`
- `agents.ts`
- `issues.ts`
- `heartbeat_runs.ts`
- `role_definitions.ts`
- `routines.ts`
- `meetings.ts`

The barrel export lives in:

- `packages/db/src/schema/index.ts`

That file matters because the rest of the app imports table definitions from the DB package's public surface. If you add a new table file but forget to export it from `schema/index.ts`, the schema exists locally but is effectively invisible to the rest of the package.

## 2. The Normal Table Shape

Most tables follow a familiar pattern:

- `id` as a UUID primary key with `defaultRandom()`
- foreign keys to parent entities
- `createdAt` and `updatedAt`
- indexes for common query patterns

Example pattern:

```ts
id: uuid("id").primaryKey().defaultRandom()
createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
```

This means the app prefers:

- stable UUIDs over integer IDs
- explicit timestamps
- queryable foreign-key relationships

## 3. Company Scoping Is A Core Pattern

One of the most important DB conventions in this repo is company scoping.

Many business tables contain:

- `companyId`

That is not accidental. It is one of the core product invariants.

Examples:

- `agents.companyId`
- `issues.companyId`
- `heartbeat_runs.companyId`
- `role_definitions.companyId`

Why this matters:

- the product is a control plane for many companies
- the DB is expected to preserve company boundaries
- routes and services rely on this field for access enforcement and query scoping

If a revamp breaks company scoping, it will ripple into authorization and business correctness very quickly.

## 4. Common Modeling Patterns

### 4.1 Text columns for many app-level enums

A lot of app-state values are stored as `text`, often with a TypeScript type layered on top:

```ts
delegationStyle: text("delegation_style").$type<DelegationStyle>()
kind: text("kind").$type<AgentKind>()
```

This means:

- TypeScript narrows values at compile time
- the DB column itself is often plain text

The tradeoff is flexibility vs stronger DB-level enum enforcement.

### 4.2 `jsonb` for flexible structured state

The schema uses `jsonb` for data that is structured but not rigid enough to deserve a dedicated table yet.

Examples:

- `agents.adapterConfig`
- `agents.runtimeConfig`
- `agents.permissions`
- `issues.assigneeAdapterOverrides`
- `heartbeat_runs.resultJson`
- `role_definitions.spawnRules`

This is useful for:

- adapter-specific configuration
- runtime metadata
- evolving structured payloads

But it also means a revamp needs to identify which JSON blobs are stable contracts and which are temporary convenience fields.

### 4.3 Self-references for hierarchies and lineage

Some tables reference themselves using `AnyPgColumn`.

Examples:

- `agents.reportsTo`
- `agents.spawnedByAgentId`
- `issues.parentId`
- `heartbeat_runs.retryOfRunId`

This is how the DB models:

- management hierarchy
- spawn lineage
- parent-child issue trees
- retry chains

### 4.4 Composite indexes for real query shapes

Indexes are not random decoration here. They reflect actual service query patterns.

Examples:

- `agents_company_status_idx`
- `agents_company_reports_to_idx`
- `issues_company_status_idx`
- `issues_company_project_idx`
- `heartbeat_runs_company_agent_started_idx`

Notice the pattern:

- `companyId` is often included first
- then the field most likely used for filtering or sorting

That mirrors the company-scoped query model used throughout the backend.

### 4.5 Partial unique indexes for business invariants

The schema also uses partial unique indexes when a rule only applies for a subset of rows.

Example in `issues.ts`:

- `issues_open_routine_execution_uq`

This enforces a uniqueness rule only for active routine-execution issues that are not hidden and still in open statuses.

This is a strong sign that some product rules are enforced at the DB layer, not only in services.

## 5. Domain Buckets Inside `schema/`

The schema folder covers several broad domains.

### Tenant and identity

- `companies.ts`
- `company_memberships.ts`
- `auth.ts`
- `instance_user_roles.ts`
- `invites.ts`
- `join_requests.ts`

### Agent organization and governance

- `agents.ts`
- `role_definitions.ts`
- `hierarchy_snapshots.ts`
- `hierarchy_edges.ts`
- `principal_permission_grants.ts`

### Work and planning

- `projects.ts`
- `project_goals.ts`
- `goals.ts`
- `issues.ts`
- `labels.ts`
- `issue_labels.ts`
- `issue_comments.ts`
- `issue_approvals.ts`

### Runtime execution

- `heartbeat_runs.ts`
- `heartbeat_run_events.ts`
- `agent_runtime_state.ts`
- `agent_task_sessions.ts`
- `agent_wakeup_requests.ts`
- `workspace_runtime_services.ts`
- `workspace_operations.ts`

### Assets and documents

- `assets.ts`
- `documents.ts`
- `document_revisions.ts`
- `issue_attachments.ts`
- `issue_documents.ts`

### Finance, secrets, logging, plugins

- `cost_events.ts`
- `finance_events.ts`
- `budget_policies.ts`
- `budget_incidents.ts`
- `company_secrets.ts`
- `company_secret_versions.ts`
- `activity_log.ts`
- `plugins.ts`
- `plugin_*`

This is useful during a redesign because it shows the DB is not one monolithic concern. It has multiple subdomains with different change frequencies and risk profiles.

## 6. Representative Table Walkthroughs

These tables are good "teaching examples" for how the repo models data.

### 6.1 `companies`

File:

- `packages/db/src/schema/companies.ts`

What it teaches:

- tenant root entity
- issue-numbering state lives on the company
- budgeting state lives on the company
- company-level approval policy lives on the company

Notable fields:

- `issuePrefix`
- `issueCounter`
- `budgetMonthlyCents`
- `spentMonthlyCents`
- `requireBoardApprovalForNewAgents`

This tells you that "company" is not just branding metadata. It is an operational control object.

### 6.2 `agents`

File:

- `packages/db/src/schema/agents.ts`

What it teaches:

- company scoping
- role and role-definition linkage
- hierarchy through `reportsTo`
- spawn lineage through `spawnedByAgentId`
- adapter and runtime config via `jsonb`

Important design signals:

- adapter type/config are stored in the DB
- runtime state is partially configurable per agent
- the hierarchy is stored directly on agents even though snapshots exist elsewhere

That suggests both "current operational org structure" and "governed snapshot structure" matter in this system.

### 6.3 `issues`

File:

- `packages/db/src/schema/issues.ts`

What it teaches:

- the task model is central
- issues connect companies, projects, goals, assignees, runs, and workspaces
- the DB stores both planning fields and runtime execution linkage

Important design signals:

- assignment can point to agent or user
- execution linkage is explicit through heartbeat run IDs
- there are indexed company-scoped query paths for status, assignee, project, origin, and workspaces
- a partial unique index protects routine-execution invariants

This is one of the most central tables in the repo.

### 6.4 `heartbeat_runs`

File:

- `packages/db/src/schema/heartbeat_runs.ts`

What it teaches:

- runtime execution is durable
- logs, output, retry lineage, and process metadata are persisted
- the system is designed to recover and reason about long-lived/background agent execution

Important design signals:

- stdout/stderr excerpts are stored
- log storage is abstracted via `logStore` and `logRef`
- run context snapshots can be preserved
- there is explicit retry tracking

This table is operationally important even if it is not the core business entity.

### 6.5 `role_definitions`

File:

- `packages/db/src/schema/role_definitions.ts`

What it teaches:

- behavior policy is stored as data
- delegation and spawn rules are DB-backed
- some rows are built-in but still editable in controlled ways

Important design signals:

- role prompt lives in the DB
- tool lists and skills seeds live in the DB
- governance rules are data, not just code

This is a good example of Paperclip storing agent-company behavior policy inside the relational model.

## 7. Conventions To Keep When Adding Tables

When adding a table, try to match the existing style unless you have a deliberate reason not to.

Good defaults:

- use UUID primary keys
- add `companyId` when the entity belongs to a company
- add `createdAt` and `updatedAt`
- add indexes that match expected service queries
- use `jsonb` only when the structure is genuinely flexible
- export the table from `schema/index.ts`

## 8. Questions To Ask Before Changing Schema

Before editing any table, ask:

1. Is this entity company-scoped?
2. Does this change affect auth or access control?
3. Does this change affect issue workflow or heartbeat execution?
4. Should this be a new table, a new column, or a JSON field?
5. What indexes will the service layer need after this change?
6. Which API and UI contracts will break if this field changes?

## 9. What To Read Next

Now that you understand the data model layout, go to [03-migrations.md](./03-migrations.md) to see how schema changes become real SQL migrations.
