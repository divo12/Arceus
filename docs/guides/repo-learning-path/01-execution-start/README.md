# Phase 1: Where Execution Starts

This phase is about learning how Paperclip becomes a live backend process.

Do not think of these files as random startup plumbing.

Together they answer the most important boot questions:

1. Where does config come from?
2. How does the server decide which mode it is in?
3. When does the database become usable?
4. When does Express get assembled?
5. When do special bootstrap flows appear?
6. What does the process tell the operator when it is ready?

## Read Order

1. [`config-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/01-execution-start/config-ts.md)
2. [`index-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/01-execution-start/index-ts.md)
3. [`app-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/01-execution-start/app-ts.md)
4. [`startup-banner-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/01-execution-start/startup-banner-ts.md)
5. [`board-claim-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/01-execution-start/board-claim-ts.md)

## The Big Mental Model

These files form the backend composition root.

That phrase matters.

It means these files mostly do not implement agent logic, issue logic, or company logic.

Instead, they do the work of:

- resolving runtime inputs
- choosing safe startup branches
- assembling middleware and routes
- starting process-level helpers
- exposing the app to the outside world

So if a route file is about "what this endpoint does," Phase 1 files are about "how the whole machine wakes up."

## How The Files Fit Together

### `server/src/config.ts`

This is the resolver.

It turns:

- env vars
- config-file values
- default paths
- string-like mode flags

into one typed `Config` object.

It answers: "what are we trying to run?"

### `server/src/index.ts`

This is the bootstrap orchestrator.

It answers: "in what order do we prepare the world and start the process?"

This is where config gets used to:

- prepare the DB
- apply migrations
- pick auth mode
- create the app
- start background systems
- open the server socket

### `server/src/app.ts`

This is the HTTP composition file.

It answers: "once the process is alive, what HTTP app are we actually serving?"

This is where middleware order, route mounting, plugin wiring, and UI-serving behavior come together.

### `server/src/startup-banner.ts`

This is the startup observability surface.

It answers: "what should a human operator immediately see once the server starts?"

### `server/src/board-claim.ts`

This is the authenticated bootstrap safety file.

It answers: "how do we safely hand off ownership from a local implicit board principal to a real authenticated human?"

## The Execution Story In One Pass

If you compress the whole phase into one sequence, it looks like this:

1. load and normalize config
2. prepare database mode and schema state
3. choose deployment/auth behavior
4. assemble the Express app
5. attach route trees, plugins, and UI serving mode
6. start realtime and long-lived services
7. print startup state for the operator
8. expose any special bootstrap warnings like board claim

That sequence is the main thing Phase 1 should leave in your head.

## Why This Phase Matters

If you skip this phase and jump into routes or services, a lot of the repo feels arbitrary.

Examples:

- Why do some routes assume `req.actor` exists?
- Why does authenticated mode behave differently from local trusted mode?
- Why is there a board-claim flow at all?
- Why can the UI be static in one mode and Vite middleware in another?

Phase 1 answers those questions before they become confusion later.

## What To Be Able To Explain After This Phase

- how env and config-file values become trusted runtime config
- why `index.ts` and `app.ts` are different kinds of files
- where migrations are checked
- where `/api` is actually assembled
- why startup prints the specific fields it prints
- why board claim exists only in a narrow bootstrap scenario
