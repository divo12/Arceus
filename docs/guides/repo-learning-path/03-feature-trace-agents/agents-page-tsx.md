# `ui/src/pages/Agents.tsx`

This guide explains [`ui/src/pages/Agents.tsx`](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx) as the “agent list coordinator” page.

If you want one sentence first:

`Agents.tsx` is the page that turns company selection, URL filters, query results, and live heartbeat data into the visible list or org chart of agents.

## Mental Model

This file is not where agent rules live.

It is where display state gets assembled.

That means it mostly does four jobs:

1. figure out which company and tab the user is looking at
2. load the right data
3. derive UI-friendly views from that data
4. render list view or org view

So think of it as a page-level coordinator, not a business-logic engine.

## What Enters This File

The main inputs are:

- selected company from `useCompany()`
- current URL from `useLocation()`
- sidebar/mobile state from `useSidebar()`
- dialog actions like `openNewAgent()`
- query results from React Query

The most important hidden idea is that a page component sits between:

- routing context above it
- API/data functions below it

That is why this page does not know SQL and does not know backend auth rules. It lives in the middle.

## Step 1: Turn URL Into Local UI State

The page reads the last path segment and interprets it as a filter tab:

- `all`
- `active`
- `paused`
- `error`

So if the URL is `/agents/paused`, the page does not need a separate page file. It uses one component and just changes the `tab` value.

This is a common React pattern:

- one route family
- one page component
- different URL params or segments drive different filtered views

## Step 2: Decide View Mode

The page supports two visual modes:

- list
- org

It also has a mobile rule:

- on mobile, force list view

This is a good example of page logic that is neither frontend-global nor backend-domain logic. It is pure screen orchestration.

## Step 3: Fetch Data

The page issues three major queries:

### 1. Agents list

`agentsApi.list(selectedCompanyId)`

This gives the basic agent rows.

### 2. Org tree

`agentsApi.org(selectedCompanyId)`

This is only enabled in org view.

That detail matters because it shows thoughtful query design:

- do not fetch org tree when list view is active

### 3. Heartbeat runs

`heartbeatsApi.list(selectedCompanyId)`

This is the live runtime information used to show whether agents currently have queued or running work.

It refetches every 15 seconds.

That means the page is not purely static “load once” UI. It has a small live-operational feel.

## Step 4: Build Derived State

This file becomes much easier once you notice the difference between:

- fetched state
- derived state

Fetched state:

- `agents`
- `orgTree`
- `runs`

Derived state:

- `liveRunByAgent`
- `agentMap`
- `filtered`
- `filteredOrg`
- `effectiveView`

### `liveRunByAgent`

This is the most important derived structure on the page.

It loops over heartbeat runs and builds a map:

- key = `agentId`
- value = first live run id plus count of live runs

Why do this?

Because the raw runs list is not shaped for rendering a list of agents.

The UI wants to answer:

- does this agent currently have live work?
- if yes, which run should I link to?
- how many live runs exist?

So the page transforms backend-shaped data into screen-shaped data.

That is one of the main jobs of a page component.

## Step 5: Handle Global Page States

Before rendering the main content, the page handles common situations:

- no company selected
- loading
- empty company
- request error

This is standard but important.

If you are learning frontend architecture, notice that page components often own these states because they are closest to both:

- the query lifecycle
- the visual rendering lifecycle

## Step 6: Render Filters, View Toggles, And Actions

The top controls area handles:

- filter tabs
- filters dropdown
- list/org toggle
- “New Agent” button

This part is not just visual decoration. It is how the page turns user intent into state transitions:

- clicking a tab changes the URL
- clicking view toggle changes local state
- clicking “New Agent” opens dialog flow

This is why page components are often called “container” or “coordinator” components: they wire interactions into data and rendering.

## Step 7: Render The Actual Agent List

In list mode, the page maps filtered agents into `EntityRow` items.

For each agent, it shows things like:

- name
- role/title
- status
- last activity
- live run indicator if there is active queued/running work

An important detail here:

the page uses both static agent data and live run data at the same time.

That means the list is not a plain database dump. It is a composed operational view.

## Step 8: Render The Org Tree

In org mode, the page uses `OrgTreeNode` recursively.

This is a tree-rendering pattern:

- a node can render itself
- then render its child reports using the same component

This is the right UI shape because the backend org endpoint already returns hierarchical data, not just flat rows.

So the page’s job is:

- preserve hierarchy
- filter it without losing necessary parent nodes

That is why `filterOrgTree(...)` is recursive too.

It makes sure:

- if a child matches the filter
- the parent can still remain visible so the tree still makes sense

## What This File Knows And What It Does Not Know

This file knows:

- company selection
- query timing
- screen filters
- display modes
- how to merge live run state into display

This file does not know:

- the exact backend endpoint strings
- how agent ambiguity is resolved
- how auth checks happen on the server
- how the agent table is stored in PostgreSQL

Those belong to:

- [`ui/src/api/agents.ts`](/Users/divyansh/Arceus/ui/src/api/agents.ts)
- [`server/src/routes/agents.ts`](/Users/divyansh/Arceus/server/src/routes/agents.ts)
- [`server/src/services/agents.ts`](/Users/divyansh/Arceus/server/src/services/agents.ts)

## Technical Thinking: Why This Page Is Well Chosen For Learning

This page is a great beginner file because it demonstrates a realistic frontend pattern without being as huge as the agent detail page.

It teaches:

- route-driven filters
- query-driven rendering
- derived maps for fast UI lookup
- recursive tree rendering
- difference between list data and live operational overlay data

Once this file makes sense, many other list pages in the repo will feel familiar.

## Self-Check

You understand this file if you can answer:

1. Why does the page fetch both agents and heartbeat runs?
2. Why is the org tree query conditional?
3. Why is `liveRunByAgent` computed in the page instead of returned by the backend as-is?
4. What changes when the URL goes from `/agents/all` to `/agents/error`?
