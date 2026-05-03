# Recipes

Practical how-tos for the most common DB-related changes. Each recipe is
self-contained — start at the recipe you need, follow the steps, run the
verification.

## Index

1. [Add a new column to an existing table](#1-add-a-new-column-to-an-existing-table)
2. [Add a new table from scratch](#2-add-a-new-table-from-scratch)
3. [Add a new repo function](#3-add-a-new-repo-function)
4. [Add a new domain transaction](#4-add-a-new-domain-transaction)
5. [Add a new index](#5-add-a-new-index)
6. [Reset / wipe the dev database](#6-reset--wipe-the-dev-database)
7. [Generate vs hand-write a migration](#7-generate-vs-hand-write-a-migration)
8. [Backfill data after a schema change](#8-backfill-data-after-a-schema-change)
9. [Run a one-off SQL script](#9-run-a-one-off-sql-script)
10. [Add a route that returns canonical data](#10-add-a-route-that-returns-canonical-data)
11. [Investigate "column does not exist" errors at runtime](#11-investigate-column-does-not-exist-errors-at-runtime)
12. [Test a repo function](#12-test-a-repo-function)

---

## 1. Add a new column to an existing table

Example: add `archived_at: timestamptz` to `tasks`.

**Step 1.** Edit the schema declaration:

```ts
// packages/db/src/schema/tasks.ts
export const tasks = pgTable("tasks", {
  // … existing columns …
  archivedAt: timestamp("archived_at", { withTimezone: true }),  // ← new
});
```

**Step 2.** Generate the migration:

```bash
bun run --cwd packages/db db:generate
```

This emits something like `0020_add_tasks_archived_at.sql`:

```sql
ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamp with time zone;
```

**Step 3.** Verify the generated SQL is what you intended. drizzle-kit
sometimes emits surprising statements (e.g. recreates the table when a
simpler ALTER would do). Edit the file by hand if needed.

**Step 4.** Apply locally:

```bash
bun run --cwd packages/db db:migrate
psql -d arceus_dev -c "\d tasks" | grep archived_at
```

**Step 5.** Update the repo if you need a CRUD path for the new column.
Existing functions keep working (the column defaults to `NULL`).

**Step 6.** Commit the schema change AND the generated migration AND the
journal update together.

---

## 2. Add a new table from scratch

Example: a `task_comments` table for inline notes on tasks.

**Step 1.** Write the schema:

```ts
// packages/db/src/schema/task_comments.ts
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { tasks } from "./tasks.js";
import { agents } from "./agents.js";

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskCreatedIdx: index("task_comments_task_created_idx").on(table.taskId, table.createdAt),
    companyCreatedIdx: index("task_comments_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
```

**Step 2.** Add the export to the barrel:

```ts
// packages/db/src/schema/index.ts
export { taskComments } from "./task_comments.js";
```

**Step 3.** Generate the migration:

```bash
bun run --cwd packages/db db:generate
```

**Step 4.** Write the repo:

```ts
// packages/db/src/repos/task_comments.ts
import { desc, eq } from "drizzle-orm";
import { taskComments } from "../schema/task_comments.js";
import * as tasksRepo from "./tasks.js";
import * as companiesRepo from "./companies.js";
import * as agentsRepo from "./agents.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;

export const toDbId = friendlyToUuid;
export const fromDbId = (uuid: string, friendlyHint?: string | null): string =>
  friendlyHint ?? uuid;

export async function listByTask(db: DbClient, taskId: string): Promise<TaskComment[]> {
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, tasksRepo.toDbId(taskId)))
    .orderBy(desc(taskComments.createdAt));
}

export async function create(
  db: DbClient,
  data: { companyId: string; taskId: string; authorAgentId: string | null; body: string },
): Promise<TaskComment> {
  const [row] = await db
    .insert(taskComments)
    .values({
      companyId: companiesRepo.toDbId(data.companyId),
      taskId: tasksRepo.toDbId(data.taskId),
      authorAgentId: data.authorAgentId ? agentsRepo.toDbId(data.authorAgentId) : null,
      body: data.body,
    })
    .returning();
  return row;
}
```

**Step 5.** Add to the repo barrel if you use it:

```ts
// packages/db/src/repos/index.ts
export * as taskComments from "./task_comments.js";
```

**Step 6.** Apply migration, run typecheck, commit.

---

## 3. Add a new repo function

Already covered in [`04-the-repo-layer.md`](./04-the-repo-layer.md#adding-a-new-repo-function).
Short version: pick the existing repo file, add a function with `db: DbClient`
first, hash any friendly id inputs via `toDbId`, return drizzle's inferred
`Row[]` or `Row | null`.

---

## 4. Add a new domain transaction

Domain transactions live in `apps/api/src/companies/`, `apps/api/src/sprints/`,
or you can create a new folder for the domain. They wrap multiple repo
writes in a single `db.transaction(async (tx) => ...)` block.

**Skeleton:**

```ts
// apps/api/src/<domain>/<action>.ts
import { getDb } from "@arceus/db";
import * as someRepo from "@arceus/db/src/repos/some.js";
import * as otherRepo from "@arceus/db/src/repos/other.js";

export async function doActionTx(
  companyId: string,
  input: ActionInput,
): Promise<ActionResult> {
  const db = getDb();

  // 1. Compute everything that goes into the transaction up front.
  const someData = computeSomeData(input);
  const otherData = computeOtherData(input);

  // 2. Open the transaction. Sequence writes by FK dependency.
  await db.transaction(async (tx) => {
    await someRepo.upsert(tx, someData);
    await otherRepo.upsert(tx, otherData);
  });

  // 3. Side effects post-commit.
  void someExternalCall(companyId);

  return { /* result */ };
}
```

**Three rules:**

1. **No LLM calls / external HTTP / filesystem ops inside the transaction.**
   They hold the connection open and increase rollback risk.
2. **FK ordering matters.** If table B has an FK to table A, write A
   before B inside the transaction. Use the FK cascade graph in
   [`01-architecture.md`](./01-architecture.md#fk-cascade-graph) to plan
   the order.
3. **Pass `tx` (not `getDb()`) to every repo call inside the body.**
   Otherwise the repo writes go through a separate connection, won't see
   in-flight writes, and won't roll back if the tx aborts.

---

## 5. Add a new index

Two ways: add it to the schema (caught at generate time) or write a manual
migration with `CREATE INDEX CONCURRENTLY` (recommended for large tables in
prod).

### Schema-driven (small tables, fresh installs)

Edit the schema's `(table) => ({ ... })` index block:

```ts
// packages/db/src/schema/tasks.ts
export const tasks = pgTable(
  "tasks",
  { /* columns */ },
  (table) => ({
    // existing indexes …
    statusKindIdx: index("tasks_status_kind_idx").on(table.status, table.kind),  // ← new
  }),
);
```

Then `db:generate` produces the migration:

```sql
CREATE INDEX "tasks_status_kind_idx" ON "tasks" USING btree ("status", "kind");
```

This is fine for new dev databases and small tables.

### Manual migration with `CONCURRENTLY` (large tables in prod)

`CREATE INDEX` blocks writes on the target table for the duration of the
build. On a 1M+ row table that's seconds-to-minutes of write downtime.
Use `CREATE INDEX CONCURRENTLY` to build the index without blocking:

```sql
-- packages/db/src/migrations/0020_tasks_status_kind_idx.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "tasks_status_kind_idx"
  ON "tasks" USING btree ("status", "kind");
```

`CONCURRENTLY` cannot run inside a transaction, so the migration runner's
behaviour matters: drizzle-kit wraps each migration in a transaction by
default. To run a CONCURRENTLY statement, the migration must contain
**only** that statement, and you may need to skip the runner's transaction
wrapping (check the `migrate` function options if this comes up).

The most common pattern: write the schema + a generated migration that
uses plain `CREATE INDEX`, then in the same migration file replace it
with `CREATE INDEX CONCURRENTLY` by hand. Tests still pass on fresh dbs
(table is empty); prod gets the non-blocking build.

---

## 6. Reset / wipe the dev database

```bash
psql -d postgres -c "DROP DATABASE arceus_dev; CREATE DATABASE arceus_dev;"
psql -d arceus_dev -c "
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
"
bun run --cwd packages/db db:migrate
```

Wrap in a script if you do this often. Don't run this against Supabase or
prod — it does what it says.

---

## 7. Generate vs hand-write a migration

| Situation | Approach |
|-----------|----------|
| Adding/removing/renaming a column | `db:generate` — review output |
| Adding/dropping a table | `db:generate` |
| Adding/dropping an index | `db:generate` for plain CREATE; hand-write for CONCURRENTLY |
| `CREATE EXTENSION`, `CREATE FUNCTION`, raw DDL not modeled in drizzle | Hand-write |
| Data migration (`UPDATE ... SET ...`) | Hand-write — `db:generate` only does DDL |
| Drop a column with backfill | Hand-write the backfill, generate the DROP separately |
| Rename a table | Hand-write — drizzle-kit drops + creates by default, which is destructive |

When you hand-write, follow the file naming convention (`NNNN_description.sql`),
add an entry to `packages/db/src/migrations/meta/_journal.json`, and add
a snapshot file if drizzle-kit's tooling expects one (skip for one-off DML
migrations, since drizzle-kit doesn't track DML).

The lint catches DDL+DML in one file:

```bash
bun run --cwd packages/db db:lint-migrations
```

If you mix them, split into two migrations: DDL first, DML second.

---

## 8. Backfill data after a schema change

If you add a new column with a meaningful default that can't be computed
in the ALTER, you'll need a backfill migration.

**Approach:** two migrations.

1. **DDL migration** — add the column nullable.

   ```sql
   ALTER TABLE "tasks" ADD COLUMN "computed_field" text;
   ```

2. **DML migration** — backfill from existing data.

   ```sql
   UPDATE "tasks" SET "computed_field" = lower("title") WHERE "computed_field" IS NULL;
   ```

3. **Optional third migration** — make the column NOT NULL once backfill
   is verified.

   ```sql
   ALTER TABLE "tasks" ALTER COLUMN "computed_field" SET NOT NULL;
   ```

For large tables, do the UPDATE in batches inside a `DO $$ ... $$` block.
Pattern reference is in
[`packages/db/skills/database-migrations.md`](../../skills/database-migrations.md)
if you have it; otherwise the standard form is:

```sql
DO $$
DECLARE
  batch_size INT := 10000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE "tasks"
    SET "computed_field" = lower("title")
    WHERE "id" IN (
      SELECT "id" FROM "tasks"
      WHERE "computed_field" IS NULL
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
    COMMIT;
  END LOOP;
END $$;
```

---

## 9. Run a one-off SQL script

If you need to run SQL that isn't a migration (e.g. inspect data,
manually fix a bad row, run an EXPLAIN), use `psql` directly:

```bash
psql -d arceus_dev -f /path/to/your.sql
# or interactively
psql -d arceus_dev
arceus_dev=> SELECT count(*) FROM tasks WHERE status = 'failed';
```

For repeatable diagnostic queries, drop them in `packages/db/src/scripts/`
as `.ts` files using the `getDb()` client. Examples:

- `packages/db/src/scripts/explain-audit.ts` — runs EXPLAIN ANALYZE on
  hot-path audit queries.
- `packages/db/src/scripts/lint-migrations.ts` — DDL/DML separation lint.

---

## 10. Add a route that returns canonical data

```ts
// apps/api/src/routes/sprints.routes.ts (example fragment)
import { getDb } from "@arceus/db";
import * as sprintsRepo from "@arceus/db/src/repos/sprints.js";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";

app.get("/api/sprints/:id/burndown", async (request) => {
  const { id } = request.params as { id: string };

  // Read directly from canonical via repos
  const sprint = await sprintsRepo.findSprintById(getDb(), id);
  if (!sprint) {
    return reply.code(404).send({ error: "sprint not found" });
  }
  const tasks = await tasksRepo.listTasksBySprint(getDb(), id);

  // Compute the response
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "completed").length;

  return { sprintId: id, total, done, remaining: total - done };
});
```

For routes that return a full snapshot, use `buildSnapshotView`. For
routes that need one slice, call repos directly.

For routes that mutate state, prefer `apps/api/src/persistence/mutations.ts`
helpers over raw repo calls so the audit log + event stream pick up the
change automatically.

---

## 11. Investigate "column does not exist" errors at runtime

You'll see this in two flavors:

**(a) Schema and migration don't agree.**

```
PostgresError: column "foo" of relation "bar" does not exist
```

Check whether the schema declares `foo`:

```bash
grep -n '"foo"' packages/db/src/schema/bar.ts
```

If yes, check whether the migration that adds `foo` is applied:

```bash
psql -d arceus_dev -c "SELECT id FROM drizzle.__drizzle_migrations ORDER BY id;"
ls packages/db/src/migrations/*.sql
```

The migration count in the DB should match the file count. If lower, run
`db:migrate`. If matched but the column still doesn't exist, drop & recreate
the DB (recipe 6) — your local DB has drifted.

**(b) Code uses a column the schema doesn't declare.**

```
Type 'string' is not assignable to type 'never'
```

(Or a runtime error if you bypassed types via `as any`.)

Either add the column to the schema (recipe 1) or update the code to use
the columns that actually exist. `\d <table>` in psql shows the truth.

---

## 12. Test a repo function

Tests live alongside the repo (`packages/db/src/repos/tasks.test.ts`).
Run with `bun test`.

Pattern:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../client.js";
import * as tasksRepo from "./tasks.js";

test("findTaskById returns null for unknown id", async () => {
  const db = getDb();
  const result = await tasksRepo.findTaskById(db, "tsk_does_not_exist");
  assert.equal(result, null);
});

test("upsertTask is idempotent", async () => {
  const db = getDb();
  const data = { /* … fixture … */ };
  const a = await tasksRepo.upsertTask(db, data);
  const b = await tasksRepo.upsertTask(db, data);
  assert.equal(a.id, b.id);  // same row, not a duplicate
});
```

Tests assume `arceus_dev` exists with migrations applied. They don't
clean up after themselves by default — wrap in a transaction-with-rollback
helper if you write tests that mutate:

```ts
async function withRollback<T>(fn: (tx: DbClient) => Promise<T>): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await fn(tx);
    throw new Error("rollback");  // forces rollback after assertions run
  }).catch((err) => { if (err.message !== "rollback") throw err; });
}
```

The drift test (`packages/db/tests/drift.test.ts`) checks that the schema
files agree with the latest snapshot — if you forget to run `db:generate`,
this test catches it. Run it before pushing:

```bash
bun test packages/db/tests/drift.test.ts
```

---

## When in doubt

- **Reading code:** `packages/db/src/schema/<table>.ts` is always the
  truth. Repos are CRUD over the schema; routes are over the repos. Skim
  upward.
- **Reading data:** `psql -d arceus_dev -c "\d <table>"` for the actual
  shape, `SELECT * FROM <table> LIMIT 5` for actual content. Trust the
  DB, not the code, when they disagree.
- **Writing data:** prefer a domain transaction for multi-table writes;
  prefer `mutations.ts` for single-table writes that need audit; prefer
  the repo directly for internal bookkeeping that doesn't need audit.
- **Stuck:** look for the closest existing example. The codebase is big
  and there's almost always a precedent for whatever you're doing.
  `grep -rn "<some-pattern>" apps/ packages/` is your friend.
