# `@arceus/db`

The database package. Owns the schema, migrations, repos, and the postgres
client. Every read/write in Arceus that touches durable state goes through
here.

## What's in the box

```
packages/db/
├── src/
│   ├── schema/                ← Drizzle table declarations (one file per table)
│   ├── repos/                 ← CRUD functions over the schema (one file per table)
│   ├── migrations/            ← Numbered SQL files + Drizzle journal/snapshots
│   │   └── meta/
│   ├── scripts/               ← Migration runner, lint, EXPLAIN helpers
│   ├── codecs/                ← Custom column codecs (jsonb shape narrowing)
│   ├── constants/             ← Pure constants (e.g. embedding dimensions)
│   ├── client.ts              ← Postgres + Supabase client singletons
│   ├── load-env.ts            ← .env loader (called by client.ts)
│   ├── tables.ts              ← Legacy shim — only `trustScoresTable` left
│   ├── seed.ts                ← Local-dev seed data
│   ├── types.ts               ← Shared types
│   └── index.ts               ← Barrel
├── tests/
│   └── drift.test.ts          ← Schema-vs-snapshot drift detector
├── drizzle.config.ts          ← Drizzle Kit config
├── PERFORMANCE.md             ← Hot-path query audit
└── README.md                  ← (this file)
```

## Quick start

```bash
# Install postgres and start it
brew install postgresql@18
brew services start postgresql@18

# Create the dev database
psql -d postgres -c "CREATE DATABASE arceus_dev;"
psql -d arceus_dev -c "
  CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
  CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram search indexes
  CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector for embeddings
"

# Point the app at it
echo 'DATABASE_URL=postgresql://localhost:5432/arceus_dev' >> .env

# Apply all migrations
bun run --cwd packages/db db:migrate

# Verify
psql -d arceus_dev -c "\dt" | wc -l   # should be ~37 (35 tables + headers)
```

For a full setup walkthrough including `.env` migration off Supabase,
see [`plans/DB-redesign/03-cofounder-setup.md`](../../plans/DB-redesign/03-cofounder-setup.md).

## NPM scripts

| Script | What it does |
|--------|--------------|
| `db:migrate` | Apply pending migrations via the advisory-lock runner. **Use this.** |
| `db:migrate:raw` | Run `drizzle-kit migrate` directly without the lock. Don't use in CI/prod. |
| `db:generate` | Diff schema against the latest snapshot, emit a new migration SQL file. |
| `db:push` | Push the schema directly without a migration file. Dev-only, never prod. |
| `db:studio` | Open Drizzle Studio (web UI for browsing the DB). |
| `db:lint-migrations` | Catches DDL+DML mixed in one migration. Fails CI. |
| `db:seed` | Insert local-dev seed data (8 agents, 10 tasks, etc). |
| `db:explain-audit` | Run EXPLAIN ANALYZE on hot-path audit-ledger queries. |
| `typecheck` | `tsc -p tsconfig.json` |
| `build` | Compile to `dist/` (only used by Docker). |

Run from anywhere in the monorepo:

```bash
bun run --cwd packages/db <script>
```

## The four layers

### 1. Schema (`src/schema/`)

Drizzle table declarations. One file per table. Every table has a uuid PK,
real FKs, and CHECK constraints where the contract uses Zod enums. See
[`01-architecture.md`](../../plans/DB-redesign/01-architecture.md) for the
full table inventory and FK cascade graph.

```ts
// src/schema/tasks.ts
export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, {
    onDelete: "cascade",
  }),
  // ...
}, (table) => ({
  companyStatusIdx: index("tasks_company_status_idx").on(table.companyId, table.status),
}));
```

Re-exported from `src/schema/index.ts`. Add new tables both there and in
the table file itself.

### 2. Repos (`src/repos/`)

CRUD functions over the schema. One file per table. Every function takes
`db: DbClient` first so it works inside transactions; every function
translates friendly ids ↔ uuids at the boundary.

```ts
// src/repos/tasks.ts
export const toDbId = friendlyToUuid;
export function fromDbId(uuid: string, friendlyHint?: string | null): string {
  return friendlyHint ?? uuid;
}

export async function findTaskById(db: DbClient, id: string): Promise<Task | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, toDbId(id))).limit(1);
  return row ?? null;
}
```

Repo files are pure — no module-level state, no `getDb()` calls inside.
The caller decides what client (pool or transaction) to pass in. See
[`04-the-repo-layer.md`](../../plans/DB-redesign/04-the-repo-layer.md) for
the full pattern.

### 3. Migrations (`src/migrations/`)

Numbered SQL files. The journal at `meta/_journal.json` lists them in
order; `apply-migrations.ts` runs them under a Postgres advisory lock so
two pods can't race on `CREATE TABLE`.

