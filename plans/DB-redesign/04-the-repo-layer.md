# The Repo Layer

If you've never touched the new code: every read and every write goes through
the **repo layer** at `packages/db/src/repos/`. There is one file per table,
each exporting a small set of functions over drizzle queries. Routes don't
talk to drizzle directly anymore; they call into a repo.

This file teaches the repo pattern from scratch. Once it clicks the rest of
the codebase reads itself.

## Why repos exist

Three reasons:

1. **Centralize the friendly↔uuid translation.** Friendly ids
   (`tsk_abc`, `agent_ceo_xyz`) live in contracts and routes; uuid PKs live
   in Postgres. The repo is the single place where they cross. If the
   translation lived in routes, every route would need to know the namespace
   and the hashing function.

2. **One transaction-aware client signature.** Every repo function takes
   `db: DbClient` as the first arg. Pass `getDb()` for normal calls; pass
   the `tx` from inside `db.transaction(async (tx) => ...)` to atomically
   bundle multiple writes. No ambient state, no module-level connection.

3. **Pure functions over drizzle queries.** Repos don't hold cache, don't
   emit events, don't validate beyond what drizzle provides. They turn a
   call into a query and return the row. Anything fancier (validation,
   event emission, audit logging) lives in `apps/api/src/persistence/` or
   the domain transactions (`apps/api/src/companies/`,
   `apps/api/src/sprints/`).

## The shape of a repo file

Open `packages/db/src/repos/tasks.ts`. Every repo follows this skeleton:

```ts
// 1. Imports — drizzle helpers + the schema declaration + types
import { and, eq } from "drizzle-orm";
import type { Task as ContractTask } from "@arceus/contracts";
import { tasks } from "../schema/tasks.js";
import type { DbClient } from "./_helpers.js";
import { friendlyToUuid } from "./_uuid.js";

// 2. Inferred types from the schema
export type Task = typeof tasks.$inferSelect;     // What a SELECT returns
export type NewTask = typeof tasks.$inferInsert;  // What an INSERT accepts
export type TaskStatus = Task["status"];

// 3. ID translation — every repo exports these two
export const toDbId = friendlyToUuid;
export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}

// 4. CRUD functions, all taking `db: DbClient` first
export async function findTaskById(db: DbClient, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, toDbId(id))).limit(1);
  return row ?? null;
}

export async function listTasksByCompany(db: DbClient, companyId: string): Promise<Task[]> {
  return db.select().from(tasks).where(eq(tasks.companyId, toDbId(companyId)));
}

export async function upsertTask(db: DbClient, data: NewTask): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values(data)
    .onConflictDoUpdate({
      target: tasks.id,
      set: { /* fields to update on conflict */ },
    })
    .returning();
  return row;
}

// 5. Optional: a contract↔row mapper helper if the shapes differ
export function rowToTask(row: Task): ContractTask {
  return { id: fromDbId(row.id, row.friendlyId), /* ... */ };
}
```

That's it. Reading any repo in `packages/db/src/repos/` follows this
pattern. Once you've read one, the rest are skim-readable.

## The translation pair: `toDbId` and `fromDbId`

These two functions are the heart of the repo layer. Every PK or FK column
goes through one of them.

```ts
export const toDbId = friendlyToUuid;
export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}
```

- **`toDbId(friendly)`** — hashes a friendly string via uuidv5 with the
  fixed namespace constant `ARCEUS_UUID_NS` (in `_uuid.ts`). Idempotent on
  uuid strings (passes through unchanged via the `UUID_RE` test). Use this
  on every value going **into** a query: `eq(tasks.id, toDbId(taskId))`,
  `companyId: toDbId(input.companyId)`, etc.

- **`fromDbId(uuid, friendlyHint)`** — restores the friendly form when a
  hint is available, otherwise returns the uuid string. Use this on every
  value going **out** of a query that's destined for a contract or HTTP
  response.

