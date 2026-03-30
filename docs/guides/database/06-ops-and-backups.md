# Operations And Backups

This guide explains the operational side of the DB layer: where data lives, how backups work, and how to debug real runtime problems.

## 1. Embedded Postgres In Dev

By default, local development runs with embedded Postgres when `DATABASE_URL` is unset.

Existing repo docs describe the default storage under the Paperclip instance directory.

The important idea is:

- local dev still uses PostgreSQL
- the app manages the process and data directory for you

This is why `pnpm dev` can work without a manually installed Postgres server.

## 2. What Server Startup Does For The Database

In `server/src/index.ts`, startup can:

- choose external vs embedded Postgres
- initialize embedded Postgres
- ensure the `paperclip` database exists
- inspect and apply migrations
- expose the final DB connection string to runtime consumers
- schedule automatic backups

So the server is not just "connecting to the DB."

It is acting like a small DB orchestrator for local/dev scenarios.

## 3. Backup Logic Lives In `backup-lib.ts`

File:

- `packages/db/src/backup-lib.ts`

This is the real backup engine.

It exports helpers such as:

- `runDatabaseBackup`
- `runDatabaseRestore`
- `formatDatabaseBackupResult`

The DB package public surface re-exports those from `packages/db/src/index.ts`.

## 4. What A Backup Includes

The backup system works by connecting to Postgres and generating SQL output.

It understands:

- schemas
- tables
- enums
- sequences
- row data

It also supports operational options such as:

- retention pruning
- optional inclusion of the Drizzle migration journal
- excluding selected tables
- nullifying selected columns

That means the backup system is more deliberate than a naive "dump everything to one string" script.

## 5. Scheduled Backups From The Server

In `server/src/index.ts`, if DB backups are enabled, the server:

- computes the backup interval
- makes sure only one backup runs at a time
- calls `runDatabaseBackup(...)`
- logs the result
- prunes old backups according to retention settings

This means backups are part of normal server operations, not just manual CLI activity.

## 6. Manual Backup Entry Points

At the package level, there is a lower-level backup script:

- `packages/db/src/backup.ts`

That file:

- resolves config
- chooses a connection string
- chooses backup directory and retention
- runs a backup

At the repo level, the normal developer command is:

- `pnpm db:backup`

That command goes through:

- `scripts/backup-db.sh`
- then `pnpm paperclipai db:backup`

So the day-to-day operator surface is the Paperclip CLI command, while the DB package still contains the underlying backup logic and a package-local script.

## 7. Restore Support

The DB package exports:

- `runDatabaseRestore`

That means the package is designed for both sides of the cycle:

- backup
- restore

Even if the repo emphasizes backup more than restore in day-to-day docs, restore is part of the package's intended operational surface.

## 8. Migration And Drift Debugging

When something feels wrong with migrations, debug in this order.

### Question 1: Which DB am I actually using?

Check:

- `DATABASE_URL`
- `PAPERCLIP_HOME`
- `PAPERCLIP_INSTANCE_ID`
- repo-local `.paperclip/config.json`
- repo-local or instance `.env`

### Question 2: Is the DB reachable?

If embedded mode is in play, ask:

- is embedded Postgres already running?
- is there a stale `postmaster.pid`?
- is the configured port already occupied?
- does the running instance point at the expected data directory?

### Question 3: What does migration inspection say?

Run:

```sh
pnpm db:migrate
```

or use the migration status flow if you are debugging before applying changes.

What you want to distinguish is:

- empty/new DB
- non-empty DB with missing journal
- normal pending migrations
- drift that can be repaired

### Question 4: Is the migration journal the issue?

The custom logic in `client.ts` can repair some states where schema exists but migration bookkeeping is stale.

So a migration problem is not always "schema is wrong."

Sometimes the actual problem is:

- migration history does not reflect current schema reality

## 9. Hosted Postgres Notes

The existing repo docs mention managed Postgres providers such as Supabase.

Important operational idea:

- the schema and migrations are the same
- only the connection target changes

When using hosted providers, be aware of connection-mode differences such as pooled vs direct connections, especially for migration tooling.

## 10. Worktree And Multi-Instance Safety

The repo docs explicitly warn not to point multiple Paperclip servers at the same embedded Postgres data directory.

That matters because embedded Postgres is still a real database cluster with lock files, ports, and process ownership.

If you use worktrees, let each worktree have its own Paperclip instance and DB path.

## 11. Operational Files Worth Knowing

These files matter most in real DB operations:

- `packages/db/src/runtime-config.ts`
- `packages/db/src/migration-runtime.ts`
- `packages/db/src/client.ts`
- `packages/db/src/backup-lib.ts`
- `server/src/index.ts`

## 12. Good Operational Habits

Good habits for DB work in this repo:

- know which DB target you are about to touch
- review generated migrations before applying them
- keep backups enabled for long-lived instances
- isolate worktrees
- treat company-scoped data carefully
- report exactly what verification and migration steps you ran

## 13. What To Read Next

If you are planning larger changes rather than day-to-day edits, continue to [07-revamp-guide.md](./07-revamp-guide.md).
