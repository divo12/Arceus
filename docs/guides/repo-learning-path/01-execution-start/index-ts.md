# `server/src/index.ts`

This file already has a dedicated long-form guide at:

[`docs/guides/server-index-ts-deep-dive.md`](/Users/divyansh/Arceus/docs/guides/server-index-ts-deep-dive.md)

This Phase 1 doc explains how to place `index.ts` inside the startup story and what to focus on when reading it.

If you want one sentence first:

`index.ts` is the backend bootstrap orchestrator that turns resolved config into a live server process.

## 1. What This File Is Not

It is not:

- the main route file
- the main business-logic file
- the main persistence file

It touches all of those systems, but mostly to start and connect them.

That distinction is the first thing to internalize.

If `app.ts` defines the HTTP application shape, `index.ts` defines the backend process lifecycle.

## 2. The Startup Phases Inside `index.ts`

Read the file as one ordered sequence:

1. load config
2. normalize secrets env for downstream systems
3. prepare migration helpers
4. ensure a local board principal when needed
5. choose external or embedded Postgres
6. validate deployment/auth assumptions
7. create auth handlers if authenticated mode is on
8. create the Express app and Node server
9. publish process env needed by runtime integrations
10. start Hippocampus
11. attach realtime and background services
12. schedule heartbeat and backup loops
13. listen on the final port
14. install shutdown hooks

That is the file.

## 3. Why `index.ts` Feels Big

Because it is the one place where process-wide concerns converge:

- config
- DB mode
- migrations
- auth mode
- embedded services
- background schedulers
- runtime recovery
- operator output
- graceful shutdown

That does not mean it owns the real behavior of all those systems.

It owns their startup order.

## 4. The Most Important Reading Strategy

When reading `index.ts`, keep asking:

"Is this section deciding behavior for the whole process, or implementing a domain rule for one feature?"

Almost always, the answer is the first one.

That helps you avoid getting stuck on the wrong level of detail.

## 5. Key Sections Worth Studying

### Hippocampus wrappers

- `loadHippocampusBridgeModule()`
- `startHippocampusRuntimeForConfig(...)`
- `stopHippocampusRuntimeForConfig(...)`

These functions keep Hippocampus startup/shutdown behind a narrow wrapper.

That matters because `index.ts` wants process-level control without absorbing memory-runtime details directly.

### Migration helpers

- `formatPendingMigrationSummary(...)`
- `promptApplyMigrations(...)`
- `ensureMigrations(...)`

This cluster answers:

"How do we refuse stale schema state, repair migration drift, and optionally prompt or auto-apply?"

That is one of the most important operational guardrails in the backend.

### Local trusted bootstrap

- `isLoopbackHost(...)`
- `ensureLocalTrustedBoardPrincipal(...)`

This cluster exists because local trusted mode has a special bootstrap identity model.

It is startup-only logic, not regular domain behavior.

### Database selection

The largest branch in the file is:

- use configured external Postgres
- or start/manage embedded Postgres

This is where the process decides whether it is mostly consuming external infrastructure or booting its own local DB runtime.

### Auth/deployment branching

This section validates that config combinations make sense.

Examples:

- `local_trusted` must stay loopback/private
- authenticated public mode requires explicit auth base URL configuration

This is startup protecting the process from unsafe mode combinations.

### Background systems

After app/server creation, `index.ts` still is not done.

It also starts:

- Hippocampus
- websocket live events
- runtime-service reconciliation
- heartbeat scheduling
- routine scheduling
- automatic DB backups

That is why this file feels broader than a normal "server start" script.

## 6. How This File Connects To The Other Phase 1 Files

### Relationship to `config.ts`

`config.ts` says what the runtime config is.

`index.ts` is the first file that acts on it.

### Relationship to `app.ts`

`app.ts` builds the Express application.

`index.ts` decides when that happens and what dependencies/options get passed in.

### Relationship to `startup-banner.ts`

`startup-banner.ts` formats operator-facing startup state.

`index.ts` is the file that gathers those resolved values and decides when to print them.

### Relationship to `board-claim.ts`

`board-claim.ts` owns a narrow bootstrap safety flow.

`index.ts` decides when to initialize it and when to surface the warning URL.

## 7. What To Carry Forward

After reading `index.ts`, you should be able to explain the backend startup in plain English without talking about implementation details first.

Something like:

"Paperclip loads config, ensures DB readiness and migrations, chooses auth/deployment behavior, builds the app, starts optional runtime services like Hippocampus, attaches background schedulers, listens on a port, and installs clean shutdown hooks."

If you can say that comfortably, you understand the file at the right level.

## 8. Use The Deep Dive Next

Once this Phase 1 map feels clear, read the full walkthrough:

[`docs/guides/server-index-ts-deep-dive.md`](/Users/divyansh/Arceus/docs/guides/server-index-ts-deep-dive.md)

That longer guide is best used after you already understand the phase boundaries above.

## Self-Check

- Why is `index.ts` called a composition root for the backend process?
- Which sections are about environment-sensitive branching rather than business logic?
- What runtime systems start after the Express app itself has already been created?
