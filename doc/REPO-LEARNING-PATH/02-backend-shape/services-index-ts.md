# `server/src/services/index.ts`

Why it matters:

- This is the service registry and one of the quickest map files in the backend.

Read focus:

- which domain services exist
- which background/runtime services are exported
- how the rest of the server imports service capabilities

Connections:

- `index.ts` pulls runtime services from here.
- Routes typically construct or import services through this layer.

Questions:

- Which services are domain CRUD-ish versus runtime/orchestration-heavy?
- Which names show you the main subsystems of the repo?
- Which services appear in many routes and why?

