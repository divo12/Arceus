# `server/src/app.ts`

Why it matters:

- This file assembles the Express app that `index.ts` later serves.

Read focus:

- middleware order
- route mounting under `/api`
- UI/static/dev middleware behavior
- health and utility endpoints

Connections:

- `index.ts` owns the outer Node server.
- `app.ts` owns the HTTP application shape inside it.

Questions:

- Which middleware run before routes?
- Where are domain routers mounted?
- What is Express-specific composition versus domain logic?

