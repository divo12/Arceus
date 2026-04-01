# `ui/src/api/budgets.ts`

Why it matters:

- Agents have budgets and spend, so the detail page needs budget-specific APIs.

What to focus on:

- budget summary/read/update calls
- how financial policy is kept separate from agent record CRUD

Connections:

- used by the budget-related sections of `AgentDetail.tsx`
- maps to budget-specific backend routes/services, not the core agent service

Self-check:

- Why is budget logic split out from `agentsApi`?
- What does that separation say about domain boundaries?
- Which other entities besides agents might reuse the budget system?

