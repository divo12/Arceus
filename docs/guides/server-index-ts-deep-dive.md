# `server/src/index.ts` Deep Dive

This guide explains [`server/src/index.ts`](/Users/divyansh/Arceus/server/src/index.ts) in the order it executes.

If you want one sentence first:

`index.ts` is the backend bootstrap orchestrator. It does not contain most business logic. It is the file that brings the backend process to life.

It is responsible for:

1. loading config
2. preparing the database
3. checking and applying migrations
4. preparing auth
5. creating the Express app
6. creating the HTTP server
7. starting Hippocampus
8. starting realtime and background services
9. opening the listen socket
10. shutting everything down cleanly later

---

## 1. How To Read This File

The most useful mindset is:

- [`server/src/app.ts`](/Users/divyansh/Arceus/server/src/app.ts) defines what the HTTP app does
- [`server/src/index.ts`](/Users/divyansh/Arceus/server/src/index.ts) defines how the whole backend process starts

So if `app.ts` is the restaurant staff and menu, `index.ts` is the “open the restaurant in the morning” routine.

Read `index.ts` in these big phases:

1. imports and helper types
2. Hippocampus helpers
3. `startServer()`
4. migration helpers
5. local board bootstrap
6. database selection
7. deployment/auth branching
8. app and server creation
9. background systems
10. listen and startup banner
11. graceful shutdown
12. main-module entrypoint

---

## 2. Imports: The Startup Toolbox

At the top, `index.ts` imports the tools needed to start the whole backend.

### 2.1 Node built-ins

```ts
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
```

What they are used for:

- `existsSync`, `readFileSync`, `rmSync`
  Used for embedded Postgres files like `PG_VERSION` and `postmaster.pid`.
- `createServer`
  Creates the real Node HTTP server.
- `resolve`
  Builds absolute disk paths.
- `createInterface`, `stdin`, `stdout`
  Used for interactive migration prompting in terminal mode.
- `pathToFileURL`
  Used later to detect whether this file is the actual process entrypoint.

### 2.2 Express types

```ts
import type { Request as ExpressRequest, RequestHandler } from "express";
```

These are type-only imports used for:

- typing request-aware session resolvers
- typing auth handlers

### 2.3 Drizzle helpers

```ts
import { and, eq } from "drizzle-orm";
```

These are query-composition helpers used later for local board bootstrap queries.

- `eq(a, b)` means “column/value equality”
- `and(x, y)` means “both conditions must be true”

### 2.4 Database package imports

```ts
import {
  createDb,
  ensurePostgresDatabase,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
```

These split into four groups:

- DB connection helpers:
  - `createDb`
  - `ensurePostgresDatabase`
  - `getPostgresDataDirectory`
- migration helpers:
  - `inspectMigrations`
  - `applyPendingMigrations`
  - `reconcilePendingMigrationHistory`
- backup helpers:
  - `formatDatabaseBackupResult`
  - `runDatabaseBackup`
- table definitions:
  - `authUsers`
  - `companies`
  - `companyMemberships`
  - `instanceUserRoles`

### 2.5 App/runtime collaborators

```ts
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { heartbeatService, reconcilePersistedRuntimeServicesOnStartup, routineService } from "./services/index.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
```

These are the high-level collaborators of startup:

- `detectPort`
  Finds a free port if the requested one is busy.
- `createApp`
  Builds the Express app.
- `loadConfig`
  Produces the final config object.
- `logger`
  Startup/shutdown logging.
- `setupLiveEventsWebSocketServer`
  Attaches websockets for live updates.
- `heartbeatService`
  Scheduler/execution orchestrator.
- `routineService`
  Recurring routine scheduler.
- `reconcilePersistedRuntimeServicesOnStartup`
  Runtime recovery/cleanup on boot.
- `createStorageServiceFromConfig`
  Builds the configured storage provider.
- `printStartupBanner`
  Prints the startup summary.
- `getBoardClaimWarningUrl`, `initializeBoardClaimChallenge`
  Support ownership claim flow in authenticated mode.

The imports alone tell you that this file is about:

- config
- DB
- auth
- runtime services
- server lifecycle

not feature logic.

---

## 3. Helper Types At The Top

The file defines a few local types before any real startup logic.

### 3.1 Better Auth result shapes

```ts
type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};
```

These describe what session resolution should return in authenticated mode.

### 3.2 Embedded Postgres interface

```ts
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
```

This says what the embedded Postgres runtime must support.

### 3.3 Embedded Postgres constructor