```
0000_initial_normalized_schema.sql              ← all canonical tables
0001_fk_covering_indexes.sql                    ← perf indexes
0002–0014                                       ← bridge columns / phases
0015_phase7_drop_legacy_hippocampus.sql         ← DROP SCHEMA hippocampus
0016_phase7a_unmigrated_schemas.sql             ← hierarchy/ideas/etc
0017_phase7_drop_legacy_runtime_tables.sql      ← DROP company_states, beat_records
0018_phase7_sprint_snapshots_data_column.sql    ← ADD COLUMN snapshot_data
0019_phase7_skill_mutations_table.sql           ← CREATE TABLE skill_mutations
```

Generate new migrations with `db:generate`. The lint script
(`db:lint-migrations`) catches the most common bug: mixing DDL
(`CREATE`/`ALTER`) with DML (`INSERT`/`UPDATE`) in one file. Split them.

### 4. Client (`src/client.ts`)

Lazy-singleton accessors:

```ts
import { getDb, getSupabaseClient, isDatabaseConfigured, isSupabaseConfigured } from "@arceus/db";

if (isDatabaseConfigured()) {
  const tasks = await getDb().select().from(tasks);
}

if (isSupabaseConfigured()) {
  const { data } = await getSupabaseClient().storage.from("artifacts").list();
}
```

Connection config is read from env vars in this order of preference:

```
SUPABASE_DB_URL  >  ARCEUS_HIPPOCAMPUS_POSTGRES_URL  >  DATABASE_URL
```

Pool sizing defaults to 10. Override with `ARCEUS_DB_POOL_SIZE`. Sizing
guidance: `(api replicas × pool_size) + headroom <= max_connections`.

## How to use this package

**From outside the package** (`apps/api`, `packages/company-runtime`, etc):

```ts
// Read
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
const task = await tasksRepo.findTaskById(getDb(), "tsk_abc");

// Write
import { getDb } from "@arceus/db";
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";
await tasksRepo.upsertTask(getDb(), { id: "tsk_abc", ... });

// Transaction
await getDb().transaction(async (tx) => {
  await tasksRepo.upsertTask(tx, ...);
  await artifactsRepo.upsertArtifact(tx, ...);
  // both commit, or both roll back
});

// Schema imports for direct queries
import { getDb, tasks, sprints } from "@arceus/db";
import { eq } from "drizzle-orm";
const rows = await getDb().select().from(tasks).where(eq(tasks.sprintId, ...));
```

**Import paths to know:**

```ts
import { getDb, isDatabaseConfigured } from "@arceus/db";       // client + flags
import { tasks, agents, companies } from "@arceus/db";          // schema tables
import * as tasksRepo from "@arceus/db/src/repos/tasks.js";     // CRUD functions
import { friendlyToUuid } from "@arceus/db/src/repos/_uuid.js"; // id translation
```

## Friendly IDs ↔ UUIDs

The contract layer uses friendly id strings (`tsk_abc`, `agent_ceo_xyz`,
`beat_5_1234567890`); the schema uses uuid PKs. The bridge is uuidv5
hashing with a fixed namespace:

```ts
// src/repos/_uuid.ts
export const ARCEUS_UUID_NS = "8eb53fc9-9111-4f3f-a16d-0c8f7e2c7bb5";
export const friendlyToUuid = (friendly: string): string =>
  UUID_RE.test(friendly) ? friendly : uuidv5(friendly, ARCEUS_UUID_NS);
```

Every repo file re-exports this as `toDbId`. Every domain table that
needs friendly-id round-trip has a `friendly_id text` column that gets
stamped on insert and used on read via `fromDbId(uuid, row.friendlyId)`.

**Don't change `ARCEUS_UUID_NS` after data exists** — it would invalidate
every PK derived from a friendly string.

## Adding a new table

Five steps:

1. Write the schema declaration: `src/schema/<table>.ts`.
2. Add to the schema barrel: `src/schema/index.ts`.
3. Run `bun run --cwd packages/db db:generate` to emit a migration.
4. Write the repo: `src/repos/<table>.ts`.
5. Apply locally: `bun run --cwd packages/db db:migrate`.

