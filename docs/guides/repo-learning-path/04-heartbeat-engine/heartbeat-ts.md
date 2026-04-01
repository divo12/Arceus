# `server/src/services/heartbeat.ts`

This guide explains [`server/src/services/heartbeat.ts`](/Users/divyansh/Arceus/server/src/services/heartbeat.ts) as the runtime orchestrator of the whole system.

If you want one sentence first:

`heartbeat.ts` is the file that turns a wake request into a real agent run, manages execution context and session continuity, invokes the adapter, records everything that happened, and recovers when reality goes wrong.

## Mental Model

This is not “just another service.”

This is the execution engine.

If the rest of the backend says:

- agents exist
- issues exist
- projects exist
- permissions exist

then `heartbeat.ts` says:

- now take all that information and make the agent actually work

That is why this is one of the most important files in the entire repo.

## The Two Core Concepts

Before anything else, separate these two ideas:

### Wakeup request

A wakeup request means:

“something happened, and this agent should probably run.”

Examples:

- manual wake
- issue assignment
- timer tick
- automation trigger

### Heartbeat run

A heartbeat run means:

“this is a concrete execution attempt with its own lifecycle, status, logs, usage, result, and persistence.”

If you confuse those two, the whole file gets blurry.

## What This File Owns

This file owns:

- enqueueing wakeups
- claiming queued runs safely
- run execution flow
- runtime session continuity
- context assembly for adapters
- workspace resolution
- invocation of adapters
- run result persistence
- run event/log writing
- status transitions and cleanup
- recovery of orphaned work

That is a very large responsibility surface, which is why the file is large.

## How To Read This File

Do not read 3900 lines as one uninterrupted story.

Read it in these layers:

1. constants and helpers
2. “what context do I need?”
3. “how do I enqueue?”
4. “how do I claim?”
5. “how do I execute?”
6. “how do I recover?”

That is the natural execution order.

## 1. Constants: Runtime Guardrails

The constants at the top tell you what kinds of problems the file worries about:

- max live log chunk size
- max concurrent runs
- deferred wake context keys
- detached process errors
- per-agent start locks
- repo-only sentinel paths
- git clone timeout
- sessioned local adapters

Even before you read the functions, these constants reveal the problem space:

- concurrency
- execution limits
- logs
- process failures
- repo/workspace safety
- session continuity

## 2. Context Helpers: Build The Agent’s World

Functions like:

- `resolveOrgPosition(...)`
- `computeDelegationDepth(...)`
- `resolveDelegationRunContext(...)`

exist because the agent runtime needs more than raw rows.

It needs a world model:

- who do I report to?
- what is my delegation depth?
- did another agent delegate this work to me?
- what delegation style should shape behavior?

This is a good example of Paperclip being an organizational runtime, not just a job queue.

## 3. Session Helpers: Continuity Across Runs

Functions like:

- `getRuntimeState(...)`
- `getTaskSession(...)`
- `resolveSessionBeforeForWakeup(...)`
- `resolveNextSessionState(...)`
- `evaluateSessionCompaction(...)`

show a very important design choice:

Paperclip does not treat every run as a totally isolated one-shot.

It tracks continuity:

- per agent
- sometimes per task key
- sometimes across session rotation decisions

### Why this matters

An agent doing real work often needs memory continuity:

- previous session id
- session display id
- task-scoped continuity
- handoff when a session becomes too large or old

So heartbeat owns not just “execute now,” but also “continue sanely from before.”

## 4. Workspace Resolution: Where Should The Agent Run?

`resolveWorkspaceForRun(...)` is where heartbeat begins connecting issue/project context to execution workspace reality.

It looks at context like:

- issue id
- project id
- project workspace id
- prior session/workspace signals

Then it helps determine:

- shared project workspace
- isolated worktree
- adapter-default runtime behavior

This is a bridge between:

- product context
- execution environment

## 5. `heartbeatService(db)`: Runtime API Factory

The main export creates the heartbeat service using the DB and many collaborators:

