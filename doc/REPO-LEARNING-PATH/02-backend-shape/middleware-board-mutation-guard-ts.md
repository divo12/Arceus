# `server/src/middleware/board-mutation-guard.ts`

Why it matters:

- This file is a cross-cutting safety layer for powerful board-level mutations.

Read focus:

- what mutations are considered sensitive
- how the guard blocks or constrains risky writes

Connections:

- Works alongside route-level access checks.
- Encodes governance assumptions that are too broad to repeat in every route.

Questions:

- Why is middleware a better place for this than each route handler?
- What kinds of mistakes is this guard preventing?
- How does it reinforce governance at the HTTP boundary?

