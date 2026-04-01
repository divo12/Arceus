# `packages/db/src/schema/heartbeat_runs.ts`

This guide explains [`packages/db/src/schema/heartbeat_runs.ts`](/Users/divyansh/Arceus/packages/db/src/schema/heartbeat_runs.ts) as the durable execution ledger of the system.

If you want one sentence first:

the `heartbeat_runs` table stores what happened when an agent was invoked, including status, diagnostics, session continuity, logs, retry lineage, and runtime context.

## 1. Why This Table Is Core

Paperclip is a control plane for autonomous agent work.

That means execution history is not a side detail.

It is one of the core things the system must remember durably.

The `heartbeat_runs` table is where one run becomes a durable record after the live process moves on.

It is the base table behind:

- run history UI
- debugging
- observability
- cancellation/retry flows
- session continuity tracking
- usage and cost attribution

## 2. How To Read The Table

Read it in these groups:

1. identity and scope
2. invocation and lifecycle
3. wakeup/process outcome fields
4. usage/result payloads
5. session continuity fields
6. log/diagnostic fields
7. retry lineage and context snapshot
8. indexes

That grouping reflects the actual responsibilities of the table.

## 3. Identity and scope

The basic fields are:

- `id`
- `companyId`
- `agentId`

That says every run belongs to:

- one company
- one agent

This is important because execution history is not global ambient state.

It is still company-scoped operational data.

## 4. Invocation and lifecycle

Then you see:

- `invocationSource`
- `triggerDetail`
- `status`
- `startedAt`
- `finishedAt`
- `error`

This is the first layer of the run story:

- why did the run happen?
- what kind of trigger caused it?
- where in the lifecycle did it end up?
- was there a coarse error?

This is the “high-level run summary” part of the schema.

## 5. Wakeup and process-outcome fields

Then:

- `wakeupRequestId`
- `exitCode`
- `signal`

These bridge the run record to the lower-level execution mechanics.

### `wakeupRequestId`

This links the durable run back to the request that caused it to be enqueued or invoked.

That matters for tracing cause-and-effect across the orchestration system.

### `exitCode` and `signal`

These are process-level diagnostics.

They tell you the schema is not only about product-friendly success/failure.

It also remembers OS/process-level execution outcomes when relevant.

## 6. Usage and result payloads

This cluster includes:

- `usageJson`
- `resultJson`

These JSON fields are extremely important because execution results are too variable to flatten into a small fixed column set.

### `usageJson`

This is where token and usage-related data can be stored durably.

### `resultJson`

This can store structured execution result payloads that the UI or services may later inspect.

These fields are a good example of the schema balancing:

- structured durability
- flexible runtime output shapes

## 7. Session continuity fields

Then:

- `sessionIdBefore`
- `sessionIdAfter`

This is one of the most Paperclip-specific parts of the table.

The system cares not only that a run happened, but also how it relates to longer-lived execution session continuity.

That supports:

- resumable/adaptive agent flows
- session-aware debugging
- “what changed across this run?” reasoning

## 8. Log and diagnostic fields

This table stores a lot of log-related metadata:

- `logStore`
- `logRef`
- `logBytes`
- `logSha256`
- `logCompressed`
- `stdoutExcerpt`
- `stderrExcerpt`
- `errorCode`
- `externalRunId`
- `processPid`
- `processStartedAt`

This cluster is the clearest proof that `heartbeat_runs` is an observability table, not just a job-status table.

### Why both excerpts and full log references?

Because the system wants:

- lightweight immediately visible summaries
- plus a pointer to deeper persisted logs

That is a useful design tradeoff.

You do not always want to load entire logs just to show run history in the UI.

### `logSha256`

This is also a strong integrity signal.

The schema cares about durable log identity, not just content presence.

## 9. Retry lineage and recovery fields

Then:

- `retryOfRunId`
- `processLossRetryCount`

This part is about recovery and lineage.

It lets the system say:

- this run is a retry of another run
- this run already experienced some number of process-loss retry attempts

That matters for both:

- debugging unstable adapters/processes
- understanding execution ancestry in the UI and backend

## 10. `contextSnapshot`

This JSON field is one of the most interesting ones conceptually.

It means the system wants to remember some view of the execution context that surrounded the run.

That is useful for:

- debugging surprising behavior later
- understanding what information the agent likely had
- supporting more explainable post-run analysis

This is another sign that the table is about more than pass/fail bookkeeping.

## 11. The Index Tells You The Main Query Shape

The key index is:

- company + agent + startedAt

That tells you the main expected run history lookup is:

"show runs for this agent in this company, ordered by time."

That matches how humans usually inspect agent execution history.

## 12. Relationship To Neighboring Tables

`heartbeat_runs` is not the entire execution story by itself.

Neighboring tables like `heartbeat_run_events` and runtime-state/session tables handle more detailed or adjacent execution concerns.

So think of `heartbeat_runs` as:

- the durable run ledger

not:

- the full event stream
- the full live runtime state

That division is healthy.

It keeps the main run record readable while still supporting richer runtime subsystems around it.

## 13. Relationship To Shared Types

The shared `HeartbeatRun` type maps closely to this table, but the architectural role is still different:

- schema = durable storage contract
- shared type = cross-layer object contract

The shared type is what UI and server talk about.

The table is what Postgres stores.

Usually they are close, but the distinction still matters when redesigning the run model.

## 14. What To Remember

- `heartbeat_runs` is the durable ledger of agent execution
- it stores not only status, but also diagnostics, logs, session continuity, and retry lineage
- it is central to observability and recovery, not just user-facing history
- neighboring runtime tables still matter because this table is the ledger, not the whole runtime state machine

## Self-Check

- Which fields exist primarily for observability versus process recovery versus user-facing run history?
- Why are session IDs and retry lineage part of the durable run record?
- Why is `heartbeat_runs` a ledger table rather than the entire execution subsystem by itself?
