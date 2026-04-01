# `ui/src/pages/Agents.tsx`

Why it matters:

- This is the main list/org entrypoint for the agent feature.

What to focus on:

- `useQuery(...)` calls for agent list, org tree, and heartbeat runs
- filter/view state
- how list view and org view share the same underlying data

What this page teaches:

- pages in this repo are mostly orchestration and presentation glue
- React Query is the main data loading pattern
- UI state like tabs and filters is layered on top of API data

Key dependencies:

- `agentsApi.list(...)`
- `agentsApi.org(...)`
- `heartbeatsApi.list(...)`
- `CompanyContext` for scoping to the active company

Self-check:

- Which three backend-backed data sources power this page?
- What changes when the user switches list view versus org view?
- Why does this page need both agent data and heartbeat-run data?