```ts
type EmbeddedPostgresCtor = new (opts: {...}) => EmbeddedPostgresInstance;
```

This describes how the embedded Postgres module must be instantiated.

### 3.4 `StartedServer`

```ts
export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}
```

This is the final return shape of `startServer()`.

It tells the caller:

- the live server object
- which host/port it ended up using
- the final API URL
- the final database connection string

---

## 4. Hippocampus Helper Functions

Before `startServer()`, the file defines a small helper surface for the memory runtime.

### 4.1 `loadHippocampusBridgeModule()`

```ts
async function loadHippocampusBridgeModule() {
  const mod = await import("./services/hippocampus-bridge.js");
  return mod;
}
```

This is a dynamic import.

Important distinction:

- this is lazy **module loading**
- not lazy **memory availability**

In embedded mode, Hippocampus is still explicitly started during server startup. The dynamic import just means the memory module is loaded only when this startup path reaches it.

### 4.2 `startHippocampusRuntimeForConfig(...)`

```ts
export async function startHippocampusRuntimeForConfig(
  config: Pick<
    Config,
    "hippocampusMode" | "hippocampusPythonBin" | "hippocampusStartupTimeoutMs" | "hippocampusRequestTimeoutMs"
  >,
): Promise<void> {
  const mod = await loadHippocampusBridgeModule();
  await mod.initializeHippocampusBridge({
    mode: config.hippocampusMode,
    pythonBin: config.hippocampusPythonBin,
    startupTimeoutMs: config.hippocampusStartupTimeoutMs,
    requestTimeoutMs: config.hippocampusRequestTimeoutMs,
  });
}
```

This is a startup wrapper. It narrows the config to only the four fields Hippocampus actually needs.

### 4.3 `stopHippocampusRuntimeForConfig(...)`

```ts
export async function stopHippocampusRuntimeForConfig(
  config: Pick<Config, "hippocampusMode">,
): Promise<void> {
  if (config.hippocampusMode === "off") return;
  const mod = await loadHippocampusBridgeModule();
  await mod.shutdownHippocampusBridge();
}
```

This is the shutdown partner.

If memory mode is off, it exits immediately. Otherwise it loads the bridge module and shuts it down cleanly.

These helpers keep `startServer()` readable by hiding subsystem-specific startup details behind small orchestration-level names.

---

## 5. `startServer()`: The Main Bootstrap Routine

```ts
export async function startServer(): Promise<StartedServer> {
```

This is the backend’s full startup routine.

Everything after this point happens inside that process-level boot flow.

### 5.1 Load config

```ts
const config = loadConfig();
```

Nothing important can happen before this because all later decisions depend on config.

### 5.2 Mirror some secret config into env vars

```ts
if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
  process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
}
...
```

This preserves env-first behavior while making sure secret-related subsystems can still discover settings via `process.env` if they expect that path.

This is a small but important bridge between config-object world and env-var world.

---

## 6. Migration Helper Types And Functions

Inside `startServer()`, the file defines a cluster of helpers just for database migration handling.

### 6.1 `MigrationSummary`

```ts
type MigrationSummary =
  | "skipped"
  | "already applied"
  | "applied (empty database)"
  | "applied (pending migrations)";
```

This is only used for startup status reporting.

### 6.2 `formatPendingMigrationSummary(...)`

This turns a long migration list into a shorter human-readable string.

### 6.3 `promptApplyMigrations(...)`

```ts
async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
```

This function decides whether startup should ask a human in the terminal:

“Should I apply pending migrations now?”

Behavior:

