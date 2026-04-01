# `ui/src/api/companySkills.ts`

Why it matters:

- Agent detail can manage and inspect skills, but the data model is company-scoped.

What to focus on:

- how company skills are listed and fetched
- how this differs from agent-specific skill sync or snapshot calls

Connections:

- `AgentDetail.tsx` uses this to reason about available skills
- pairs with agent-specific skill endpoints from `api/agents.ts`

Self-check:

- Why are company skills and agent skills not the same concept?
- Which layer owns the catalog versus the per-agent selection?
- Where would you trace a “sync agent skills” action after this file?