- secrets service
- issue service
- workspace services
- role definition service
- spawn governance
- budget service
- run log store

This is the orchestration root of the runtime layer.

It is basically saying:

“to execute an agent well, I need many other subsystems.”

That is why heartbeat is more of a conductor than a single-purpose utility.

## 6. `enqueueWakeup(...)`: Decide Whether Work Should Enter The Queue

This is one of the most important functions in the file.

Its job is not to run the agent immediately.

Its job is to decide whether a wake should become a queued run.

### What it generally does

- enrich wake context
- validate the agent can be invoked
- enforce budget-related blocking
- respect heartbeat policy and cooldown
- coalesce or defer duplicate task-scope work when appropriate
- insert `agentWakeupRequests`
- insert a queued `heartbeatRuns` row
- promote execution if possible

### Why this separation is good

If waking and executing were the same thing, the system would be much harder to control and recover.

Separating them gives:

- a durable record of intent
- safer concurrency
- easier retries/recovery

Beginner translation:

`enqueueWakeup(...)` is the “should this work ticket be placed onto the work queue?” function.

## 7. Claiming Runs: Only One Worker Should Start A Given Run

Heartbeat is very careful about claiming queued runs.

Why?

Because a runtime control plane lives in the real world:

- the server can restart
- multiple ticks can happen
- duplicated wake signals can arrive

So the file contains claim and lock logic to ensure:

- one run is safely promoted from queued to running
- per-agent concurrency rules are respected

This is one of the deepest reasons the file exists. It protects execution correctness under messy conditions.

## 8. `executeRun(runId)`: The Heart Of The Machine

If you learn one function in this file, learn this one.

At a high level, `executeRun(...)` does this:

1. load and claim the queued run
2. load agent, issue, runtime, and session context
3. resolve project/workspace settings
4. decide adapter configuration and execution environment
5. realize execution workspace
6. ensure required runtime services exist
7. invoke the adapter
8. capture logs, usage, and result
9. persist next runtime/session state
10. finalize run status and trigger cleanup/recovery steps

That is the backbone of real execution in Paperclip.

### The deeper meaning of `executeRun(...)`

It is not merely “call adapter.execute()”.

It is “build a careful execution envelope around adapter.execute().”

That envelope includes:

- auth token / secrets
- context for issue/project/meeting/handoff/memory
- workspace mode
- runtime services
- persistence hooks
- event logging

So the adapter is only one piece of the runtime story.

## 9. Result Persistence: The Run Must Become History

After adapter execution, heartbeat records things like:

- final run status
- result summary
- usage/tokens
- error information
- session ids before/after
- run events
- logs
- possibly cost data

This matters because the system is not just trying to execute.

It is trying to remember what happened in a way that operators and later runs can use.

That is why Paperclip feels like a control plane instead of a thin wrapper.

## 10. Finalization And Recovery

This file also owns messy reality handling:

- `finalizeAgentStatus(...)`
- `reapOrphanedRuns(...)`
- queued work resumption
- cleanup on stale or missing in-memory execution state

Why does this matter?

Because production systems fail in ways demos do not:

- process crashes
- restart in the middle of work
- running flag persists even though the process is dead

Heartbeat contains recovery logic so the system can become truthful again.

## 11. What Makes This File Hard

The file is hard because it sits at the center of several cross-cutting concerns:

- org/delegation semantics
- session continuity
- workspace strategy
- adapter invocation
- budgets
- persistence
- recovery

That is why you should not judge it like a normal small service file.

It is closer to an orchestrator or scheduler core.

## The Best Way To Mentally Compress This File

If the file feels too large, reduce it to this sentence:

“Heartbeat decides when work becomes a run, prepares the full execution envelope, invokes the adapter, then writes reality back into durable state.”

That sentence is the heart of the file.

## Self-Check

You understand this file if you can answer:

1. Why are wakeup requests and heartbeat runs stored separately?
2. Why does `executeRun(...)` need to know about sessions and workspace policy before invoking the adapter?
3. Why is orphan reaping part of the same file as run execution?