See [`06-recipes.md`](../../plans/DB-redesign/06-recipes.md#2-add-a-new-table-from-scratch)
for a worked example with copy-pasteable code.

## Adding a new column

Three steps:

1. Edit the schema file: add the column to the table declaration.
2. `db:generate` to emit the ALTER migration. Verify the SQL.
3. `db:migrate` to apply.

The repo keeps working — drizzle's `$inferSelect` picks up the new
column automatically. If you need a CRUD path that reads/writes it,
add or update a repo function.

For backfills, write a separate DML-only migration (don't mix with DDL).
See [`06-recipes.md`](../../plans/DB-redesign/06-recipes.md#8-backfill-data-after-a-schema-change).

## Migrations: do's and don'ts

### Do

- Use `db:generate` and review the output before committing.
- Write `IF EXISTS` / `IF NOT EXISTS` on DDL that might run against partially-migrated dbs.
- Use `CREATE INDEX CONCURRENTLY` for indexes on large tables in prod (won't generate via Drizzle Kit; hand-edit the migration).
- Lint with `db:lint-migrations` before committing.
- Test against a fresh `arceus_dev` (drop + create + migrate from scratch).
- Update `meta/_journal.json` if you hand-add a migration.

### Don't

- Mix DDL and DML in one migration (the linter blocks this).
- Edit a migration that's already been applied to anyone else's DB. Generate a forward-only migration instead.
- Use `db:push` against any database other than your own dev box. It bypasses migrations and rewrites schema directly.
- Add columns to legacy `tables.ts` declarations. That file is the deprecated shim — only `trustScoresTable` remains.
- Skip `db:lint-migrations` in CI.

## Tests

```bash
bun test packages/db/tests/drift.test.ts
```

The drift test is the single most important DB test in the repo. It
catches:

- Schema files that diverge from the snapshot (forgot to run `db:generate`).
- Snapshot files that diverge from the schema (manually edited the wrong file).
- Missing journal entries.

If you change anything under `src/schema/` and the drift test fails, run
`db:generate`, commit the resulting migration + updated snapshot, and
re-run.

## Performance

See [`PERFORMANCE.md`](./PERFORMANCE.md) for the hot-path query audit.
The runtime fires ~9 queries per beat per role × 8 roles every 15s, so
seq scans on tables that grow unbounded (heartbeat_runs, cost_events,
activity_log) will bite. Every query in the audit has an EXPLAIN
verifying it's index-backed.

When in doubt:

```bash
psql -d arceus_dev -c "EXPLAIN ANALYZE <your-query>;"
```

If you see `Seq Scan on <large_table>` in a hot path, add a covering
index in a new migration.

## Debugging

### Schema confusion

`\d <table>` in psql shows what the DB actually has. Trust the DB, not
the code:

```bash
psql -d arceus_dev -c "\d heartbeat_runs"
```

### Migration drift

```bash
psql -d arceus_dev -c "SELECT id FROM drizzle.__drizzle_migrations ORDER BY id;"
ls packages/db/src/migrations/*.sql | wc -l
```

The first should match the second. If lower, run `db:migrate`. If matched
but you suspect drift, the safest fix is drop + recreate locally.

### Connection pool exhaustion

```
Error: timeout exceeded when trying to connect
```

Check `ARCEUS_DB_POOL_SIZE` and the DB's `max_connections`. The math:

```
max_connections >= (api_replicas × pool_size) + (other_clients) + 5
```

Bump `ARCEUS_DB_POOL_SIZE` for dev if you're seeing this with a single
process — it almost certainly means a connection isn't being returned to
the pool (look for missing `await` on a query inside a long-running
operation).

### "schema 'hippocampus' does not exist"

Your `.env` still has `ARCEUS_HIPPOCAMPUS_POSTGRES_SCHEMA=hippocampus`.
The schema was dropped in migration 0015 — remove that env var. See
[`03-cofounder-setup.md`](../../plans/DB-redesign/03-cofounder-setup.md#troubleshooting).

## Project layout reference

| Path | Read this when… |
|------|-----------------|
| `src/schema/<table>.ts` | You want to know the actual shape of a table. |
| `src/schema/index.ts` | You're adding a new table and need to register the export. |
| `src/repos/<table>.ts` | You want to read/write a table from app code. |
| `src/repos/_uuid.ts` | You're working with friendly id translation. |
| `src/repos/_helpers.ts` | You need the `DbClient` type. |
| `src/migrations/*.sql` | You want to know how a column got added. |
| `src/migrations/meta/_journal.json` | You're hand-adding a migration. |
| `src/scripts/apply-migrations.ts` | You're debugging the migration runner. |
| `src/client.ts` | Connection config or pool sizing. |
| `tables.ts` | **Don't.** Legacy shim, only `trustScoresTable` remains. |

## Further reading

- [`plans/DB-redesign/00-overview.md`](../../plans/DB-redesign/00-overview.md)
  — TL;DR of the whole spec-31 cleanup.
- [`plans/DB-redesign/01-architecture.md`](../../plans/DB-redesign/01-architecture.md)
  — Schema architecture and FK graph.
- [`plans/DB-redesign/04-the-repo-layer.md`](../../plans/DB-redesign/04-the-repo-layer.md)
  — Deep dive on the repo pattern.
- [`plans/DB-redesign/05-data-flow-and-transactions.md`](../../plans/DB-redesign/05-data-flow-and-transactions.md)
  — How reads and writes flow through the stack.
- [`plans/DB-redesign/06-recipes.md`](../../plans/DB-redesign/06-recipes.md)
  — Practical recipes for common changes.
- [`plans/specs/31b-phase7-b5-2-trust-model-migration.md`](../../plans/specs/31b-phase7-b5-2-trust-model-migration.md)
  — The deferred trust model migration (last legacy table).
- [`PERFORMANCE.md`](./PERFORMANCE.md) — Hot-path query audit.