- if `PAPERCLIP_MIGRATION_PROMPT=never`, return `false`
- if `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, return `true`
- if no interactive terminal is available, return `true`
- otherwise prompt the operator and accept only `y` or `yes`

This means the interactive prompt is mostly a local/operator convenience. In hosted non-interactive environments, it usually collapses into auto-apply behavior.

### 6.4 `EnsureMigrationsOptions`

```ts
type EnsureMigrationsOptions = {
  autoApply?: boolean;
};
```

This allows startup to force auto-apply behavior in special cases like first-run embedded DB setup.

### 6.5 `ensureMigrations(...)`

This is one of the most important helper functions in the file.

It:

1. inspects migration state
2. repairs drifted migration history if possible
3. detects stale schema cases
4. prompts or auto-applies if necessary
5. throws if startup should refuse to run

Its job is to enforce the invariant:

**Do not start the backend against a stale or incompatible schema.**

### 6.6 `isLoopbackHost(...)`

This helper returns true for:

- `127.0.0.1`
- `localhost`
- `::1`

Later startup uses it to enforce that `local_trusted` mode really stays local-only.

---

## 7. Local Board Bootstrap Helpers

`index.ts` defines three constants:

```ts
const LOCAL_BOARD_USER_ID = "local-board";
const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
const LOCAL_BOARD_USER_NAME = "Board";
```

These represent the built-in operator identity used in `local_trusted` mode.

### 7.1 `ensureLocalTrustedBoardPrincipal(db)`

This helper ensures three things:

1. user `local-board` exists in `authUsers`
2. that user has `instance_admin` in `instanceUserRoles`
3. that user is an active owner in every company via `companyMemberships`

This is not normal product logic.
It is startup-level principal bootstrapping so that local trusted mode can work without a real login system.

By the end of this helper, local trusted mode has a valid top-level operator principal.

---

## 8. Database Startup: External vs Embedded

This is the largest startup branch in the file.

First it creates shared state variables:

- `db`
- `embeddedPostgres`
- `embeddedPostgresStartedByThisProcess`
- `migrationSummary`
- `activeDatabaseConnectionString`
- `startupDbInfo`

Then it chooses between two paths.

### 8.1 External Postgres path

If `config.databaseUrl` exists:

1. run `ensureMigrations(...)`
2. create the DB client with `createDb(...)`
3. log external Postgres usage
4. save connection-string and startup summary state

This is the simple path because the DB server is already assumed to exist.

### 8.2 Embedded Postgres path

If no DB URL exists, startup falls back to embedded Postgres.

That path does all of this:

1. dynamically import `embedded-postgres`
2. resolve data directory and configured port
3. create a rolling buffer for embedded Postgres logs
4. detect whether cluster already exists via `PG_VERSION`
5. detect whether a running process exists via `postmaster.pid`
6. reuse an already-running embedded DB if possible
7. if needed, probe whether the configured port already serves the expected data directory
8. otherwise find a free port
9. construct the embedded Postgres instance
10. initialize cluster if first run
11. remove stale `postmaster.pid` if necessary
12. start embedded Postgres
13. ensure the actual `paperclip` database exists
14. auto-apply first-run migrations if appropriate
15. create the DB client
16. save connection and startup summary state

### Why this branch is so long

Because in embedded mode, the backend is not merely connecting to a DB.
It may be:

- creating a cluster
- cleaning up stale state
- starting a DB subprocess
- deciding whether to reuse or repair existing DB infrastructure

By the end of this section, regardless of branch, startup guarantees:

- `db` is ready
- the schema is up to date
- `activeDatabaseConnectionString` is valid

---

## 9. Deployment Safety Checks

After DB setup, startup validates deployment assumptions.

### 9.1 `local_trusted` must stay loopback-only

If deployment mode is `local_trusted` and host is not loopback, startup throws.

Why:

`local_trusted` is intentionally low-friction and should never be exposed remotely.

### 9.2 `local_trusted` must be private

If exposure is not private, startup throws.

### 9.3 `authenticated` public mode requires explicit auth URL config

If deployment mode is `authenticated`, startup enforces:

- if `authBaseUrlMode=explicit`, `authPublicBaseUrl` must exist
- if exposure is `public`, auth URL mode must be explicit and public URL must be provided

This protects public auth flows from ambiguous or auto-guessed base URLs.

---

## 10. Auth Mode Branching

Now startup prepares auth behavior.

It begins with these variables:

```ts
let authReady = config.deploymentMode === "local_trusted";
let betterAuthHandler: RequestHandler | undefined;
let resolveSession:
  | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
  | undefined;
let resolveSessionFromHeaders:
  | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
  | undefined;
