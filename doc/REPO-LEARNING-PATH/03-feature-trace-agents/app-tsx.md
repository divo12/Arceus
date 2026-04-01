# `ui/src/App.tsx`

Why it matters:

- This is the frontend route map.
- It tells you which page component owns each URL.

What to focus on:

- `boardRoutes()`
- which paths land on `Agents` and `AgentDetail`
- access gates like `CloudAccessGate()`
- redirects that normalize old or alias URLs

Key ideas:

- This file is navigation structure, not domain logic.
- It is the fastest way to answer: “which screen handles this route?”

Connections:

- `Agents.tsx` handles `/agents/*`.
- `AgentDetail.tsx` handles `/agents/:agentId`.
- `Layout.tsx` wraps most board routes.

Self-check:

- Which routes point to `Agents`?
- Which route patterns point to `AgentDetail`?
- Where does auth gating happen before the app renders the page?

