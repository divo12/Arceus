# Runtime Resolution

This guide explains how Paperclip decides which database a command or server process should talk to.

This matters because the answer is not always just "whatever `DATABASE_URL` says."

## 1. The Two Related Systems

There are two related but distinct DB-resolution stories in the repo:

1. server startup in `server/src/index.ts`
2. DB package command resolution in `packages/db/src/runtime-config.ts` and `packages/db/src/migration-runtime.ts`

They are related, but not identical.

The server boot path resolves the DB from server config and environment.

The DB package CLI path resolves the DB so commands like `pnpm db:migrate` and migration status checks can work even outside the main server process.

## 2. `runtime-config.ts`: Choosing The Target

File:

- `packages/db/src/runtime-config.ts`

The main exported function is:

- `resolveDatabaseTarget()`

It returns either:

- a Postgres connection string target
- or an embedded Postgres target with `dataDir` and `port`

## 3. Resolution Precedence

The precedence is:

1. `process.env.DATABASE_URL`
2. repo-local or instance-local `.paperclip/.env` or instance `.env`
3. config file `database.connectionString` when mode is `postgres`
4. otherwise embedded Postgres

That means a migration command can still know what DB to use even when `DATABASE_URL` is not exported in your current shell.

## 4. Where Config Comes From

The resolver looks for:

- `PAPERCLIP_CONFIG`
- ancestor `.paperclip/config.json`
- or the default instance config under the Paperclip home directory

It also reads the corresponding `.env` file next to that config.

Important defaults:

- Paperclip home defaults to `~/.paperclip`
- instance ID defaults to `default`

Relevant env vars:

- `PAPERCLIP_HOME`
- `PAPERCLIP_INSTANCE_ID`
- `PAPERCLIP_CONFIG`
- `DATABASE_URL`

## 5. Worktree Awareness

One useful feature is ancestor config discovery.

`runtime-config.ts` walks upward from the current working directory looking for:

- `.paperclip/config.json`

This is why repo-local worktree config can change which DB the command uses.

So if you are inside a git worktree with a repo-local Paperclip config, `pnpm db:migrate` may resolve to that worktree's isolated DB instead of your default instance.

That is deliberate and useful.

## 6. Embedded Postgres Defaults

If no external connection string wins, the resolver falls back to embedded Postgres using:

- a data directory
- a port

Defaults come from config if present, otherwise the package falls back to the standard instance DB location and port.

That means "no `DATABASE_URL`" does not mean "no database."

It means:

- use embedded Postgres

## 7. Legacy Config Compatibility

The resolver contains compatibility logic for older config that used:

- `pglite`

It migrates legacy values to:

- `embedded-postgres`

That is a strong clue that the implementation evolved, but current behavior should be read as embedded PostgreSQL.

## 8. `migration-runtime.ts`: Making The Target Usable

File:

- `packages/db/src/migration-runtime.ts`

`runtime-config.ts` answers "what should we use?"

`migration-runtime.ts` answers "how do we actually connect to it right now?"

Its main export is:

- `resolveMigrationConnection()`

It returns:

- `connectionString`
- `source`
- `stop()`

## 9. External Postgres Case

If the resolved target is already plain Postgres, `resolveMigrationConnection()` just returns it.

In that case:

- no embedded runtime needs to be started
- `stop()` is a no-op

## 10. Embedded Postgres Case

If the target is embedded Postgres, the migration runtime may need to:

- adopt an already-running instance
- or start a fresh embedded Postgres process

Important logic in that file:

- read `postmaster.pid`
- inspect `PG_VERSION`
- detect whether the preferred port is in use
- confirm whether a reachable Postgres instance actually points at the expected data directory
- ensure the `paperclip` database exists

This makes migration commands robust even when the main server is not currently running.

## 11. Why This Exists

Without this layer, `pnpm db:migrate` would be awkward in embedded mode because the command would need the server to already be running.

Instead, the DB package can:

- find the embedded DB location
- spin up the DB if needed
- migrate it
- shut it back down if this command started it

That is a very developer-friendly design.

## 12. Embedded Postgres Adoption Logic

There are a few cases:

### Case 1: a valid running `postmaster.pid` exists

The runtime adopts that running instance and uses its port.

### Case 2: no PID file, but the configured port is reachable and points at the expected data dir

The runtime adopts that server too.

This protects against stale or missing pid-file scenarios.

### Case 3: no usable running server exists

The runtime starts embedded Postgres itself.

If needed, it will:

- initialize the cluster
- remove stale pid files
- start the process
- ensure the `paperclip` database exists

## 13. How This Differs From Server Startup

`server/src/index.ts` also has embedded Postgres startup logic.

That startup path is broader because the server also needs to:

- create the app
- listen on the HTTP port
- schedule background services
- set up backups

The DB package migration runtime is narrower:

- it only cares about getting a usable DB connection for DB commands

So there is overlap, but not total duplication of purpose.

## 14. Practical Debugging Questions

If you are unsure which DB a command is using, ask:

1. Is `DATABASE_URL` set in my shell?
2. Is there a `.paperclip/config.json` above my current directory?
3. Is there a `.paperclip/.env` or instance `.env` providing `DATABASE_URL`?
4. Is the config saying `database.mode = postgres` with a connection string?
5. If none of those are true, which embedded Postgres data dir and port are being chosen?

## 15. Practical Command Mindset

When you run:

```sh
pnpm db:migrate
```

the real story is:

1. resolve the DB target
2. make sure that DB is reachable
3. migrate it
4. tear down any temporary embedded runtime if needed

That is the right mental model.

## 16. What To Read Next

If you are about to make a schema change, continue to [05-change-workflow.md](./05-change-workflow.md).
