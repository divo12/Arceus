# `server/src/routes/hierarchy.ts`

This guide explains [`server/src/routes/hierarchy.ts`](/Users/divyansh/Arceus/server/src/routes/hierarchy.ts) as the HTTP workflow around hierarchy proposals.

If you want one sentence first:

`routes/hierarchy.ts` turns the hierarchy snapshot service into a proposal/review/activation API, with company scoping, board approval gates, and a special CEO-only agent proposal rule.

## Mental Model

The service file manages hierarchy lifecycle.

This route file manages who is allowed to move that lifecycle forward over HTTP.

So the important questions here are:

- who may view hierarchy state?
- who may propose changes?
- who may approve, activate, or reject?
- how does a reviewer inspect changes before activation?

## What This File Owns

This file owns:

- fetching active hierarchy with edges
- listing hierarchy proposals
- creating a proposal
- fetching one snapshot with its edges
- diffing a proposal against current active hierarchy
- approving, activating, and rejecting proposals

This is the operator workflow surface for hierarchy governance.

## 1. Active Hierarchy Read

`GET /companies/:companyId/hierarchy`

This route:

- checks company access
- loads the active snapshot, if any
- loads its edges
- returns a combined payload

That is the “show me the current structure” endpoint.

Returning `null` when no active snapshot exists is also important because it makes the absence of governed structure explicit.

## 2. Proposal Listing

`GET /companies/:companyId/hierarchy/proposals`

This exposes the history of proposals for a company.

That matters because hierarchy governance is a workflow, not just current-state inspection.

## 3. Proposal Creation

`POST /companies/:companyId/hierarchy/proposals`

This route is especially interesting.

It allows:

- normal company-scoped access

but then adds an extra rule:

- if the caller is an agent, only a CEO agent may propose hierarchy changes

That is a very explicit product rule.

It means:

- humans with company access may propose
- agents may only propose if they are specifically the CEO

This is governance, not just graph editing.

The route also captures actor identity so the service can persist:

- proposedByAgentId
- proposedByUserId

## 4. Snapshot Detail

`GET /hierarchy/:snapshotId`

This route loads:

- the snapshot
- its company for access check
- all its edges

and returns the combined object.

This is the “inspect one proposal or snapshot” endpoint.

## 5. Diff Endpoint

`GET /hierarchy/:snapshotId/diff`

This is one of the best governance endpoints in the file.

If there is no active snapshot yet:

- all edges in the target snapshot are treated as `added`

If there is an active snapshot:

- the service computes added and removed edges against the current active structure

This endpoint exists because reviewers need comparative context, not just isolated data.

## 6. Approve / Activate / Reject

These three endpoints are intentionally separate:

- `POST /hierarchy/:snapshotId/approve`
- `POST /hierarchy/:snapshotId/activate`
- `POST /hierarchy/:snapshotId/reject`

All require board authentication and company access.

### Why separate approve and activate?

Because review and promotion are different governance stages.

Approval means:

- this proposal is acceptable

Activation means:

- make this the live structure now

That separation is operationally useful and conceptually clean.

## Technical Thinking

The most important thing to notice is that the route layer preserves hierarchy as a governance workflow, not a direct-edit API.

That is why the endpoints look like:

- propose
- inspect
- diff
- approve
- activate
- reject

instead of:

- patch hierarchy edges directly

That endpoint design reveals the product philosophy very clearly.

## What This File Does Not Own

This file does not:

- compute hierarchy diffs itself
- activate snapshots itself
- rewrite `reportsTo` directly

Those remain service responsibilities.

The route file only exposes the workflow safely.

## Self-Check

You understand this file if you can answer:

1. Why is a CEO-only agent rule enforced at proposal time?
2. Why is a diff endpoint valuable for hierarchy governance?
3. Why should approve and activate remain separate actions?
