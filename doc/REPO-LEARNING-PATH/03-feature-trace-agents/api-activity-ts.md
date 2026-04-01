# `ui/src/api/activity.ts`

Why it matters:

- Agent detail uses activity data to show audit and operational history.

What to focus on:

- activity listing/filtering calls
- how mutable actions later become timeline data

Connections:

- pairs with `logActivity(...)` on the backend
- gives the UI a human-readable history of what happened

Self-check:

- Why is activity modeled as its own domain?
- Which user questions are answered by activity rather than current state?
- What backend actions likely emit activity records?