The friendly hint typically comes from a column the schema reserves for
this purpose: `friendly_id text` on `tasks`, `companies`, `agents`,
`artifacts`, `skill_artifacts`, etc. The insert path stamps it; the
read path pulls it back out.

```ts
// Insert: stamp the friendly id
await db.insert(tasks).values({
  id: toDbId("tsk_abc"),       // → uuidv5("tsk_abc", ARCEUS_UUID_NS)
  friendlyId: "tsk_abc",       // ← stash the original
  // ...
});

// Read: restore via fromDbId
const row = await findTaskById(db, "tsk_abc");
return { id: fromDbId(row.id, row.friendlyId) /* → "tsk_abc" */ };
```

Tables without a `friendly_id` column (e.g. `heartbeat_runs`) use
`fromDbId(uuid)` and just return the uuid string — that's fine for
internal-only ids that don't need to be human-readable.

## The DbClient type and transactions

```ts
import type { DbClient } from "./_helpers.js";
```

`DbClient` is the type returned by both `getDb()` (a long-lived pool) and
`db.transaction(async (tx) => ...)` (a single backend connection inside a
transaction). They satisfy the same interface, so any repo function works
in either.

**Outside a transaction** — most calls:

```ts
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";

const task = await tasksRepo.findTaskById(getDb(), "tsk_abc");
```

**Inside a transaction** — when you need atomicity across multiple writes:

```ts
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
import * as artifactsRepo from "@arceus/db/src/repos/artifacts.js";

await getDb().transaction(async (tx) => {
  await tasksRepo.upsertTask(tx, taskData);
  await artifactsRepo.upsertArtifact(tx, artifactData);
  // both commit, or both roll back
});
```

This is why every repo function takes `db: DbClient` first instead of
calling `getDb()` internally — the caller controls whether the call is
transactional.

## The schema → repo → consumer chain

```
packages/db/src/schema/tasks.ts             ← drizzle table declaration
        ↓
packages/db/src/repos/tasks.ts              ← CRUD functions
        ↓
apps/api/src/persistence/mutations.ts       ← async wrappers (with audit, events)
        ↓
apps/api/src/routes/<something>.routes.ts   ← HTTP handler
```

Schema declares the shape. Repo turns it into CRUD. `mutations.ts` wraps
the repo with cross-cutting concerns (audit ledger writes, event emission,
in-memory state updates). Routes call `mutations.ts` for writes and
either repos or `buildSnapshotView` for reads.

You can absolutely call a repo directly from a route — that's fine for
read-only handlers. Use `mutations.ts` when you want the audit trail and
event side-effects.

## Worked example: the `companies` repo

Open `packages/db/src/repos/companies.ts`. This is the simplest repo and
worth reading top-to-bottom.

```ts
// Inferred types
export type Company = typeof companies.$inferSelect;

// Translation — note `fromDbId` accepts a friendly hint from row.friendlyId
export const toDbId = friendlyToUuid;
export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}

// findCompanyById: friendly id in, row out
export async function findCompanyById(db: DbClient, id: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, toDbId(id))).limit(1);
  return row ?? null;
}

// listCompanies: no inputs, return all rows (only used at startup)
export async function listCompanies(db: DbClient): Promise<Company[]> {
  return db.select().from(companies);
}

// findByIdHydrated: row → contract shape
export async function findByIdHydrated(db: DbClient, id: string): Promise<ContractCompany | null> {
  const row = await findCompanyById(db, id);
  if (!row) return null;
  return {
    id: fromDbId(row.id, row.friendlyId),  // ← here's the round-trip
    name: row.name,
    // ...
  };
}
```

`findCompanyById` does the lookup in O(1) via the uuid PK. `findByIdHydrated`
adds the friendly-id round-trip so callers get back the `company_<uuid>`
form they expect, not the raw uuid.

## Adding a new repo function

Say you want a `listCompletedTasksBySprint` query. Open
`packages/db/src/repos/tasks.ts` and add:

