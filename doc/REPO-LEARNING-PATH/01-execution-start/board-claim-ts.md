# `server/src/board-claim.ts`

Why it matters:

- This file handles the “first real owner” bootstrap problem safely.

Read focus:

- why local bootstrap users are risky long-term
- how claim challenges are created and validated
- the transition from bootstrap control to real ownership

Connections:

- `index.ts` initializes board-claim flow in authenticated mode.
- Startup warnings and claim URLs depend on this logic.

Questions:

- Why does the system need a board-claim flow at all?
- What unsafe state is this file trying to eliminate?
- How is claiming ownership different from normal login?

