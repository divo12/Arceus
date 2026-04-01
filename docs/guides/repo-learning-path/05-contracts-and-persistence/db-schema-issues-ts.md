# `packages/db/src/schema/issues.ts`

This guide explains [`packages/db/src/schema/issues.ts`](/Users/divyansh/Arceus/packages/db/src/schema/issues.ts) as one of the richest persistence tables in the repo.

If you want one sentence first:

the `issues` table stores not only task/planning data, but also assignment, execution locking, workspace preference, and routine/execution provenance.

## 1. Why This Table Is So Important

In many systems, an issue or task table is mostly:

- title
- description
- assignee
- status

That is not enough here.

In Paperclip, issues are both:

- planning/coordination units
- execution units for agents

That product decision is visible all over this schema.

## 2. How To Read The Table

Read the table in six groups:

1. company/project/goal ancestry
2. task identity and lifecycle
3. assignee and execution-lock fields
4. provenance/origin fields
5. workspace/execution preference fields
6. indexes and uniqueness rules

That reading order makes the file much easier to understand.

## 3. Company/project/goal ancestry

The first group includes:

- `companyId`
- `projectId`
- `projectWorkspaceId`
- `goalId`
- `parentId`

This cluster tells you issues do not float freely.

They can be connected into:

- company scope
- project scope
- goal scope
- issue parent/child trees

That matches the spec’s idea that work should trace upward into larger company context.

### `parentId`

This is one of the most important fields conceptually.

It means issues can be broken down into sub-issues.

So an issue is not only a leaf task. It can also be a coordination parent.

## 4. Task identity and lifecycle

Then you get:

- `title`
- `description`
- `status`
- `priority`
- `issueNumber`
- `identifier`
- timestamps like `startedAt`, `completedAt`, `cancelledAt`, `hiddenAt`

These are the familiar work-management fields.

But notice that even the “normal” task fields are still company-scoped and integrated with execution state elsewhere in the same table.

### `issueNumber` and `identifier`

These are worth noticing because they support a more human-friendly issue identity layer on top of UUIDs.

The unique index on `identifier` tells you that this human-facing identity matters operationally too.

## 5. Assignment and execution-lock fields

This is where the schema becomes distinctly Paperclip-like:

- `assigneeAgentId`
- `assigneeUserId`
- `checkoutRunId`
- `executionRunId`
- `executionAgentNameKey`
- `executionLockedAt`

This cluster says:

an issue is not only “owned” by someone.

It can also be actively locked into execution flow.

### `checkoutRunId`

This suggests a durable link to the run that claimed/checks out work.

### `executionRunId`

This suggests a durable link to the run actively executing the issue.

### `executionLockedAt`

This is a strong clue that the system cares about explicit execution ownership and coordination, not just optimistic assignment.

That lines up with the product invariant around atomic checkout semantics.

## 6. Provenance/origin fields

Then:

- `createdByAgentId`
- `createdByUserId`
- `originKind`
- `originId`
- `originRunId`
- `requestDepth`
- `billingCode`

This cluster tells you the system cares about:

- who created work
- whether work was human/manual or routine-generated
- how deeply delegated/requested work has traveled
- how costs or billing should be attributed

### `originKind`

Because this defaults to `"manual"` and pairs with `originId`, the schema can tell the difference between:

- board-created work
- routine-execution-generated work

That is more than audit metadata.

It affects coordination and uniqueness behavior later.

## 7. Workspace and execution preference fields

This cluster is one of the strongest signs that issues are execution units:

- `assigneeAdapterOverrides`
- `executionWorkspaceId`
- `executionWorkspacePreference`
- `executionWorkspaceSettings`

This means an issue can carry its own execution-context decisions instead of relying only on project or agent defaults.

That is powerful, but it also makes the schema richer than a normal ticketing model.

It explains why issue routes and services are more involved than simple CRUD.

## 8. Hidden versus terminal

One subtle field here is:

- `hiddenAt`

This is different from completion/cancellation.

It suggests the system distinguishes:

- work lifecycle state
- visibility/active-open-ness state

That becomes especially important in the partial unique index later.

## 9. Indexes Reveal Expected Query Patterns

The table defines indexes for:

- company + status
- company + assignee + status
- company + assignee user + status
- company + parent
- company + project
- company + origin kind + origin ID
- company + project workspace
- company + execution workspace

These query shapes tell you how the backend expects issues to be used:

- list by company and workflow state
- list by assignee
- traverse sub-issue trees
- filter by project
- connect issues to routine or origin flows
- connect issues to workspace policy

## 10. The Most Interesting Index: Open Routine Execution Uniqueness

This part is especially important:

```ts
uniqueIndex("issues_open_routine_execution_uq")
  .on(table.companyId, table.originKind, table.originId)
  .where(...)
```

This is a partial unique index for open routine execution issues.

### What it means conceptually

For routine-execution-origin issues that are still open/active and still tied to an execution run, the system wants uniqueness.

That is a persistence-level guardrail against duplicate live/open routine execution work.

This is a great example of the database itself enforcing a meaningful product invariant.

## 11. Relationship To Shared Types

The shared `Issue` type is richer than this table alone:

- ancestors
- labels
- plan/document summaries
- related project/goal objects
- current execution workspace
- work products

That tells you the table is the durable core, while the shared type is the richer domain projection.

That distinction is extremely important when doing schema or API redesign.

## 12. What To Remember

- issues are both planning units and execution units
- execution-lock and workspace fields are first-class, not bolt-ons
- provenance and request-depth fields make delegation/routine behavior visible in storage
- the partial unique index encodes a real product invariant about routine-execution issues

## Self-Check

- Which fields exist only because issues can be actively executed, not just planned?
- Why does this table need both lifecycle timestamps and visibility/open-ness logic like `hiddenAt`?
- What does the partial unique index tell you about routine-generated issue behavior?
