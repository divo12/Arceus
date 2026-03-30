# Database Overview

This guide answers one question:

What is the database layer in Paperclip, and how does it fit into the rest of the repo?

## 1. Big Picture

Paperclip uses PostgreSQL through Drizzle ORM.

That means:

- PostgreSQL is the actual database engine
- Drizzle is the TypeScript layer that describes tables and helps build queries
- the repo stores schema as TypeScript files, not raw SQL only
- migrations are still real SQL files and are versioned in the repo

The database layer is centered in:

- `packages/db/`

That package is not "just table definitions." It owns three things:

1. schema definitions
2. migration tooling and migration runtime helpers
3. operational helpers such as backup and restore

## 2. Where The DB Sits In The Whole System

The rough dependency flow is:

`packages/db` -> `server` services/routes -> `ui`

More concretely:

1. `packages/db/src/schema/*.ts` defines tables
2. `packages/db/src/index.ts` re-exports schema and DB helpers
3. `server` imports those tables/helpers to connect, query, migrate, and back up
4. `packages/shared` holds many of the shared TypeScript types used by schema and higher layers
5. `ui` and API clients depend on the resulting server contracts, not on the DB package directly

So if you change the database shape, you usually cause follow-on work in:

- `packages/db`
- `packages/shared`
- `server`
- `ui`

That is why `AGENTS.md` explicitly says DB/API/shared/UI contracts must stay synchronized.

## 3. The Important Files

If you are learning this package, these are the highest-value files:

- `packages/db/package.json`
- `packages/db/drizzle.config.ts`
- `packages/db/src/index.ts`
- `packages/db/src/client.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/migration-status.ts`
- `packages/db/src/runtime-config.ts`
- `packages/db/src/migration-runtime.ts`
- `packages/db/src/backup-lib.ts`
- `packages/db/src/schema/index.ts`

### What each one does

`packages/db/package.json`

- defines the DB package scripts
- especially `build`, `generate`, `migrate`, and `seed`

`packages/db/drizzle.config.ts`

- tells Drizzle where the compiled schema is
- tells Drizzle where to write generated migrations

`packages/db/src/index.ts`

- the public surface of the DB package
- re-exports schema plus client/migration/backup helpers

`packages/db/src/client.ts`

- the heart of DB runtime logic
- creates DB clients
- inspects migration state
- applies pending migrations
- repairs drifted migration history
- ensures named databases exist

`packages/db/src/migrate.ts`

- CLI entrypoint for running migrations

`packages/db/src/migration-status.ts`

- CLI entrypoint for asking whether migrations are pending

`packages/db/src/runtime-config.ts`

- decides which database target a DB command should use

`packages/db/src/migration-runtime.ts`

- starts or adopts embedded Postgres when a migration command needs it

`packages/db/src/backup-lib.ts`

- backup and restore logic

`packages/db/src/schema/index.ts`

- the schema barrel export
- every table that the rest of the app uses should be re-exported here

## 4. Runtime Modes

Paperclip always speaks PostgreSQL, but it can get that PostgreSQL in different ways.

### Mode 1: Embedded PostgreSQL

This is the default local-dev path when `DATABASE_URL` is unset.

Important idea:

- this is still real PostgreSQL
- it is just managed for you by the app

The server boot process can:

- initialize the local Postgres data directory
- start the local Postgres process
- create the `paperclip` database if needed
- apply migrations

This is the easiest path for local development.

### Mode 2: External PostgreSQL

If `DATABASE_URL` is set, the system uses that database instead.

That can mean:

- local Docker Postgres
- hosted Postgres
- Supabase or another managed provider

The schema and migrations stay the same. Only the target database changes.

## 5. Why The Repo Has Both `doc/` And `docs/`

The repo already has operational docs in `doc/`, including:

- `doc/DATABASE.md`
- `doc/DEVELOPING.md`

This handbook lives in `docs/guides/database/` because it is trying to be a deeper developer-navigation set, not just a quickstart.

Think of it like this:

- `doc/` is the repo's existing operational/product documentation
- `docs/guides/database/` is a more focused learning path for engineers touching the DB system

## 6. Current Package Layout

The DB package is organized roughly like this:

```text
packages/db/
  drizzle.config.ts
  package.json
  src/
    index.ts
    client.ts
    migrate.ts
    migration-status.ts
    migration-runtime.ts
    runtime-config.ts
    backup-lib.ts
    backup.ts
    migrations/
    schema/
```

The directory roles are:

- `schema/`: TypeScript table definitions
- `migrations/`: generated SQL migrations plus Drizzle metadata
- `client.ts`: runtime DB and migration logic
- `runtime-config.ts` and `migration-runtime.ts`: figure out where/how migration commands run
- `backup-lib.ts`: operational backup/restore code

## 7. One Crucial Detail: This Package Is More Custom Than Plain Drizzle

Many projects use Drizzle in a very simple way:

- define tables
- generate migrations
- run Drizzle migrate

Paperclip does more than that.

Its DB package includes custom logic for:

- inspecting migration state
- detecting missing migration journal entries
- reconciling drift when schema appears to already exist
- adopting embedded Postgres instances if they are already running
- starting embedded Postgres just for migration commands

So if you are revamping the database layer, do not assume this is "just standard Drizzle boilerplate."

## 8. Legacy Naming Note

You may still see older references to `pglite` in docs or config migration code.

Current code paths normalize legacy config to:

- `embedded-postgres`

That means the current implementation target is embedded PostgreSQL, not PGlite, even if some older wording still exists in repo docs.

## 9. What To Read Next

If you want to understand how data is modeled, go to [02-schema-architecture.md](./02-schema-architecture.md).

If you want to understand how schema changes turn into migrations, go to [03-migrations.md](./03-migrations.md).
