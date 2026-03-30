# Database Handbook

This folder is the working map for Paperclip's database layer.

It is meant for anyone who wants to:

- understand how the database package is structured
- add or change schema safely
- understand migration generation and runtime application
- debug embedded Postgres behavior
- plan a larger database refactor or revamp

If you only remember one sentence, remember this:

`packages/db` is the source of truth for schema and DB runtime helpers, while `server/src/index.ts` is the place where that DB package gets activated during app startup.

## Read This In Order

1. [01-overview.md](./01-overview.md)
2. [02-schema-architecture.md](./02-schema-architecture.md)
3. [03-migrations.md](./03-migrations.md)
4. [04-runtime-resolution.md](./04-runtime-resolution.md)
5. [05-change-workflow.md](./05-change-workflow.md)
6. [06-ops-and-backups.md](./06-ops-and-backups.md)
7. [07-revamp-guide.md](./07-revamp-guide.md)
8. [08-hippocampus-storage.md](./08-hippocampus-storage.md)
9. [09-shared-contracts.md](./09-shared-contracts.md)

## What Each File Covers

### [01-overview.md](./01-overview.md)

Start here if you want the whole picture first.

It explains:

- what `packages/db` owns
- how the DB package fits into the rest of the repo
- the main DB runtime modes
- the most important files to learn first

### [02-schema-architecture.md](./02-schema-architecture.md)

Start here if you want to edit tables or understand modeling style.

It explains:

- how schema files are organized
- why `src/schema/index.ts` matters
- common schema patterns in this repo
- representative table examples

### [03-migrations.md](./03-migrations.md)

Start here if you want to change schema without breaking deploys.

It explains:

- how Drizzle generation works here
- why `drizzle.config.ts` points at compiled `dist/schema/*.js`
- what lives in `src/migrations`
- how migration inspection, repair, and application work

### [04-runtime-resolution.md](./04-runtime-resolution.md)

Start here if you are debugging "which database is this command actually using?"

It explains:

- how DB target resolution works
- env/config precedence
- how migration commands can start embedded Postgres on demand
- how worktree-local config affects DB selection

### [05-change-workflow.md](./05-change-workflow.md)

Start here if you are about to make a DB change in a PR.

It explains:

- the safe edit workflow
- required cross-layer sync work
- verification steps
- common traps

### [06-ops-and-backups.md](./06-ops-and-backups.md)

Start here if you care about runtime operations.

It explains:

- embedded Postgres storage locations
- backup and restore helpers
- scheduled backups from the server
- migration and drift debugging

### [07-revamp-guide.md](./07-revamp-guide.md)

Start here if you are planning a bigger redesign.

It explains:

- what is risky in a DB revamp
- which invariants matter most
- how to scope the blast radius
- how to stage a safer migration plan

### [08-hippocampus-storage.md](./08-hippocampus-storage.md)

Start here if you want to understand the memory runtime's own storage model.

It explains:

- how Hippocampus uses PostgreSQL, pgvector, Redis, and Neo4j
- which parts are actually exercised by Paperclip today
- how the Python runtime stores memories, habits, patterns, and priming state
- how that memory system interacts with the main app database

### [09-shared-contracts.md](./09-shared-contracts.md)

Start here if you are changing DB shape and want to know what "shared files" you also need to care about.

It explains:

- what `packages/shared` owns
- which shared files matter most for DB-related work
- how constants, DTO types, validators, API paths, and config schema keep layers aligned
- how to audit shared contracts after a schema change

## Fast Navigation By Task

If your goal is "I need to add one column":

1. Read [02-schema-architecture.md](./02-schema-architecture.md)
2. Read [03-migrations.md](./03-migrations.md)
3. Follow [05-change-workflow.md](./05-change-workflow.md)

If your goal is "Why is `pnpm db:migrate` using that database?":

1. Read [04-runtime-resolution.md](./04-runtime-resolution.md)
2. Read [03-migrations.md](./03-migrations.md)

If your goal is "How is the DB started in dev?":

1. Read [01-overview.md](./01-overview.md)
2. Read [04-runtime-resolution.md](./04-runtime-resolution.md)
3. Read [06-ops-and-backups.md](./06-ops-and-backups.md)

If your goal is "We want to redesign the schema":

1. Read [01-overview.md](./01-overview.md)
2. Read [02-schema-architecture.md](./02-schema-architecture.md)
3. Read [07-revamp-guide.md](./07-revamp-guide.md)

If your goal is "How does memory storage work in Hippocampus today?":

1. Read [08-hippocampus-storage.md](./08-hippocampus-storage.md)
2. Read [04-runtime-resolution.md](./04-runtime-resolution.md)
3. Read [06-ops-and-backups.md](./06-ops-and-backups.md)

If your goal is "What shared files do DB changes affect?":

1. Read [09-shared-contracts.md](./09-shared-contracts.md)
2. Read [05-change-workflow.md](./05-change-workflow.md)

## Primary Source Files

These guides were written from the current code and the existing repo docs. If a guide and the code ever disagree, trust the code.

Main sources:

- `doc/DATABASE.md`
- `doc/DEVELOPING.md`
- `AGENTS.md`
- `packages/db/drizzle.config.ts`
- `packages/db/src/index.ts`
- `packages/db/src/client.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/migration-status.ts`
- `packages/db/src/runtime-config.ts`
- `packages/db/src/migration-runtime.ts`
- `packages/db/src/backup-lib.ts`
- `packages/db/src/schema/*.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/types/index.ts`
- `packages/shared/src/validators/index.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/api.ts`
- `packages/shared/src/config-schema.ts`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/README.md`
- `services/hippocampus-runtime/python/src/arceus/core/hippocampus/runtime.py`
- `services/hippocampus-runtime/python/migrations/versions/20260322_0001_hippocampus_storage.py`
- `server/src/index.ts`

## Core Mental Model

The shortest accurate mental model is:

1. schema lives in TypeScript under `packages/db/src/schema`
2. those schema files are re-exported through `packages/db/src/schema/index.ts`
3. Drizzle generation compiles schema to `dist/schema/*.js`
4. Drizzle writes SQL migrations into `packages/db/src/migrations`
5. runtime helpers in `packages/db/src/client.ts` inspect and apply those migrations
6. the server uses those helpers during startup
7. every other layer depends on these DB contracts staying consistent

That is the backbone of the whole database system in this repo.
