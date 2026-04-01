# Phase 3: Trace One Feature End-to-End

This phase teaches the repo by following one real feature instead of reading folders in isolation.

The feature is the agent experience:

- the app decides which page to show
- the page decides what data it needs
- the frontend API wrapper decides which HTTP endpoint to call
- the backend route decides whether the caller is allowed and how to shape the request
- the backend service decides the actual domain behavior
- shared contracts keep UI and backend speaking the same language
- database schema is where the durable truth finally lives

If you are new to frontend/backend terms, use this translation:

- frontend = what runs in the browser
- backend = what runs on the server
- route = an address like `/agents/:id`
- page component = the React file that renders a screen
- API wrapper = a small frontend function that sends HTTP requests
- service = backend business logic
- schema = database table definitions

## The Core Mental Model

For this phase, keep this sentence in your head the whole time:

`screen -> data request -> HTTP endpoint -> service rules -> tables -> response -> screen update`

That is the basic shape of most product features in this repo.

The reason agents are a good learning feature is that they touch almost every layer:

- routing
- company scoping
- live run status
- permissions
- configuration
- runtime state
- persistence

## Recommended Read Order

1. `[app-tsx.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/app-tsx.md)`
2. `[agents-page-tsx.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/agents-page-tsx.md)`
3. `[agent-detail-tsx.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/agent-detail-tsx.md)`
4. `[api-agents-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/api-agents-ts.md)`
5. `[routes-agents-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/routes-agents-ts.md)`
6. `[services-agents-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/services-agents-ts.md)`
7. `[shared-index-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/shared-index-ts.md)`
8. `[db-schema-index-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/db-schema-index-ts.md)`
9. `[exercise.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/exercise.md)`

## What Each File Teaches You

`[ui/src/App.tsx](/Users/divyansh/Arceus/ui/src/App.tsx)`
Shows how the browser URL becomes a page component. It is the map of the UI.

`[ui/src/pages/Agents.tsx](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx)`
Shows how a list screen loads data, reacts to filters, and merges live run information into display state.

`[ui/src/pages/AgentDetail.tsx](/Users/divyansh/Arceus/ui/src/pages/AgentDetail.tsx)`
Shows what a “workbench page” looks like when one screen coordinates many subsystems at once.

`[ui/src/api/agents.ts](/Users/divyansh/Arceus/ui/src/api/agents.ts)`
Shows the frontend’s HTTP boundary. This file is where React stops and API calling begins.

`[server/src/routes/agents.ts](/Users/divyansh/Arceus/server/src/routes/agents.ts)`
Shows the backend’s HTTP boundary. This file translates web requests into service calls.

`[server/src/services/agents.ts](/Users/divyansh/Arceus/server/src/services/agents.ts)`
Shows the actual agent domain logic. This is the layer that owns invariants and persistence behavior.

`[packages/shared/src/index.ts](/Users/divyansh/Arceus/packages/shared/src/index.ts)`
Shows how constants and types are exported to both UI and server so both sides agree on meanings.

`[packages/db/src/schema/index.ts](/Users/divyansh/Arceus/packages/db/src/schema/index.ts)`
Shows how table modules are gathered into one schema surface for the rest of the monorepo.

## How To Read This Phase Without Getting Lost

Do not ask “what does every line do?”

Ask these simpler questions in order:

1. What enters this file?
2. What decisions happen here?
3. What leaves this file?
4. Which next layer receives it?

Example for the agent list screen:

1. browser URL enters `App.tsx`
2. `App.tsx` chooses `Agents`
3. `Agents.tsx` asks `agentsApi.list(...)`
4. `api/agents.ts` calls a backend endpoint
5. `routes/agents.ts` checks access and calls `agentService.list(...)`
6. `services/agents.ts` reads `agents` rows and hydrates spend
7. response comes back up the stack
8. `Agents.tsx` renders it

That is the exact style of reasoning you want to practice.

## What You Should Understand By The End

If this phase worked, you should be able to explain:

- how a browser URL becomes a page
- why a page does not talk to the database directly
- why frontend API wrappers exist
- why route files are not the same thing as service files
- how company boundaries are enforced before data is returned
- where runtime state and long-lived data differ

## Self-Check

Before moving on, try to answer these without opening code:

1. Where does the list of agents come from?
2. Which file decides whether `/agents/:id` opens a detail page?
3. Which file knows the actual HTTP path for agent detail?
4. Which file decides whether a caller may see agent configuration?
5. Which file knows which tables exist for agent runtime state and sessions?

