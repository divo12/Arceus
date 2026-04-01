# `server/src/services/hierarchy.ts`

This guide explains [`server/src/services/hierarchy.ts`](/Users/divyansh/Arceus/server/src/services/hierarchy.ts) as the versioned org-structure service.

If you want one sentence first:

`hierarchy.ts` manages proposed, approved, rejected, and activated hierarchy snapshots, then applies the active `reports_to` edges back onto employee agents when a snapshot becomes live.

## Mental Model

This file is not about delegation permissions.

It is not about runtime spawn limits.

It is about structural org modeling:

- what the company org graph should be
- how changes are proposed
- how they are reviewed
- how one proposal becomes the active structure

So the key idea here is versioned hierarchy, not ad hoc mutation.

## Why Snapshot Modeling Matters

A simpler design could have said:

- just update `agents.reportsTo` directly whenever someone changes the org chart

This file chooses a more governed model:

- create a snapshot proposal
- store its edges
- approve or reject it
- activate it intentionally

That gives the system:

- review
- diffs
- history
- controlled promotion

That is much better for governance.

## What This File Owns

This file owns:

- proposing hierarchy snapshots
- fetching snapshots and active hierarchy
- approving snapshots
- rejecting snapshots
- activating approved snapshots
- reading snapshot edges
- building a proposal from current agent state
- diffing snapshots

This is the full lifecycle of versioned org structure.

## 1. `proposeSnapshot(...)`

This helper creates:

- one `hierarchySnapshots` row
- many `hierarchyEdges` rows linked to it

and does so inside a transaction.

That is important because the snapshot and its edges must be created together.

Otherwise you could end up with:

- a snapshot with no edges
- or edges without a valid snapshot

This is a classic transactional boundary.

## 2. `getById(...)` and `getCurrentActive(...)`

These methods answer the two most common reads:

- fetch one snapshot by id
- fetch the currently active snapshot for a company

The active snapshot method is especially important because “current truth” is a first-class concept in this service.

That is the snapshot the rest of the system can treat as the live org structure.

## 3. `approve(...)`

Approval is intentionally restricted to snapshots currently in `proposed` status.

That means the service enforces lifecycle state transitions instead of allowing arbitrary status jumps.

When approval happens, the snapshot records:

- approving user id
- approval time
- updated time

This is governance metadata, not just a status flag.

## 4. `activate(...)`

This is the most important method in the file.

It does a lot in one transaction:

1. load target snapshot
2. require that it is already approved
3. find current active snapshot, if any
4. mark current active as superseded
5. mark target snapshot as active
6. clear `reportsTo` on all employee agents in the company
7. load `reports_to` edges from the snapshot
8. write those edges back onto `agents.reportsTo`

This is the moment where versioned structure becomes operational truth.

### Why clear all `reportsTo` first?

Because activation wants the active snapshot to be the whole truth, not a partial patch.

If old `reportsTo` values were left in place, stale relationships could survive activation incorrectly.

So the service resets the employee hierarchy first, then reapplies exactly what the active snapshot says.

That is a very important design detail.

## 5. `reject(...)`

Rejecting a snapshot sets status to `rejected` and records the actor and reason through the description field update.

That shows the service is managing a review workflow, not just a graph table.

## 6. `getEdges(...)`

This method fetches the edges for a snapshot, optionally filtered by edge type.

This is useful because the snapshot metadata alone is not enough.

You often need the actual graph edges to:

- inspect
- render
- diff
- activate

## 7. `listProposals(...)`

This returns snapshots for a company ordered by newest first.

That is the operator-facing history surface of hierarchy governance.

## 8. `buildFromCurrentAgents(...)`

This method auto-materializes a new snapshot from the current `agents.reportsTo` data.

That is a bridge between:

- today’s live agent rows

and:

- the governed snapshot workflow

This is especially useful when introducing or migrating to snapshot-based hierarchy management.

## 9. `diffSnapshots(...)`

This method compares edges of two snapshots and returns:

- added edges
- removed edges

This is exactly what human governance workflows need.

Operators reviewing a proposal want to know:

- what changes if we activate this?

not just:

- what edges exist?

That is why diff support is such a valuable part of the service.

## Technical Thinking

The deepest idea in this file is that structure changes are treated like versioned proposals, not casual edits.

That is a strong governance posture.

It means hierarchy is:

- reviewable
- comparable
- activatable
- historically meaningful

That is much more robust than direct row mutation.

## What This File Does Not Own

This file does not decide:

- who may delegate work
- who may spawn helpers
- who may assign an issue

It only manages the structural org graph and its lifecycle.

## Self-Check

You understand this file if you can answer:

1. Why is snapshot activation more than just setting a status flag?
2. Why does activation rewrite `agents.reportsTo` from scratch instead of patching a few rows?
3. Why is hierarchy governance easier to review when diffs and snapshot history exist?
