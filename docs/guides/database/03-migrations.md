# Migrations

This guide explains how schema changes become migration files and how those migrations are applied at runtime.

## 1. The Migration Pipeline

The migration flow in this repo is:

1. edit TypeScript schema in `packages/db/src/schema/*.ts`
2. export new tables from `packages/db/src/schema/index.ts`
3. run `pnpm db:generate`
4. review generated SQL in `packages/db/src/migrations/`
5. run migrations with `pnpm db:migrate` or let server startup handle them

That sounds like standard Drizzle, but this repo adds custom inspection and repair logic around that flow.

## 2. Why `drizzle.config.ts` Uses `dist/schema/*.js`

File:

- `packages/db/drizzle.config.ts`

Config:

```ts
export default defineConfig({
  schema: "./dist/schema/*.js",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

This is one of the most important implementation details in the package.

It means:

- Drizzle generation does not read raw TypeScript source directly
- it reads the compiled schema output in `dist/schema/*.js`

Why this matters:

- the package must compile first
- generated migrations depend on the built output
- forgetting that detail can make migration behavior feel confusing

This is why `AGENTS.md` explicitly calls it out.

## 3. The Package Scripts

File:

- `packages/db/package.json`

Important scripts:

- `build`: `tsc && cp -r src/migrations dist/migrations`
- `generate`: `tsc -p tsconfig.json && drizzle-kit generate`
- `migrate`: `tsx src/migrate.ts`

And at the repo root:

- `pnpm db:generate`
- `pnpm db:migrate`

So the normal generate path is:

1. compile `packages/db`
2. run Drizzle generate against compiled schema

## 4. Where Migrations Live

Generated migrations live in:

- `packages/db/src/migrations/`

That folder contains:

- `.sql` migration files
- Drizzle metadata, especially `meta/_journal.json`

Think of it as two layers:

- SQL files are the real schema changes
- the journal is Drizzle's ordered history metadata

## 5. Why `client.ts` Is So Important

File:

- `packages/db/src/client.ts`

This file does much more than create a DB client.

It provides:

- `createDb(url)`
- `inspectMigrations(url)`
- `applyPendingMigrations(url)`
- `reconcilePendingMigrationHistory(url)`
- `migratePostgresIfEmpty(url)`
- `ensurePostgresDatabase(url, dbName)`

This is where the repo's custom migration intelligence lives.

## 6. Migration Inspection

`inspectMigrations(url)` asks:

- what migration files exist in the repo?
- what migration history exists in the database?
- how many base tables already exist?
- is the DB up to date or missing migrations?

It returns either:

- `upToDate`
- `needsMigrations`

And when migrations are needed, it gives a reason:

- `no-migration-journal-empty-db`
- `no-migration-journal-non-empty-db`
- `pending-migrations`

These reasons matter.

### `no-migration-journal-empty-db`

The DB is basically empty and there is no migration history.

This is the cleanest case for bootstrapping.

### `no-migration-journal-non-empty-db`

Tables already exist, but the migration journal is missing.

This is a warning case because the schema may be partly real but migration history is not trustworthy.

### `pending-migrations`

The DB knows about some history, but the repo has newer migrations available.

This is the normal "you need to apply new migrations" case.

## 7. Drift Repair Logic

One of the more advanced parts of this repo is:

- `reconcilePendingMigrationHistory(url)`

This exists because real systems drift.

Possible drift situations:

- a schema change got applied manually
- migration history exists but is incomplete
- files or hashes changed
- a DB has the structure but not the expected journal rows

The repair logic tries to help in the safe cases by checking whether migration statements appear to have already been applied.

The code can reason about cases like:

- `CREATE TABLE`
- `ADD COLUMN`
- `CREATE INDEX`
- `ADD CONSTRAINT`

If it can prove the migration's effects already exist, it can repair migration history entries instead of forcing a destructive or confusing re-run.

That is a major reason this package is more sophisticated than plain Drizzle scaffolding.

## 8. Applying Migrations

`applyPendingMigrations(url)` applies migrations that `inspectMigrations(url)` says are pending.

Important behavior:

- migration files are ordered using the journal
- SQL content is split by statement breakpoints
- history rows are recorded in `__drizzle_migrations`
- hashes and timestamps are used when possible

There is also a manual application path inside `client.ts`, not just a single off-the-shelf Drizzle migrate call.

That helps the package support history repair and compatibility with older migration-table shapes.

## 9. The CLI Entry Points

### `packages/db/src/migrate.ts`

This is the command behind:

- `pnpm db:migrate`

What it does:

1. resolves which DB to use
2. prints which source it is migrating through
3. inspects current migration state
4. applies pending migrations if needed
5. verifies that the DB ends up up to date

### `packages/db/src/migration-status.ts`

This is the "tell me where we stand" command.

It can print:

- human-readable status
- or JSON with `--json`

This is useful for tooling, automation, or debugging.

## 10. How Server Startup Uses Migrations

The server does not blindly start and hope the schema is correct.

In `server/src/index.ts`, startup:

1. selects the active database target
2. inspects migration state
3. tries to reconcile drift if the DB looks partially applied
4. decides whether to auto-apply, prompt, or refuse startup

Important behavior:

- first-run embedded Postgres setups auto-apply migrations
- external Postgres can require manual confirmation unless env flags say otherwise
- startup refuses to continue against a stale schema if the user declines migration application

This makes startup safer, especially for persistent databases.

## 11. Prompting vs Auto-Apply

Server startup has a helper that may ask:

- should pending migrations be applied now?

Relevant env controls include:

- `PAPERCLIP_MIGRATION_PROMPT=never`
- `PAPERCLIP_MIGRATION_AUTO_APPLY=true`

Important nuance:

- non-interactive environments do not block waiting for keyboard input
- they default to continuing with migration application logic instead of hanging forever

## 12. What To Review In A Generated Migration

After running `pnpm db:generate`, review the SQL before merging.

Look for:

- unexpected drops
- unintended renames that look like drop-plus-add
- missing indexes
- wrong nullability
- backfill-sensitive changes
- business invariants that should become unique indexes or constraints

Do not treat generated SQL as automatically correct just because Drizzle produced it.

## 13. Common Safe And Risky Changes

Usually safer:

- add nullable column
- add new table
- add new index
- add new non-breaking foreign key

Usually riskier:

- rename column
- drop column
- make nullable column required without backfill
- split one table into several tables
- change semantics of company scoping

## 14. Commands To Remember

Generate a migration:

```sh
pnpm db:generate
```

Apply migrations:

```sh
pnpm db:migrate
```

Check all workspace types:

```sh
pnpm -r typecheck
```

## 15. The Most Important Rule

In this repo, a DB migration is not done when the SQL file exists.

It is done when all of these are true:

1. schema source changed correctly
2. migration SQL looks correct
3. public schema exports are correct
4. server/shared/ui contracts are synchronized
5. runtime startup still behaves correctly

## 16. What To Read Next

If you want to understand how migration commands choose a DB target, continue to [04-runtime-resolution.md](./04-runtime-resolution.md).
