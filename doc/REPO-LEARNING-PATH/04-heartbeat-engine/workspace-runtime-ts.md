# `server/src/services/workspace-runtime.ts`

Why it matters:

- Heartbeat runs often need runtime services and workspace-aware processes.

What to focus on:

- execution workspace/runtime service types
- service reuse and lifecycle tracking
- process spawning and persistence of runtime-service state

What this file teaches:

- “execution” is not just one agent process
- the system may manage supporting local processes and URLs around a run

Connections:

- heartbeat persists adapter-managed runtime services through this layer
- execution workspace and runtime policy decisions eventually feed into it

Self-check:

- What is a runtime service in this repo?
- Why does the system need leases/reuse keys for services?
- Which data here is ephemeral process state versus persisted DB state?

