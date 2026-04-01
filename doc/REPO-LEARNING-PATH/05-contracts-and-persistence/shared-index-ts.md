# `packages/shared/src/index.ts`

Why it matters:

- This is the monorepo’s public contract surface.

What to focus on:

- barrel exports
- domain constants
- shared types
- validators and helper exports

Why it matters in practice:

- if UI and server disagree, this package is often where the disagreement should be fixed
- reviewing this file shows the breadth of the app’s vocabulary

Self-check:

- Which exports are user-facing domain language?
- Which exports are implementation helpers shared across layers?
- Why is this a good first file in the shared package?

