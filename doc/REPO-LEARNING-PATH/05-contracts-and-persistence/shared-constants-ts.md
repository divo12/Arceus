# `packages/shared/src/constants.ts`

Why it matters:

- This file defines the canonical enum-like vocabulary of the application.

What to focus on:

- agent statuses, roles, kinds, delegation styles
- issue and goal statuses
- deployment/auth/runtime constants
- hierarchy, budget, meeting, plugin, heartbeat, and permission constants

What this file teaches:

- many “business rules” start as allowed value sets
- the UI and backend should both rely on these values instead of inventing strings locally

Self-check:

- Which constants are core to the agent company model?
- Which constants feel more infrastructural?
- Why is type generation from `as const` useful here?

