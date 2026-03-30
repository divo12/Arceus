# Change Workflow

This guide is the practical checklist for making DB changes safely in this repo.

## 1. The Official Core Workflow

`AGENTS.md` gives the required baseline workflow:

1. edit `packages/db/src/schema/*.ts`
2. ensure new tables are exported from `packages/db/src/schema/index.ts`
3. run `pnpm db:generate`
4. validate compile with `pnpm -r typecheck`

That is the minimum.

In practice, a safe DB change usually needs more than that.

## 2. The Real End-To-End Workflow

Use this full sequence.

### Step 1: decide the scope

Before editing anything, decide what kind of change you are making:

- new table
- new column
- new index
- relationship change
- rename or removal
- data-shape change that also affects API/UI contracts

This matters because the risk level is very different.

### Step 2: edit schema source

Change the relevant file under:

- `packages/db/src/schema/`

If you are adding a new entity, create a new schema file that matches repo conventions.

If you are modifying an existing entity, prefer the smallest change that preserves compatibility.

### Step 3: export from `schema/index.ts`

If you add a new table file, export it from:

- `packages/db/src/schema/index.ts`

Missing this step causes annoying half-finished states where the table exists in source but is not exposed through the DB package.

### Step 4: generate the migration

Run:

```sh
pnpm db:generate
```

Remember that this compiles the package first because Drizzle reads:

- `dist/schema/*.js`

### Step 5: review the generated SQL

Read the new migration in:

- `packages/db/src/migrations/`

Check for:

- unintended drops
- wrong nullability
- missed indexes
- accidental renames
- missing constraints

### Step 6: sync the contract layers

This is where many DB changes are actually won or lost.

If the DB shape changed, check whether you also need changes in:

- `packages/shared`
- `server` routes/services
- `ui` types/forms/pages/queries
- tests
- docs

Do not stop at the migration file.

If you want a dedicated map for the shared layer, read [09-shared-contracts.md](./09-shared-contracts.md).

## 3. Cross-Layer Sync Checklist

When a DB shape changes, ask these questions.

### `packages/db`

- Did the schema file change correctly?
- Did `schema/index.ts` export stay correct?
- Did the migration generate cleanly?

### `packages/shared`

- Are shared types or validators affected?
- Are shared constants or enums affected?

### `server`

- Do route payloads need to change?
- Do services need to read or write the new field?
- Do company-scoping checks still hold?
- Do activity logs, approvals, budgets, or runtime scheduling logic need updates?

### `ui`

- Do API response assumptions change?
- Do forms, views, or filters need updating?
- Are empty states or errors affected?

### docs and tests

- Does the change alter how developers operate the system?
- Do existing tests need fixtures updated?
- Should new tests cover the new invariant?

## 4. Recommended Verification

For a serious DB change, run:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

That is also the repo's definition-of-done baseline in `AGENTS.md`.

If you cannot run something, report it explicitly.

## 5. How To Think About Different Change Types

### Add a new table

Usually straightforward if you:

- include company scoping when needed
- add indexes for expected queries
- export it from `schema/index.ts`
- wire server/shared/ui consumers

### Add a new nullable column

Usually low risk.

Still check:

- should it be indexed?
- should old rows get backfilled later?
- will API consumers assume it is always present?

### Add a required column

Higher risk.

You may need:

- a default
- a backfill strategy
- or a staged rollout

### Rename a column or table

High risk.

Generated migrations may represent this as drop-plus-add instead of a true rename. Review the SQL carefully.

### Drop a column or table

Very high risk.

Before dropping, search the repo for every usage and decide whether an expand-contract rollout is safer.

## 6. Safe Mindset For Bigger Changes

For non-trivial DB changes, prefer:

- add first
- migrate reads/writes
- backfill if needed
- remove old shape later

That is safer than "rename in one shot and hope every layer updated correctly."

## 7. Search Strategy Before Touching A Table

Before editing a central table, search for its usage.

Useful command patterns:

```sh
rg "issues\\b" server ui packages
rg "companyId" server packages/db ui
rg "roleDefinitionId" server ui packages
```

This helps you estimate blast radius before you generate the migration.

## 8. Common Paperclip-Specific Traps

### Trap 1: forgetting company boundaries

A table that should be company-scoped but is not will create downstream auth and query bugs.

### Trap 2: forgetting public exports

New schema files must be exported.

### Trap 3: changing DB shape but not shared/server/ui contracts

This is one of the most common multi-package repo mistakes.

### Trap 4: underestimating runtime tables

Tables like `heartbeat_runs`, `agent_runtime_state`, `agent_task_sessions`, and `workspace_runtime_services` may look operational, but they are tightly tied to background execution and recovery behavior.

### Trap 5: trusting generated SQL without reading it

Always inspect the migration file.

## 9. A Good PR Description For DB Changes

When opening a DB-affecting PR, describe:

1. which schema files changed
2. what migration was generated
3. which contracts were updated
4. whether backfill or staged rollout is needed
5. what verification was run

That makes review dramatically easier.

## 10. Minimal Example Workflow

```sh
# 1. edit schema source
# 2. export from schema/index.ts if needed
pnpm db:generate
pnpm -r typecheck
pnpm test:run
pnpm build
```

## 11. What To Read Next

If you want to understand runtime operations after the schema change lands, continue to [06-ops-and-backups.md](./06-ops-and-backups.md).