```

### 10.1 Local trusted branch

If deployment mode is `local_trusted`, startup just calls:

```ts
await ensureLocalTrustedBoardPrincipal(db as any);
```

No real login/session system is needed in this mode.

### 10.2 Authenticated branch

If deployment mode is `authenticated`, startup dynamically imports Better Auth helpers and then:

1. requires `BETTER_AUTH_SECRET` or `PAPERCLIP_AGENT_JWT_SECRET`
2. derives trusted origins from config
3. merges extra origins from `BETTER_AUTH_TRUSTED_ORIGINS`
4. logs the effective origin setup
5. creates Better Auth instance
6. creates the auth handler
7. creates request/header session resolvers
8. initializes board-claim challenge
9. marks auth as ready

By the end of this section, auth mode is fully prepared and app assembly can assume its auth dependencies are in place.

---

## 11. App Creation, Server Creation, Runtime Env, Hippocampus

Now startup begins assembling the live backend process.

### 11.1 Pick the final listen port

```ts
const listenPort = await detectPort(config.port);
```

If the requested port is busy, a free one is chosen.

### 11.2 Compute UI mode

```ts
const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
```

This condenses UI-related config into one app-facing mode.

### 11.3 Create storage service

```ts
const storageService = createStorageServiceFromConfig(config);
```

This prepares local-disk or S3-style storage before app creation.

### 11.4 Create Express app

```ts
const app = await createApp(db as any, {
  uiMode,
  serverPort: listenPort,
  storageService,
  deploymentMode: config.deploymentMode,
  deploymentExposure: config.deploymentExposure,
  allowedHostnames: config.allowedHostnames,
  bindHost: config.host,
  authReady,
  companyDeletionEnabled: config.companyDeletionEnabled,
  betterAuthHandler,
  resolveSession,
});
```

This is where prepared dependencies are injected into the app.

### 11.5 Create HTTP server

```ts
const server = createServer(app as unknown as Parameters<typeof createServer>[0]);
```

Important distinction:

- `app` is the request-handling behavior
- `server` is the real network listener

### 11.6 Publish runtime host/port env vars

Startup writes:

- `PAPERCLIP_LISTEN_HOST`
- `PAPERCLIP_LISTEN_PORT`
- `PAPERCLIP_API_URL`

It also ensures Hippocampus has a Postgres URL if none was explicitly set:

```ts
if (process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL === undefined) {
  process.env.ARCEUS_HIPPOCAMPUS_POSTGRES_URL = activeDatabaseConnectionString;
}
```

### 11.7 Start Hippocampus

```ts
await startHippocampusRuntimeForConfig(config);
```

In embedded mode, this starts the Python memory runtime before normal request handling begins.

By the end of this section, the process has:

- DB
- auth
- app
- HTTP server object
- runtime address
- storage
- Hippocampus

---

## 12. Realtime, Recovery, Schedulers, And Backups

Now startup begins long-running background systems.

### 12.1 Websocket live events

```ts
setupLiveEventsWebSocketServer(server, db as any, {
  deploymentMode: config.deploymentMode,
  resolveSessionFromHeaders,
});
```

This attaches realtime push support to the HTTP server.

### 12.2 Persisted runtime-service reconciliation

```ts
void reconcilePersistedRuntimeServicesOnStartup(db as any)
```

This runs in the background at startup to recover or clean up persisted runtime-service state left by previous processes.

### 12.3 Heartbeat scheduler block

If `heartbeatSchedulerEnabled` is true:

1. instantiate `heartbeatService(db)`
2. instantiate `routineService(db)`
3. run startup recovery:
   - `reapOrphanedRuns()`
   - `resumeQueuedRuns()`
4. start periodic interval that:
   - ticks heartbeat timers
   - ticks routine triggers
   - periodically reaps stale/orphaned runs
   - resumes queued runs

This is the active orchestration loop of Paperclip.

### 12.4 Database backup scheduler

If backups are enabled:

1. compute interval in milliseconds
2. maintain `backupInFlight` guard
3. define `runScheduledBackup()`
4. call `runDatabaseBackup(...)` on schedule
5. prune old backups according to retention policy
6. log success or failure

By the end of this section, the backend is not only ready for HTTP traffic, it is actively running orchestration and maintenance loops.

---

## 13. `server.listen(...)`: Going Live

This is the moment the backend opens its network socket.

### 13.1 Promise wrapper

`server.listen(...)` is callback-based, so startup wraps it in a Promise and `await`s it.

### 13.2 Startup error hook

It installs a temporary `server.once("error", onError)` handler so listen failures reject startup cleanly.

### 13.3 Start listening

```ts
server.listen(listenPort, config.host, () => {
```

Once that callback fires, the server is actually reachable.

### 13.4 Optional browser auto-open

If `PAPERCLIP_OPEN_ON_LISTEN === "true"`, startup lazily imports the `open` package and tries to open the local URL in a browser.

This is convenience-only and never blocks successful startup.

### 13.5 Startup banner

`printStartupBanner(...)` prints a detailed startup summary:

- host
- ports
- deployment mode
- auth readiness
- UI mode
- DB mode/details
- migration summary
- scheduler config
- backup config

### 13.6 Board claim warning

Startup asks:

```ts
const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
```

If a claim URL exists, it prints a bright terminal warning explaining that:

- this instance still has `local-board` as sole admin
- a real signed-in user should claim ownership
- here is the one-time claim URL

This is a transitional ownership/bootstrap warning, not a normal auth path.

By the end of this section, the server is live and operators have been shown the full state of startup.

---

## 14. Graceful Shutdown

After the server is listening, `index.ts` may install signal handlers if either:

- Hippocampus is embedded
- embedded Postgres was started by this process

```ts
if (config.hippocampusMode === "embedded" || (embeddedPostgres && embeddedPostgresStartedByThisProcess)) {
```

### 14.1 Guard against double shutdown

```ts
let shuttingDown = false;
```

### 14.2 Shutdown order

The `shutdown(signal)` function does:

1. stop Hippocampus
2. close the HTTP server if it is listening
3. stop embedded Postgres if this process started it
4. `process.exit(0)`

This ordering matters.

The app shuts down runtime dependents before shutting down the DB process it may depend on.

### 14.3 Signal wiring

The file attaches:

- `SIGINT`
- `SIGTERM`

and forwards them into the shared shutdown routine.

This makes local Ctrl+C and hosted process-manager termination behave cleanly.

---

## 15. Returning The Startup Result

At the end of `startServer()`:

```ts
return {
  server,
  host: config.host,
  listenPort,
  apiUrl: process.env.PAPERCLIP_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
  databaseUrl: activeDatabaseConnectionString,
};
```

This gives callers a neat startup summary with:

- the live server object
- actual host/port
- final API URL
- final DB URL

This is especially useful for tests or programmatic startup flows.

---

## 16. `isMainModule(...)`

After `startServer()`, the file defines:

```ts
function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}
```

This checks whether `index.ts` is the real process entrypoint or whether it is only being imported by another module.

That distinction matters because the file should only auto-start the server when it is the main entry.

---

## 17. Auto-Start When Run Directly

Finally:

```ts
if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}
```

Meaning:

- if this file is run directly, start the server
- if startup fails, log the failure and exit with code `1`

This lets the file serve both as:

- a reusable module exporting `startServer()`
- the actual process entrypoint when launched directly

---

## 18. The Full Startup Sequence In Plain English

Here is the whole file compressed into one plain-English sequence:

1. Load config.
2. Copy key secret settings into env vars if missing.
3. Define migration helper logic.
4. Define local trusted board bootstrap logic.
5. Decide whether to use external or embedded Postgres.
6. Ensure the database exists and schema is current.
7. Validate deployment/auth configuration.
8. Prepare auth mode:
   - local trusted bootstrap
   - or Better Auth setup
9. Choose a final listen port.
10. Build storage service.
11. Build the Express app.
12. Build the HTTP server.
13. Publish runtime host/port/API env vars.
14. Start Hippocampus.
15. Attach websocket live events.
16. Reconcile persisted runtime-service state.
17. Start heartbeat/routine/background schedulers.
18. Start DB backup scheduler if enabled.
19. Open the HTTP listen socket.
20. Print startup banner and board-claim warning if needed.
21. Register graceful shutdown handlers.
22. Return the live server details.

---

## 19. The Most Important Concepts To Remember

If you only remember a few things about `index.ts`, remember these:

### 19.1 It is orchestration, not feature logic

This file starts systems.
It does not implement most business behavior.

### 19.2 It guarantees startup invariants

The most important one is:

**Do not continue if database/schema/auth assumptions are unsafe.**

### 19.3 It assembles dependencies before app creation

By the time `createApp(...)` is called, config, DB, auth, storage, and runtime environment have already been prepared.

### 19.4 It is both a module and an entrypoint

You can import `startServer()` from it, or run it directly and let it start the whole backend.

---

## 20. Best Next Files To Read After This

Once you understand `index.ts`, the best next deep dives are:

1. [`server/src/app.ts`](/Users/divyansh/Arceus/server/src/app.ts)
2. [`server/src/routes/agents.ts`](/Users/divyansh/Arceus/server/src/routes/agents.ts)
3. [`server/src/services/heartbeat.ts`](/Users/divyansh/Arceus/server/src/services/heartbeat.ts)
4. [`server/src/routes/memory.ts`](/Users/divyansh/Arceus/server/src/routes/memory.ts)
5. [`server/src/services/hippocampus-bridge.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-bridge.ts)

That path takes you from:

- process startup
- to app assembly
- to HTTP routes
- to execution orchestration
- to memory integration

which is the actual backbone of the backend.
