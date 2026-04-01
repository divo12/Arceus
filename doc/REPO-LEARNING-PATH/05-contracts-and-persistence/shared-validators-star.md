# `packages/shared/src/validators/*`

Why it matters:

- This directory defines request/response validation schemas shared across layers.

What to focus on:

- validators mirror domain modules
- route handlers often import schemas from here
- validation is part of the public contract, not just a backend convenience

Good first validator files:

- `agent.ts`
- `issue.ts`
- `hierarchy.ts`
- `role.ts`

What this directory teaches:

- input validation is centralized so UI and server stay aligned
- schema changes ripple into routes and form payloads quickly

Self-check:

- Which backend routes likely depend on these schemas?
- Why is shared validation better than handwritten per-route checks?
- What breaks if a validator changes but the UI payload shape does not?

