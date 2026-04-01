# `ui/src/pages/AgentDetail.tsx`

This guide explains [`ui/src/pages/AgentDetail.tsx`](/Users/divyansh/Arceus/ui/src/pages/AgentDetail.tsx) as the per-agent control center.

If you want one sentence first:

`AgentDetail.tsx` is where the frontend reveals that an agent in Paperclip is not just a row in a table, but a full operational unit with configuration, runs, prompts, skills, budget, memory, and authority.

---

## 1. Why This File Looks So Big

This file is large enough to intimidate almost anyone on first read.

That is normal.

The right way to read it is **not**:

"I must understand every helper and every JSX branch."

The right way is:

"What central job is this page doing, and which sub-areas does it delegate to smaller sections?"

This file is big because it is the coordinator for many agent-related surfaces, not because it owns every low-level detail itself.

---

## 2. Mental Model

Treat this page as the control room for one agent.

An operator comes here to answer questions like:

- who is this agent?
- what role and title does it have?
- what instructions does it run with?
- what configuration and adapter settings does it use?
- what skills are attached?
- what runs has it performed?
- what is its budget posture?
- what memory does it have?
- what authority and delegation rules apply to it?

That is why this page touches so many backend systems.

---

## 3. What This File Owns

At the top level, this file owns:

- route parameter interpretation
- canonical route normalization
- conditional query loading based on active tab
- top-level mutations for agent actions
- tab switching and tab-specific subpage rendering
- per-agent header actions and status handling
- breadcrumb construction
- save/cancel behavior for configuration-like tabs

It delegates most detailed rendering to subcomponents such as:

- `AgentOverview`
- `PromptsTab`
- `AgentConfigurePage`
- `AgentSkillsTab`
- `RunsTab`
- `AgentMemoryTab`
- `AuthorityTab`

This is a useful pattern to notice:

large page files in this repo are often orchestrators of many subviews.

---

## 4. Route Resolution Comes First

The page starts by reading route params:

- `companyPrefix`
- `agentId`
- `tab`
- `runId`

That means this page is driven by URL state, not local tab state alone.

This is important for two reasons:

### First

The page is deep-linkable.

You can link directly to:

- dashboard
- instructions
- configuration
- skills
- runs
- budget
- authority
- memory
- a specific run

### Second

The page has to normalize route state carefully.

It is not enough to say "show some agent data."

It must decide:

- which agent reference is canonical
- which company scope should apply
- which tab should be visible
- whether a run route should force the runs view

---

## 5. Canonical Agent Resolution

A subtle but very important idea in this file is:

the route might not start with the final canonical agent reference.

The page:

- looks up the agent using either route/company context
- derives `canonicalAgentRef`
- redirects if the current URL is not canonical

This is similar to the routing normalization you saw in `App.tsx`.

The UI wants stable, canonical URLs because:

- sharing links becomes safer
- navigation stays predictable
- page state is less ambiguous

So this file is not passively reading the route.

It is actively validating and repairing route shape.

---

## 6. Query Loading Is Intentionally Conditional

This is one of the best engineering lessons in the file.

Not every tab needs every query.

So the page uses derived booleans like:

- `needsDashboardData`
- `needsRunData`
- `shouldLoadHeartbeats`

and only enables some queries when the current view actually needs them.

### Why that matters

Without this, the page would:

- fetch too much data all the time
- make tab switches heavier
- create unnecessary network load
- make a big page even harder to reason about

So conditional query loading is doing performance work and architecture work.

It keeps the page from becoming a "fetch everything always" monster.

---

## 7. The Main Queries

At a high level, the page loads:

### Agent detail

The base record for the selected agent.

This is the anchor query.

Everything else depends on knowing which agent we are really talking about.

### Runtime state

Loaded for the dashboard view.

This tells you the product distinguishes:

- stored agent definition
- live runtime state

### Heartbeats / runs

Loaded for dashboard and runs views.

This is how run history and live execution become visible.

### Issues and all agents

Loaded for dashboard view.

These allow the page to show:

- issues assigned to this agent
- who this agent reports to
- who reports to this agent

### Budget overview

Loaded broadly because budget is a core operational concern.

### Authority and role definition

Loaded for the authority tab through dedicated hooks.

This shows that delegation/governance is an explicit operator-facing concern.

---

## 8. What The Page Computes From Raw Data

The page does not just display raw query outputs.

It derives useful operator-facing state, including:

- `assignedIssues`
- `reportsToAgent`
- `directReports`
- `agentBudgetSummary`
- `mobileLiveRun`

This is important because page logic in Paperclip often means:

"take several backend sources and reshape them into operator meaning."

That is different from business rule ownership.

The backend still owns the truth.

The page owns the operator-friendly synthesis.

---

## 9. Top-Level Mutations: The Agent Control Surface

This page provides actions like:

- invoke
- pause
- resume
- terminate
- update budget
- update icon
- reset sessions
- update permissions

These are not random convenience buttons.

They are the controls an operator needs for a live worker in a governed system.

So the page is not only descriptive.

It is also a command surface.

That helps explain why agent detail is such a central page in the product.

---

## 10. Breadcrumbs And Navigation Meaning

The breadcrumb effect is more important than it looks.

It changes breadcrumb structure depending on:

- active tab
- whether a specific run is open

That means the UI treats agent tabs and run detail pages as meaningful navigation states, not just small subviews.

For example:

- `Agent -> Runs -> Run 1234`

is treated as a real navigation path.

This reinforces the idea that run history is a first-class part of agent identity.

---

