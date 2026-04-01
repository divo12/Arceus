# `ui/src/pages/AgentDetail.tsx`

Why it matters:

- This is the richest single page in the agent feature.
- It shows how one domain page composes many backend surfaces.

What to focus on:

- the main `useQuery(...)` and mutation calls
- tab-level responsibilities: dashboard, instructions, configuration, skills, runs, budget, memory, authority
- live run/transcript related state

What this page teaches:

- a single entity detail page often spans several backend subdomains
- API wrappers are split by concern, not by page
- most real complexity here is coordination, not rendering alone

Important neighboring APIs:

- `agentsApi`
- `companySkillsApi`
- `budgetsApi`
- `heartbeatsApi`
- `instanceSettingsApi`
- `activityApi`
- `issuesApi`
- `assetsApi`

Self-check:

- Why does this page depend on so many API modules?
- Which tabs are mostly configuration reads/writes versus execution/runtime views?
- Where would you look to trace “view runs for an agent” from this page downward?

