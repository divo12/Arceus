# `ui/src/pages/OrgChart.tsx`

This guide explains [`ui/src/pages/OrgChart.tsx`](/Users/divyansh/Arceus/ui/src/pages/OrgChart.tsx) as the visual hierarchy page.

If you want one sentence first:

`OrgChart.tsx` turns backend organizational and hierarchy data into a navigable visual model, which makes it one of the clearest examples of the frontend doing substantial presentation work without owning the underlying governance rules.

---

## 1. Mental Model

This page answers:

- who reports to whom?
- what does the company structure look like?
- what delegation edges are active?
- are there pending hierarchy proposals?

It is not only a page for showing rows of data.

It is a page for spatial understanding.

That is why it includes tree layout math, pan/zoom, and overlay rendering.

---

## 2. What This File Owns

This page owns:

- loading org tree
- loading flat agent records for enrichment
- loading active hierarchy snapshot
- loading hierarchy proposals
- computing a visual layout for the org tree
- deriving visual bounds
- handling pan/zoom interaction
- rendering normal reporting edges and delegation overlays together

It does **not** own:

- the meaning of reporting relationships
- the meaning of hierarchy edges
- approval logic for hierarchy changes

Those are backend responsibilities.

---

## 3. The Two Different Kinds Of Structure It Combines

This page is especially useful because it combines two related but different structural models.

### 1. Org tree

Loaded from `agentsApi.org(...)`.

This is the reporting structure:

- manager
- reports
- org-shaped hierarchy

### 2. Active hierarchy snapshot

Loaded from `hierarchyApi.getActive(...)`.

This can contain edges like delegation relationships that are not the same thing as normal reporting structure.

That distinction matters a lot.

The page is teaching the user:

"organizational reporting" and "delegation/authority structure" are related, but not identical.

---

## 4. Why It Also Loads Agents And Proposals

The page also loads:

### Agents list

This enriches org nodes with additional agent details that may not be fully present on the org tree nodes.

### Proposals

This lets the page show pending proposal count and connect the visual state to governance workflow.

That means the page is not just a frozen diagram.

It is connected to live governance process.

---

## 5. The Layout Algorithm Is One Of The Most Important Parts

Several helper functions exist purely to compute where nodes should go:

- `subtreeWidth(...)`
- `layoutTree(...)`
- `layoutForest(...)`
- `flattenLayout(...)`
- `collectEdges(...)`

This is where the UI does real work.

### What the backend gives

The backend gives the structure.

### What the frontend adds

The frontend decides:

- how wide each subtree needs to be
- where each box should sit
- how to flatten the tree for rendering
- how to draw parent-child edges

This is a very clean example of responsibility split:

- backend owns domain truth
- frontend owns visual geometry

That is exactly how it should be.

---

## 6. `subtreeWidth(...)`

This helper answers:

"How much horizontal space does this node and all its descendants need?"

That matters because if the UI guesses badly, the chart becomes unreadable:

- cards overlap
- children collide
- parents are off-center

So this function is part of the page's spatial reasoning layer.

It is not business logic, but it is still important logic.

---

## 7. `layoutTree(...)` And `layoutForest(...)`

These functions recursively place nodes.

### `layoutTree(...)`

Places one node and its descendants.

### `layoutForest(...)`

Places multiple top-level roots side by side.

This tells you the page supports more than one root node.

That is an interesting product clue:

the app is prepared for org structures that are not one single-root pyramid.

---

## 8. Delegation Overlay

The page computes `delegationEdges` from the active hierarchy snapshot and filters for `delegates_to`.

This is very important conceptually.

It means the chart is not only:

"Who manages whom?"

It is also:

"Who delegates to whom?"

That is a different kind of line.

So the page becomes a visual explanation of governance, not only org structure.

This is one of the best UI proofs that hierarchy in Paperclip is more than a simple manager tree.

---

## 9. Pending Proposal Count

The proposal count is another small but important clue.

The page is aware of:

- the currently active structure
- the pipeline of proposed structural changes

That means governance is not hidden behind a back-office admin page.

It is surfaced right next to the structural visualization.

This is a strong product signal.

---

## 10. Bounds, Pan, And Zoom

After layout, the page computes bounds and supports:

- centering the chart initially
- zooming
- panning
- dragging

This is a good reminder that serious frontend work is often about interaction and legibility, not just calling APIs.

If the chart were static, large organizations would quickly become unusable.

So the page takes responsibility for making a big structural model explorable.

---

## 11. Why This Page Is Different From `Agents.tsx`

`Agents.tsx` also has an org view, but it is not the same thing.

### `Agents.tsx`

Uses a recursive textual tree for quick browsing.

### `OrgChart.tsx`

Uses spatial layout and visual edges for deeper structural understanding.

This distinction matters because it shows two levels of frontend responsibility:

- lightweight structural browsing
- dedicated visualization

Both consume related backend data, but they serve different operator goals.

---

## 12. What This Page Reveals About The Backend

This page reveals:

### Organizational structure is a first-class concept

Because it gets a dedicated visual page.

### Hierarchy and delegation are not identical

Because both are shown and treated separately.

### Governance is visible, not hidden

Because active structure and pending proposals are shown together.

### The backend provides structured data, not ready-made pixel coordinates

Because the frontend computes layout itself.

---

## 13. Common Beginner Misunderstandings

### Misunderstanding 1: "This page owns org logic."

No.

It owns org visualization logic.

### Misunderstanding 2: "The org tree and hierarchy snapshot are the same thing."

They are related but distinct sources.

### Misunderstanding 3: "The helper math is unimportant because it is just display."

For a visualization page, display math is central to usability.

### Misunderstanding 4: "This is just a nicer version of the agents page."

Not really.

It is a deeper, more explicitly structural and governance-aware page.

---

## 14. Self-Check

After reading [`ui/src/pages/OrgChart.tsx`](/Users/divyansh/Arceus/ui/src/pages/OrgChart.tsx), you should be able to answer:

1. what is the difference between the org tree and the active hierarchy snapshot?
2. why does this page need layout helper functions?
3. what backend truths does the frontend visualize here without owning?
4. why are delegation edges conceptually different from normal parent-child edges?
5. how is this page different from the org view on the agents page?

If you can answer those, you understand the role of this page very well.