## 11. The Header Tells You What The Product Thinks Matters

The header includes:

- icon
- name
- role/title
- assign task
- run heartbeat
- pause/resume
- status badge
- overflow actions like reset sessions / terminate

This tells you what the product thinks are the most important "at a glance" and "one-click" actions for an agent.

It is a useful reading technique:

look at the header of a detail page and ask what the product designer believed should be immediately accessible.

---

## 12. The Tab Structure Is The Real System Map

The tab bar is one of the best backend maps in the UI:

- Dashboard
- Instructions
- Skills
- Configuration
- Runs
- Budget
- Authority
- Memory

These tabs are a powerful clue.

They say:

an agent is simultaneously:

- an organizational actor
- a configured runtime
- a prompt-bearing worker
- a skill carrier
- a run-producing executor
- a budget-controlled cost center
- a governed delegate
- a memory-bearing intelligence unit

That is one of the clearest summaries of the whole repo.

---

## 13. Dashboard Tab

The dashboard tab is the "agent as operational summary" view.

It is where multiple systems come together:

- current runtime state
- recent runs
- assigned issues
- reporting relationships
- cost and success/activity summaries

This is the best tab for understanding the agent as a live unit in the company.

---

## 14. Instructions And Configuration Tabs

These tabs are especially important because they share save/cancel behavior.

The page manages:

- dirty state
- saving state
- save/cancel action references
- floating desktop action bar
- fixed mobile bottom action bar

This is a very practical UI architecture choice.

The top-level page owns save UX consistency, while the tab subcomponents own the actual editing logic.

That means:

- child tab says "I have unsaved changes"
- parent page provides a consistent save/cancel shell

This is a good example of parent-child coordination in a complex page.

---

## 15. Skills Tab

The skills tab shows that skill composition is part of agent identity.

That matters because Paperclip agents are not only configured through prompts or adapter settings.

They also have attached skills, which affects behavior and execution capability.

So this page makes the skill system part of normal operator understanding.

---

## 16. Runs Tab

The runs tab is one of the most important sections.

It reveals a lot about Paperclip execution design.

### `RunsTab`

This component:

- sorts runs newest-first
- auto-selects latest run on desktop
- behaves differently on mobile vs desktop
- splits between run list and run detail

That means runs are important enough to deserve a mini navigator inside the page.

### `RunDetail`

This section goes even deeper and supports:

- hydrating full run details
- canceling runs
- resuming process-lost runs
- retrying failed/timed-out runs
- clearing sessions for touched issues
- running Claude login flow for some adapters
- streaming log and workspace operation details

This is far beyond "show run logs."

It is a real operational debugging and recovery surface.

---

## 17. Budget Tab

The budget tab shows that cost control is not separated from agent management.

An agent has:

- spend
- budget amount
- utilization
- hard-stop posture
- pause status interactions

This reflects a core system invariant:

budget governance is part of execution control, not an unrelated finance page.

---

## 18. Memory Tab

The memory tab uses `AgentMemoryTab`, which means memory is not just a company-level concept.

It is also visible per agent.

This aligns with the broader backend memory model:

- runs produce experiences
- memories attach to agents and execution context
- operators may need to inspect that memory surface per worker

So memory is woven into the agent model, not bolted on as a separate lab tool.

---

## 19. Authority Tab

This tab is especially useful for understanding the product's governance layer.

It combines:

- the agent
- the agent's delegation authority
- the role definition

So the operator can understand not just "what this agent does," but "what this agent is allowed to delegate or decide."

That is a very strong sign that governance is a first-class concept in Paperclip.

---

## 20. The Huge Supporting Helper Surface

You will notice many helper functions for things like:

- redacting env/log values
- scroll handling
- metrics extraction
- log parsing
- workspace operation display

These helpers can make the file look overwhelming.

The right way to interpret them is:

this page has to present a lot of rich operational data safely and readably.

So the helper surface exists mostly to support:

- log safety
- readability
- tab-specific UX
- run detail polish

They are not all equally central to the page's conceptual role.

---

## 21. What This Page Reveals About The Backend

This page reveals that an "agent" touches nearly every major subsystem:

- configuration
- prompts/instructions
- skills
- runtime execution
- budgets
- issue assignment
- memory
- hierarchy and authority
- assets/workspaces
- adapter-specific flows

That is why learning this page gives you a much richer understanding of the repo than reading a simple CRUD detail page would.

---

## 22. Common Beginner Misunderstandings

### Misunderstanding 1: "This file is too big, so it must be badly designed."

It is large, but much of its size comes from coordinating multiple subviews and operational helper surfaces.

The key is to understand its top-level orchestration role first.

### Misunderstanding 2: "Agent detail is mostly configuration."

No.

Configuration is only one part. Runtime, memory, governance, and cost are equally important here.

### Misunderstanding 3: "Runs are just history."

Not here.

Runs are also a live recovery and debugging surface.

### Misunderstanding 4: "Tabs are just UI organization."

They are also a product-level statement about what an agent fundamentally is in the system.

---

## 23. Self-Check

After reading [`ui/src/pages/AgentDetail.tsx`](/Users/divyansh/Arceus/ui/src/pages/AgentDetail.tsx), you should be able to answer:

1. why does this page conditionally load queries based on the active tab?
2. what does the tab structure reveal about the Paperclip agent model?
3. why is route canonicalization important here?
4. what is the difference between agent definition data and runtime/run data on this page?
5. why is this page one of the strongest maps of the whole backend?

If you can answer those, this huge file becomes much less intimidating.
