# `server/src/services/delegation-guard.ts`

This guide explains [`server/src/services/delegation-guard.ts`](/Users/divyansh/Arceus/server/src/services/delegation-guard.ts) as the task-handoff gatekeeper.

If you want one sentence first:

`delegation-guard.ts` decides whether one agent is allowed to delegate work to another agent, based on company boundaries, spawned-agent restrictions, and the delegator’s role definition.

## Mental Model

This file is not about org charts.

It is not about runtime spawning.

It is specifically about task handoff:

“may agent A give this work to agent B?”

That is a narrower question than “who reports to whom?”

Paperclip keeps that narrower question in its own service because delegation is an operational permission, not just a structural relationship.

## What This File Owns

This file owns:

- checking whether one agent may delegate to another
- blocking invalid delegation across companies
- blocking spawned agents from delegating
- blocking spawned agents from receiving delegated work
- looking up role-definition delegation authority
- validating delegation chains for cycles and maximum depth

That is a small service, but it enforces a very important product rule.

## 1. `canDelegate(...)`

This is the heart of the file.

It answers one yes/no question with a human-readable reason.

### The decision flow

It roughly checks:

1. if source and target are the same, allow self-assignment
2. load source agent, target agent, and source role definition
3. reject if source agent does not exist
4. reject if source agent is spawned
5. reject if target agent does not exist
6. reject if agents are in different companies
7. reject if target agent is spawned
8. if there is no role definition, allow as permissive fallback
9. otherwise check whether target role is in `fromRole.canDelegateTo`

That is a very clean governance function:

- small
- explicit
- human-readable reasons

## 2. Why Spawned Agents Are Treated Differently

This is one of the most important design choices in the file.

Spawned agents:

- cannot delegate
- cannot receive delegated work

Why?

Because Paperclip is distinguishing:

- durable employee-like company actors

from:

- temporary helper runtime actors

If spawned helpers could freely delegate, the governance model would become much harder to reason about and much easier to abuse.

## 3. Company Boundary Check

The file explicitly rejects cross-company delegation.

That is a critical multi-tenant safety rule.

Even if all other role logic said yes, company separation must still win.

This is a good example of product boundary rules being enforced before role semantics are even considered.

## 4. Permissive Fallback Without A Role Definition

One subtle design choice here is:

if no role definition exists, delegation falls back to permissive allow.

That is worth noticing.

It suggests the system is trying to remain operational even if governance templates are incomplete.

This may be a compatibility or migration-friendly choice rather than the strictest possible one.

It is important because it tells you the system values graceful behavior when governance data is partially missing.

## 5. `assertCanDelegate(...)`

This is the service-to-route convenience layer.

It calls `canDelegate(...)`, and if delegation is not allowed, throws a forbidden error.

That means route files can use a simple assert-style API instead of repeating the same error handling pattern.

This is a common and clean backend pattern.

## 6. `getDelegationAuthority(...)`

This method exposes the delegator-facing authority summary:

- `canDelegateTo`
- `delegationStyle`

This is exactly the kind of method UI screens like the agent detail page need.

It turns raw role-definition data into a small authority bundle.

If no role definition exists, it falls back to:

- empty `canDelegateTo`
- collaborative style

Again, you see a graceful fallback pattern.

## 7. `validateDelegationChain(...)`

This function enforces two rules:

- no cycles
- max depth of 3

That means Paperclip does not allow delegation to recurse forever.

This is not just a neat implementation detail.

It is a governance safety rule that protects the system from:

- circular delegation
- overly deep agent command chains

This matters a lot once agents start delegating operationally.

## Technical Thinking

The most important thing to understand about this file is that delegation is modeled as:

- intentional
- constrained
- explainable

The service always tries to return or throw with a reason, not just a silent boolean.

That is exactly what you want for governance code because operators eventually need to understand why something was blocked.

## What This File Does Not Own

This file does not:

- update issue assignees
- create spawned agents
- decide reporting hierarchy

It only answers the delegation-permission question.

That narrow ownership is a strength.

## Self-Check

You understand this file if you can answer:

1. Why is delegation a separate system from hierarchy?
2. Why are spawned agents blocked on both sides of delegation?
3. Why is chain validation part of delegation governance instead of issue update logic?
