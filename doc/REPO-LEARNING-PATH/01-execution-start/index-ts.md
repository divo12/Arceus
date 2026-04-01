# `server/src/index.ts`

Why it matters:

- This is the real backend entrypoint.
- If you only learn one startup file, make it this one.

Read focus:

- `startServer()`
- migration checks
- database selection
- auth mode selection
- Hippocampus startup
- heartbeat/background scheduler startup
- graceful shutdown

Connections:

- `config.ts` feeds this file.
- `app.ts` is assembled here.
- `services/index.ts` background services are activated here.

Questions:

- Where are migrations checked and possibly applied?
- When does Hippocampus start?
- Which logic is bootstrapping logic and which is ongoing runtime logic?

