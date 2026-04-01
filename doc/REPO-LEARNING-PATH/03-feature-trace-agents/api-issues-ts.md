# `ui/src/api/issues.ts`

Why it matters:

- Agent detail often intersects with issue assignment and execution context.

What to focus on:

- issue listing, detail, and update calls
- how agent-related pages still need issue-domain data to feel complete

Connections:

- `AgentDetail.tsx` uses it to correlate agent work with issues
- backend source is `server/src/routes/issues.ts`

Self-check:

- Why is issue data useful on an agent page?
- What does this reveal about how tightly agents and issues are linked?
- Which issue actions are likely to wake or pause an agent?

