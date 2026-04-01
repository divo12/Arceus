# Phase 8: Frontend System Map

This phase is where the UI stops being "the pretty layer" and starts becoming a study tool.

If the backend phases taught you how Paperclip works internally, this phase teaches you:

- what the product chooses to make visible
- which backend domains are important enough to get dedicated screens
- which concepts are global across the app
- where the UI is mostly wiring and where it does real thinking

In one sentence:

the frontend is the operator-facing map of the control plane.

---

## Why This Phase Matters

People new to a repo often make one of two mistakes:

1. they ignore the UI because they think it is "just display"
2. they read the UI as isolated React files without connecting it back to the backend

Both make the system harder to understand.

In Paperclip, the frontend tells you a lot about the product model:

- agents are not just records; they are live workers with runs, memory, budgets, and authority
- issues are not just backlog items; they are tied to execution
- hierarchy is not just admin data; it is something users reason about visually
- company scope is so fundamental that the whole app shell is built around it

That is why this phase belongs late in the learning path.

You already know the engine.

Now you are learning the dashboard.

---

## What This Phase Is Really Teaching

This phase is not mainly about React syntax.

It is mainly about:

### 1. Product surface area

[`ui/src/App.tsx`](/Users/divyansh/Arceus/ui/src/App.tsx) shows which domains have first-class routes.

If there is a dedicated page for something, the product usually considers that domain important.

### 2. Shared state boundaries

[`ui/src/components/Layout.tsx`](/Users/divyansh/Arceus/ui/src/components/Layout.tsx) and [`ui/src/context/CompanyContext.tsx`](/Users/divyansh/Arceus/ui/src/context/CompanyContext.tsx) show which state is application-wide instead of page-local.

### 3. Joined operational views

Pages like [`ui/src/pages/Agents.tsx`](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx) and [`ui/src/pages/Issues.tsx`](/Users/divyansh/Arceus/ui/src/pages/Issues.tsx) combine multiple backend sources into one operator view.

That combination is a product decision.

### 4. Concept shaping

Pages like [`ui/src/pages/Memory.tsx`](/Users/divyansh/Arceus/ui/src/pages/Memory.tsx) do not just display raw data.

They teach the user how to think about the subsystem.

---

## How To Read This Phase

Use the same method for every file:

1. ask what the file owns
2. ask what data it depends on
3. ask what backend domains it joins together
4. ask whether it is shell logic, page logic, or presentation logic
5. ask what misunderstanding a new engineer might have if they only skim it

Do not try to memorize JSX.

Try to build a stable mental map.

---

## Read Order

1. [`app-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/app-tsx.md)
2. [`layout-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/layout-tsx.md)
3. [`company-context-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/company-context-tsx.md)
4. [`agents-page-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/agents-page-tsx.md)
5. [`agent-detail-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/agent-detail-tsx.md)
6. [`issues-page-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/issues-page-tsx.md)
7. [`orgchart-page-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/orgchart-page-tsx.md)
8. [`memory-page-tsx.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/08-frontend-system-map/memory-page-tsx.md)

That order goes from broadest UI structure to more domain-specific pages.

---

## What Each File Gives You

### `App.tsx`

The route and gating map.

This file tells you:

- what pages exist
- how authentication/bootstrap gates work
- how company-prefixed routing works
- where the app hands off from global routing to the shared layout shell

### `Layout.tsx`

The shell and application-wide behavior.

This file tells you:

- what every board-facing page has in common
- how company route state syncs with selected company state
- which dialogs, panels, banners, and shortcuts are mounted globally
- how desktop and mobile shells differ

### `CompanyContext.tsx`

The company-scope backbone.

This file tells you:

- how the frontend loads companies
- how selected company is remembered
- why most pages do not manually manage company ID

### `Agents.tsx`

The operator fleet view.

This page tells you:

- agents are both org objects and live runtime actors
- list and org views are both product-level needs
- live heartbeat state matters enough to join directly into the list

### `AgentDetail.tsx`

The per-agent control center.

This page tells you:

- which subsystems converge on an agent
- how big pages in this repo are often coordinators for smaller sections
- how route state, query state, tab state, and mutation state interact

### `Issues.tsx`

A compact example of data joining.

This page tells you:

- issues are shown alongside execution context
- even "simple" pages in Paperclip often enrich base records with runtime state

### `OrgChart.tsx`

The hierarchy visualizer.

This page tells you:

- some frontend files do substantial presentation work
- hierarchy and reporting structure are product concepts, not just DB concepts
- visualization logic can live in the UI while domain truth stays in the backend

### `Memory.tsx`

The conceptual memory page.

This page tells you:

- memory is a product narrative, not only a backend feature
- the current UI is more explanatory than operational
- the system wants users to think in memory tiers and lifecycles

---

## The Main Frontend Mental Model

Here is the most useful simplified picture:

```text
App.tsx
  decides which page should exist for a URL

Layout.tsx
  wraps most board pages with shared shell behavior

CompanyContext.tsx
  tells the app which company we are currently operating inside

Page file
  fetches the domain data it needs
  joins related backend sources together
  passes data into presentational components
```

That means most pages are not doing core business logic.

They are doing:

- routing
- fetching
- joining
- presenting
- operator interaction wiring

The backend still owns the real invariants.

---

## What To Watch For While Reading

### Watch company scope carefully

A lot of UI files only make sense once you notice that the app is company-aware almost everywhere.

### Watch which pages join live run state

Whenever a page brings in heartbeat/run data, it is telling you that execution is central to that domain.

### Watch which pages are conceptual

Not every page is a raw CRUD screen.

For example, the memory page explains the system's intended mental model more than it exposes a low-level admin console.

### Watch route normalization

The app often redirects from generic URLs to canonical company-prefixed URLs.

That is not cosmetic.

It is part of how the product keeps scope explicit.

---

## Common Beginner Mistakes In This Phase

### Mistake 1: "The frontend just calls APIs."

It does call APIs, but the interesting part is which APIs it combines on one page and why.

### Mistake 2: "Routes are just navigation."

In this repo, routes also encode:

- auth expectations
- company scope
- canonical URL shape
- domain importance

### Mistake 3: "Page files equal complete behavior."

Often the page is the coordinator, while reusable components and hooks handle detailed presentation or interactions.

### Mistake 4: "If a page shows a concept, the UI must own the concept."

Usually the UI is visualizing or teaching a backend concept, not defining it.

---

## Checkpoint

By the end of this phase, you should be able to explain:

1. why the app uses company-prefixed routes
2. what the layout owns that pages should not own
3. why the agents page loads both agent list data and heartbeat data
4. why the org chart page contains layout math but not hierarchy business rules
5. why the memory page is partly a product explanation rather than a raw operational console

If you can explain those five things, the frontend will stop feeling like a pile of screens and start feeling like a map of the system.
