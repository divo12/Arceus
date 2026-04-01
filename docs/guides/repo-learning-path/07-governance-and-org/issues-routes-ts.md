# `server/src/routes/issues.ts`

This guide explains [`server/src/routes/issues.ts`](/Users/divyansh/Arceus/server/src/routes/issues.ts) for Phase 7 as the place where governance rules hit everyday work.

If you want one sentence first:

`routes/issues.ts` is not only an issue CRUD file; it is where company access, board-vs-agent assignment rules, delegation enforcement, checkout ownership, and wakeup side effects turn governance policy into operational behavior.

## Mental Model

Earlier governance files define rules in the abstract:

- this role can delegate to that role
- this role can spawn these helper types
- this hierarchy proposal can become active

This file is where those abstractions start affecting real work items.

That makes it one of the most important “translation files” in the repo:

- governance becomes issue assignment
- governance becomes checkout ownership
- governance becomes wakeup side effects

## How To Read This File For Phase 7

Do not read every endpoint.

This file is huge.

For governance learning, focus on these clusters:

1. assignment permission helpers
2. checkout ownership helpers
3. create/update issue flows where assignees change
4. delegation event recording
5. wakeup side effects triggered by assignment and checkout

That is where the governance story lives.

## 1. `assertBoardCanAssignTasks(...)`

This helper handles board-side assignment authority.

Important idea:

being “board” is not the end of the story.

The code still checks:

- company access
- whether the actor is local implicit / instance admin
- otherwise whether the board user has `tasks:assign`

This shows that human operators also live under permissions, not just agents.

## 2. `assertAgentCanAssignIssue(...)`

This helper is one of the most important governance bridges in the file.

For agents, assignment is not treated as a generic update.

The code says:

- if assigning to another agent, run delegation guard
- if returning an issue to its human creator in the allowed case, permit that path
- otherwise block agent attempts to assign to users or clear assignment freely

That is a strong governance statement:

agents may delegate to employee agents within the policy,
but they do not get arbitrary assignment power.

## 3. `assertCanAssignIssue(...)`

This helper is the combined gate:

- board actors go through board assignment checks
- agent actors go through delegation-aware agent checks
- everyone else is unauthorized

This is a great example of route-layer orchestration:

- one user-facing operation
- different policy depending on actor type

## 4. Checkout Ownership Helpers

Functions like:

- `requireAgentRunId(...)`
- `assertAgentRunCheckoutOwnership(...)`

show that issue control is not only about assignment.

It is also about execution ownership.

If an agent is actively working an in-progress issue, the route layer may require the agent run id and assert checkout ownership.

This prevents sloppy overlap where multiple runtime executions or actors step on each other without coordination.

That is governance meeting runtime execution.

## 5. Issue Creation With Assignment

In the create route, if an assignee is provided, the route first calls `assertCanAssignIssue(...)`.

That means assignment rules are enforced at creation time, not only during updates.

Then, if an agent created the issue and delegated it to another agent:

- the route fetches delegation authority
- records a delegation event
- queues a wakeup for the assignee

This is a very important product flow:

governance decision
-> issue created
-> delegation event recorded
-> runtime wakeup queued

That is exactly how organizational rules turn into execution.

## 6. Issue Update With Assignee Changes

The update route is even richer.

It handles:

- whether assignee will change
- whether an agent is returning the issue to its human creator
- whether checkout ownership must be respected
- whether a delegation event should be recorded
- whether wakeups should be queued for new assignees or mentioned agents

This is one of the clearest examples in the whole repo of policy and runtime living together.

The route is not just patching fields.

It is deciding:

- is this assignment legal?
- who needs to be woken?
- should this count as a delegation event?

## 7. Wakeups Are Part Of Governance In Practice

A crucial thing to notice in this file:

assignment changes often trigger wakeups.

Examples:

- on create, assigned agent can be woken
- on update, a new assignee can be woken
- moving from backlog can wake assignee
- checkout can wake assignee
- comment mentions can wake mentioned agents

This means governance is not only “who may assign.”

It also shapes:

- whose runtime starts working next

That is a deep and very Paperclip-specific idea.

## 8. `recordDelegationEvent(...)`

When an agent delegates to another agent through issue creation or update, the route records a delegation event.

That is important for two reasons:

1. the system treats delegation as a first-class event, not an invisible side effect
2. delegation style from governance data travels into operational history

That gives the system a memory of command flow, not just end state.

## 9. Checkout Route

`POST /issues/:id/checkout`

For governance learning, this route matters because it combines:

- assignee identity checks
- agent self-checkout restrictions
- required run id for agents
- checkout ownership logic
- optional wakeup side effect

This shows how issue control is tightly connected to live execution, not just planning state.

## 10. The Big Lesson Of This File

The deepest lesson in this file is:

governance is not isolated in special governance screens.

It shows up in daily issue operations:

- create
- assign
- update
- checkout
- comment

That is why this file belongs in Phase 7 even though it is not named after roles or hierarchy.

It is where the company model becomes operational reality.

## What This File Does Not Own

This file does not define delegation policy itself.

It does not define spawn budget.

It does not define hierarchy snapshots.

Instead, it consumes those rules and enforces them during issue operations.

That distinction is very important.

## Self-Check

You understand this file if you can answer:

1. Why is issue assignment not treated as a raw field update?
2. How do board and agent assignment permissions differ?
3. Why do delegation events and wakeups belong in the issue route flow?
