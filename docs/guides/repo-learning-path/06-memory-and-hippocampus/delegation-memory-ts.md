# `server/src/services/delegation-memory.ts`

This guide explains [`server/src/services/delegation-memory.ts`](/Users/divyansh/Arceus/server/src/services/delegation-memory.ts).

This file is easy to misunderstand if you only look at its name.

It is not “all delegation logic.”
It is not “all memory logic.”

It is a very specific memory-transfer layer for delegated work.

## Mental Model

This file answers a specialized question:

“When one agent hands work to another, how should task-relevant memory move with that handoff?”

That is narrower than general recall.

It is also narrower than the lifecycle hooks in `memory-lifecycle.ts`.

This file is specifically about:

- copying useful memory into the delegatee’s task scope
- selectively internalizing learnings afterward

## What This File Owns

It owns two concrete flows.

### 1. `prepareDelegationContext(...)`

Despite the name, this function does not mainly build markdown context.

Its real job is to copy relevant memory from the delegator’s memory scope into the delegatee’s task scope.

### 2. `internalizeDelegationResult(...)`

This function decides whether post-delegation learnings deserve to become longer-lived memory.

## Why This File Exists Separately

Because delegation memory is a distinct product problem.

Normal recall asks:

“What should this one agent remember right now?”

Delegation memory asks:

“What should travel from one agent’s memory world into another agent’s task world?”

That is a different concern, so it gets its own file.

## The Container Model Matters A Lot Here

This file uses `MemoryContainers` from `memory-scope.ts`.

That means it thinks in terms of scoped memory buckets like:

- startup-wide
- employee-specific
- task-specific

This is the most important design idea in the file.

Memory does not live in one flat space.

Delegation moves memory from:

- one agent’s employee container

into:

- another agent’s task container

That is much safer and more useful than dumping everything into one global bucket.

## `prepareDelegationContext(...)`

This is the main transfer method.

### What it receives

It receives:

- delegator agent id
- delegatee agent id
- startup id
- task id
- task description
- topK

### Step 1: choose the source container

It builds the source as:

`startup:{startupId}:emp:{fromAgentId}`

So the source is the delegator’s employee-scoped memory within the startup.

### Step 2: recall relevant memories

It asks the bridge to `recall(...)` from that employee container using the task description as the query.

This means transfer is relevance-based, not full-copy.

That is a very good design choice because the delegator may have lots of memory that should not all spill into the delegatee’s task.

### Step 3: choose the target container

It builds the target as:

`startup:{startupId}:task:{taskId}`

So the destination is the task container, not the delegatee’s broad employee memory.

This is crucial.

The system is saying:

“These copied memories are for this task.”

not:

“Permanently merge them into the delegatee’s whole mind.”

### Step 4: copy each recalled memory

For each recalled item, it calls `remember(...)` on the delegatee with:

- content prefixed with `[delegated:{fromAgentId}]`
- target container = task container
- memory type = `dynamic`

That prefix is a small but useful provenance marker.

It helps the system remember where that copied memory came from.

### Step 5: collect partial success

The function uses `Promise.allSettled(...)` so it can survive partial failures.

Then it returns:

- `copiedCount`
- `failedCount`
- copied memory list

That means delegation memory transfer is not all-or-nothing.

This is a practical design because memory systems often benefit from partial progress instead of hard failure.

## Important Reality Check

Even though the method name says `prepareDelegationContext`, the returned value is not a prompt block.

It is a structured summary of copied memory records.

That is a useful thing to notice because the real behavior is:

- recall
- copy
- report results

not:

- format final prompt text for the delegatee

## `internalizeDelegationResult(...)`

This method handles the other direction:

“Should learnings from delegated work become longer-lived memory?”

### Step 1: quality gate

If quality is below `0.6`, nothing is internalized.

That is a very healthy rule.

It prevents the memory system from promoting weak or noisy outcomes too easily.

### Step 2: choose the target container

It internalizes into the agent’s employee container:

`startup:{startupId}:emp:{agentId}`

This is the long-lived agent-specific scope, not the temporary task scope.

### Step 3: choose memory type by quality

If quality is:

- `>= 0.9` -> `static`
- otherwise -> `dynamic`

This is one of the smartest parts of the file.

The code is saying:

- very strong learnings may deserve stable memory
- decent but not exceptional learnings should remain more flexible

### Step 4: remember all learnings best-effort

It attempts to remember each learning and counts successes.

The return value is just:

- how many were internalized

That keeps the method focused on curation, not presentation.

## Why This File Matters

This file captures a very specific Paperclip idea:

delegation is not only task reassignment.
It is also knowledge transfer.

That means a handoff is richer than:

- “you do this now”

It can also mean:

- “here are the relevant memories for this task”
- “and here is what should become lasting memory after the delegation succeeds”

## Technical Thinking

The deepest design idea here is scope discipline.

The file clearly separates:

- employee memory as longer-lived agent memory
- task memory as temporary task-specific working context

That separation prevents one of the worst memory-system failure modes:

accidentally polluting broad memory with short-lived task context.

## Self-Check

You understand this file if you can answer:

1. Why does delegated memory move into a task container instead of directly into the delegatee’s employee container?
2. Why is transfer based on recall relevance instead of copying all memory?
3. What is the purpose of the `[delegated:agentId]` prefix?
4. Why is there a quality gate before internalizing learnings?
5. Why can very high-quality learnings become `static` while others stay `dynamic`?
