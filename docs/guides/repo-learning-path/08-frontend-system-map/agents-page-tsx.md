# `ui/src/pages/Agents.tsx`

This guide explains [`ui/src/pages/Agents.tsx`](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx) as the fleet view for operators.

If you want one sentence first:

`Agents.tsx` shows that Paperclip treats agents as both organizational records and live runtime workers, so the page combines static agent data, org structure, and heartbeat activity in one place.

---

## 1. Mental Model

This page is the "see all employees" screen.

But in Paperclip, seeing all employees is not only about names and roles.

The operator also needs to know:

- who exists
- who reports to whom
- who is active, paused, or errored
- who has live work running right now
- which adapter each agent uses
- whether the org is easier to understand as a list or a tree

So this is not just a list page.

It is an operational overview page.

---

## 2. What This File Owns

This page owns:

- top-level agent filters by status
- switching between list view and org view
- loading agent list data
- loading org tree data
- loading live run data
- joining live run state onto agents
- showing fleet-level empty/error states
- launching "new agent" flow

It does **not** own:

- the full agent editing experience
- detailed run analysis
- full hierarchy visualization

Those live in other pages.

---

## 3. The Three Main Backend Data Sources

This page is important because it joins three different kinds of backend information.

### 1. Agent list

From `agentsApi.list(selectedCompanyId)`.

This gives the base agent records:

- name
- role
- adapter type
- status
- heartbeat timestamps
- reporting metadata

### 2. Org tree

From `agentsApi.org(selectedCompanyId)`.

This is not the same shape as the flat list.

It is already structured as parent/child reporting relationships.

### 3. Heartbeat runs

From `heartbeatsApi.list(selectedCompanyId)`.

This gives live execution state.

The page filters those runs down to ones that are currently `running` or `queued` and maps them back to agents.

That is the key join.

---

## 4. Why This Join Matters

This page teaches one of the most important repo truths:

an agent is not just a configuration record in the database.

An agent is also a live runtime participant.

That is why the page does not stop at:

- role
- status
- adapter

It also asks:

- does this agent have a live run right now?
- if yes, which run should the operator jump into?

This is how the UI makes backend execution visible.

---

## 5. Filter Tabs: Product Semantics

The top tabs are:

- all
- active
- paused
- error

The helper functions `matchesFilter`, `filterAgents`, and `filterOrgTree` are small but meaningful.

They tell you how the UI thinks about status groups.

For example:

- "active" includes `active`, `running`, and `idle`
- terminated agents are handled specially through a separate toggle

That means the product-level view of status is not always one-to-one with raw backend status strings.

The UI is grouping low-level states into operator-friendly categories.

---

## 6. `showTerminated` Is A Nice Product Clue

Terminated agents are hidden by default and shown only when the filter toggle is enabled.

That tells you the app thinks:

- terminated agents are still meaningful records
- but they are not part of the normal day-to-day operational view

So the page treats "currently relevant fleet" differently from "historical agents that still exist in the system."

That is a useful product distinction.

---

## 7. List View vs Org View

This is one of the best clues in the file.

The page supports two ways to understand the same agent population:

### List view

Best for:

- scanning statuses
- comparing adapters
- seeing recent heartbeat times
- quick fleet management

### Org view

Best for:

- seeing reporting relationships
- understanding organizational structure
- visualizing management chains

This tells you Paperclip does not think "agent fleet" is only a flat inventory problem.

It is also an organizational structure problem.

That is very aligned with the whole "AI company" idea in the backend.

---

## 8. Why Mobile Forces List View

On mobile, the page forces list view.

That is a practical UX decision:

- org tree views are harder to read on small screens
- list view is more stable and scannable on mobile

This is a good example of frontend files making real interaction tradeoffs, not just reusing the same layout everywhere.

---

## 9. `liveRunByAgent`: Turning Runs Into Operator Signals

One of the most important pieces of logic in this file is the `liveRunByAgent` map.

It:

- scans the company's runs
- keeps only running/queued runs
- groups them by `agentId`
- stores the first run ID and a live run count

That gives the UI enough information to show:

- whether an agent has live work
- where to link if the operator clicks
- whether the agent has more than one active run

This is a great example of page-level joining logic:

the page is not changing backend truth, but it is preparing operator-focused derived state.

---

## 10. The Org View Is Not The Same As `OrgChart.tsx`

This page's org view is a nested textual tree, not the full visual org chart page.

That difference matters.

### In `Agents.tsx`

Org view is lightweight and embedded in fleet management.

### In `OrgChart.tsx`

The page is a richer visual exploration tool with layout geometry and hierarchy overlays.

So `Agents.tsx` gives you "org awareness," while `OrgChart.tsx` gives you "org visualization."

That is a useful distinction when learning the repo.

---

## 11. The `OrgTreeNode` Component

The recursive `OrgTreeNode` is important because it shows how the org API is consumed.

Each node displays:

- name
- role
- title when available
- status
- adapter and heartbeat timing on larger screens
- live run indicator if present

And then it recursively renders reports.

This tells you the org endpoint is already returning hierarchical structure, which the UI then walks recursively.

So the backend owns organizational truth.
The page owns how to present that truth simply.

---

## 12. The `LiveRunIndicator`

This tiny component tells you a lot.

It turns runtime information into a very actionable UI object:

- animated dot
- "Live" label
- direct link into the run detail route

This is a core product idea in miniature:

execution state should be one click away from the main operator overview.

The system does not hide live execution behind a separate tools page.

It pulls that signal straight into the fleet view.

---

## 13. What This Page Reveals About Backend Design

This page reveals that:

### Agents are long-lived domain objects

Because they have names, roles, titles, managers, adapters, and statuses.

### Agents also have live execution state

Because heartbeat runs are joined onto them.

### Org structure matters to the product

Because both flat and tree views are built into the main page.

### Adapters matter operationally

Because adapter type is shown directly in the fleet list.

This is a quiet but important clue that runtime implementation type is considered operator-relevant.

---

## 14. What This Page Does Not Do

This page does not:

- edit agent configuration
- show full run transcript details
- explain memory/authority deeply
- render complex hierarchy overlays

That is good.

It stays focused on the fleet overview and links you deeper when needed.

---

## 15. Common Beginner Misunderstandings

### Misunderstanding 1: "This is just a list of agents."

It is really a joined operational overview.

### Misunderstanding 2: "Org tree and agent list are the same data."

They are related but not identical.

One is flat inventory data.
One is hierarchical structure data.

### Misunderstanding 3: "Heartbeat data belongs only on a run page."

No. This page proves execution state matters enough to appear at fleet level.

### Misunderstanding 4: "Terminated means gone."

Not necessarily.

The UI hides them by default for clarity, but the records still exist.

---

## 16. Self-Check

After reading [`ui/src/pages/Agents.tsx`](/Users/divyansh/Arceus/ui/src/pages/Agents.tsx), you should be able to answer:

1. why does this page load both agent list data and heartbeat run data?
2. what is the difference between list view and org view?
3. why is `liveRunByAgent` a useful derived structure?
4. what does this page show about the difference between agent identity and agent runtime state?
5. how does this page reflect the "AI company" idea behind the backend?

If you can answer those, you understand why this page is much more important than a simple CRUD list.
