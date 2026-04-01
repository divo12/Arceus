# `server/src/adapters/index.ts`

Why it matters:

- This is the adapter entry barrel from the server’s perspective.

What to focus on:

- exported adapter resolution helpers
- adapter execution/result types
- the fact that the server does not talk to every adapter directly

What this file teaches:

- the heartbeat asks for an adapter by type
- adapters implement a common execution contract

Connections:

- `heartbeat.ts` calls `getServerAdapter(...)`
- the real adapter registry lives one layer down

Self-check:

- Why does the server want an abstraction here?
- Which parts are runtime-agnostic because of this layer?
- Where would a new adapter type plug in?

