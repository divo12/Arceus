# `ui/src/App.tsx`

This guide explains `[ui/src/App.tsx](/Users/divyansh/Arceus/ui/src/App.tsx)` as the top-level UI traffic controller.

If you want one sentence first:

`App.tsx` does not implement agent business logic. It decides which page component should own the screen for a given URL, and it adds a few important app-wide gates and redirects before the user reaches those pages.

## Mental Model

Think of the UI like a building:

- the browser URL is the room number the user typed
- `App.tsx` is the front desk
- page files are the actual rooms where work happens

So when you open `/agents/all`, `App.tsx` does not fetch agents itself. It looks at the path and says: “this request belongs to the `Agents` page.”

## What This File Owns

`[ui/src/App.tsx](/Users/divyansh/Arceus/ui/src/App.tsx)` owns:

- global route definitions
- auth/bootstrap gating
- company-prefixed board routing
- redirects from old or generic URLs into the current board shape
- app-wide shells like `Layout` and route grouping

It does not own:

- how agents are fetched
- how an agent is updated
- how agent data is rendered in detail

Those belong to the page and API layers.

## Why This File Matters So Much

If you do not understand this file, many page files feel disconnected.

If you do understand this file, you suddenly know:

- how a URL enters the frontend
- which component gets mounted
- which redirects are “real navigation logic”
- why some routes need company prefixes

That is why this file is one of the best first frontend files to learn.

## Key Sections

## 1. Imports: The UI Surface Area

At the top, the file imports almost every major page:

- dashboard
- companies
- agents
- projects
- issues
- routines
- goals
- approvals
- memory
- meetings
- plugins
- onboarding
- auth

That tells you immediately what `App.tsx` is: a route map, not a feature implementation file.

It also imports:

- routing helpers from `[ui/src/lib/router](/Users/divyansh/Arceus/ui/src/lib/router)`
- `useQuery` from React Query
- APIs like `[ui/src/api/auth.ts](/Users/divyansh/Arceus/ui/src/api/auth.ts)` and `[ui/src/api/health.ts](/Users/divyansh/Arceus/ui/src/api/health.ts)`
- company and dialog context hooks

Those imports reveal that the file makes a few app-wide decisions before handing control to individual pages.

## 2. `BootstrapPendingPage`: The “You Can’t Use The App Yet” Screen

This small component is shown when the instance is in authenticated mode but no real admin has claimed it yet.

It is not an agent page. It is a bootstrap safety screen.

The important idea is:

- before normal navigation happens
- the app may need to stop and tell the operator to finish instance setup first

This is a good example of a route-level concern rather than a feature concern.

## 3. `CloudAccessGate`: Global Access Guard

This is one of the most important sections in the file.

`CloudAccessGate()` does two queries:

- health query
- session query

The health query asks the backend:

- are we running `local_trusted` or `authenticated` mode?
- is bootstrap complete?

Then the session query asks:

- if we are in authenticated mode, is there a logged-in user session?

### Why this matters

Without this gate, every single page would need to repeat the same startup logic.

Instead, `App.tsx` centralizes it:

- if app state is still loading, show loading
- if health fails, show an app-level error
- if bootstrap is pending, show bootstrap screen
- if authenticated mode is active but there is no session, redirect to `/auth`
- otherwise render `<Outlet />`, which means “the matched child route may continue”

### Beginner translation

`Outlet` means:

“I checked the front door rules. Now the actual page may render.”

## 4. `boardRoutes()`: The Real Board Route Map

This function is the big route list for the board UI.

It maps path segments to actual page components:

- `dashboard` -> `Dashboard`
- `agents/all` -> `Agents`
- `agents/:agentId` -> `AgentDetail`
- `agents/:agentId/:tab` -> `AgentDetail`
- `agents/:agentId/runs/:runId` -> `AgentDetail`
- `projects/...` -> `ProjectDetail`
- `issues/...` -> `IssueDetail`
- `meetings/...` -> `MeetingDetail`

This is the first place Phase 3 becomes concrete:

- the route `/agents/all` mounts `[ui/src/pages/Agents.tsx](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx)`
- the route `/agents/:agentId` mounts `[ui/src/pages/AgentDetail.tsx](/Users/divyansh/Arceus/ui/src/pages/AgentDetail.tsx)`

That means if the user says “why did this page open?”, this file is where you start.

### Important subtlety

There are multiple routes for the same page component.

For example:

- `agents/:agentId`
- `agents/:agentId/:tab`
- `agents/:agentId/runs/:runId`

All of them go to `AgentDetail`.

That means `AgentDetail.tsx` is not just “a page”; it is a route-aware page that interprets multiple detail states from URL params.

## 5. Redirect Helpers

Several small components in this file are redirect-only components:

- `InboxRootRedirect`
- `LegacySettingsRedirect`
- `CompanyRootRedirect`
- `UnprefixedBoardRedirect`

These exist because user-friendly systems evolve over time:

- old URLs may still exist
- generic URLs may need to become company-scoped URLs
- default tabs may need a canonical path

### `UnprefixedBoardRedirect` is especially important

Paperclip uses company prefixes in routes, but users may navigate to generic paths like `/agents/all`.

This helper rewrites those to the selected company prefix shape.

So this file does more than “show pages.” It also keeps navigation sane while the app uses company-aware routing.

## 6. Onboarding and Companyless Flow

This file also contains “what if the user has no company yet?” logic.

That matters because many routes only make sense after a company exists.

So `App.tsx` acts like the app’s first traffic checkpoint:

- if the instance is not ready, stop
- if the user is not authenticated, redirect
- if there is no company context yet, steer to onboarding
- otherwise render board pages

## 7. `App()`: Composition Root For The Frontend

`App()` is the composition root.

That means:

- it sets up the top-level route tree
- it wraps things in the right layout/gate structure
- it decides which routes are public versus board-only

This is the UI equivalent of backend `index.ts` plus `app.ts`.

Not identical, but conceptually similar:

- backend `index.ts` boots the server
- frontend `App.tsx` boots the visible navigation structure

## How To Read This File In Practice

Do not read it top to bottom asking “what does every JSX tag do?”

Read it with this checklist:

1. Which global gates exist before any page renders?
2. Which routes point to the feature I care about?
3. Which redirects rewrite or normalize navigation?
4. Which parts are true pages and which parts are wrappers around pages?

For agents, the key outcome is:

- `/agents/all` -> `Agents`
- `/agents/:agentId` -> `AgentDetail`

That is the handoff into the next two guides.

## What This File Does Not Tell You

This file does not tell you:

- how agents are fetched
- what the agent response shape is
- how agent permissions are enforced
- how runtime state gets merged into UI

For those, go next to:

- `[agents-page-tsx.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/agents-page-tsx.md)`
- `[agent-detail-tsx.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/agent-detail-tsx.md)`
- `[api-agents-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/03-feature-trace-agents/api-agents-ts.md)`

## Self-Check

You understand this file well enough if you can answer:

1. Why can a user hit `/agents/:agentId/runs/:runId` and still land on the same page component?
2. Why does the app need `CloudAccessGate` instead of checking auth inside every page?
3. What is the difference between a route map and a page component?