```ts
export async function listCompletedTasksBySprint(
  db: DbClient,
  sprintId: string,
): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.sprintId, toDbId(sprintId)),
      eq(tasks.status, "completed"),
    ));
}
```

That's the whole change. The function:
- takes `db: DbClient` first (transaction-friendly)
- maps the friendly `sprintId` to a uuid via `toDbId`
- uses drizzle's `and(...)` + `eq(...)` for the WHERE clause
- returns `Task[]` (the inferred select type)

Now consumers can call it:

```ts
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
const completed = await tasksRepo.listCompletedTasksBySprint(getDb(), "spr_3");
```

If the function gets used a lot, consider whether the underlying query
hits a covering index. Check `packages/db/src/migrations/0001_fk_covering_indexes.sql`
to see what's indexed; if your query pattern isn't covered, add an index
in a new migration.

## Conventions & gotchas

### Always pass `db: DbClient` first

Even if the function never gets called from inside a transaction today,
keep the signature consistent — it's the codebase convention and someone
will eventually need to use it transactionally.

### Don't `getDb()` inside repos

Repos are pure. The caller decides what client to use. Calling `getDb()`
inside a repo would silently break transactional callers — they'd think
they were inside their tx but the repo would use a separate connection
that doesn't see the in-flight writes.

### Use `onConflictDoUpdate`, not `INSERT … RETURNING`

Most upserts in the codebase use `.onConflictDoUpdate({ target: ..., set: ... })`.
This makes calls idempotent (re-running a domain transaction doesn't
explode on duplicate-key errors) and matches Postgres's `INSERT ... ON
CONFLICT ... DO UPDATE` natively.

```ts
await db
  .insert(tasks)
  .values(data)
  .onConflictDoUpdate({
    target: tasks.id,
    set: { status: data.status, updatedAt: new Date() },
  });
```

Don't list every column in `set`; only the ones that should overwrite on
re-insert. Things like `created_at` should never be in `set` — you'd
clobber the original timestamp.

### Don't call `.returning()` if you don't need the row

It costs an extra round-trip in some Postgres drivers. Use it for inserts
where you need the auto-generated id (e.g. the row's createdAt or PK was
defaulted) — skip it for fire-and-forget upserts.

### Validate at the route layer, not the repo

Repos trust their inputs. If a route lets a user submit garbage and pipes
it straight to a repo, that's the route's bug. Use Zod schemas at the
route boundary; repos accept the post-parse types.

### Friendly id stamping is opt-in

Not every table has a `friendly_id` column. Look at the schema before
assuming. If the schema has one, stamp it on insert and use it in
`fromDbId(uuid, row.friendlyId)` on reads. If not, just return the uuid.
Don't add a `friendly_id` column unless callers actually need to round-trip
the friendly form.

## Repo barrel — `repos/index.ts`

`packages/db/src/repos/index.ts` re-exports each repo as a namespace:

```ts
export * as companies from "./companies.js";
export * as agents from "./agents.js";
export * as tasks from "./tasks.js";
// ...
```

Most consumers import directly (`import * as tasksRepo from "@arceus/db/src/repos/tasks.js"`)
because it's clearer where each function comes from. The barrel exists for
the rare case where you want to grab three repos in one line:

```ts
import { tasks, agents, sprints } from "@arceus/db/repos";
await tasks.findTaskById(db, "tsk_abc");
await agents.findAgentById(db, "agent_ceo_xyz");
```

Either style is fine; the direct imports are what most of the codebase
uses today.

## Where the legacy `tables.ts` fits

`packages/db/src/tables.ts` is the **deprecated** transitional shim — text-PK
type-views over physical tables that have since been retired or moved. After
the spec 31 cleanup, only `trustScoresTable` remains there (deferred to
plan 31b). You will never need to add to `tables.ts`. If you find yourself
wanting to, you almost certainly want to be adding a new schema file under
`packages/db/src/schema/` instead.
