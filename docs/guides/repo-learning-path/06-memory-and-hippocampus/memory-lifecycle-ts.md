# `server/src/services/memory-lifecycle.ts`

This guide explains [`server/src/services/memory-lifecycle.ts`](/Users/divyansh/Arceus/server/src/services/memory-lifecycle.ts).

This is the file that answers the most practical memory question in the whole repo:

“When does memory actually touch a live heartbeat run?”

## Mental Model

This file is the heartbeat hook layer for memory.

It does not manage the Python process.
It does not define routes.
It does not own memory containers.

Its job is narrower and more important:

- before a run, assemble memory context that can help the agent
- after a run, try to learn from what happened
- around delegation, record relationship events

This is the point where memory stops being “stored data” and starts affecting execution behavior.

## What This File Owns

It owns three major behaviors.

### 1. Pre-run context injection

Build a markdown block from memory that can be attached to run context.

### 2. Post-run extraction and trajectory learning

Turn run output into extractable signals and send them into Hippocampus.

### 3. Delegation event recording

Write lightweight memory traces for delegation relationships and handoffs.

## The Bridge Is Treated As Optional

A very important design choice in this file is graceful degradation.

It never acts like memory is guaranteed to be available.

The helper `isBridgeAvailable(...)` does a `health()` call and, on failure, logs a warning and returns `false`.

That means memory is treated as:

- important
- but not allowed to break core execution

This is exactly the right philosophy for a subsystem like memory.

## `buildMemoryContextForRun(...)`

This is the most important function in the file.

It is called before adapter execution.

### What it receives

It receives:

- `agentId`
- `issueTitle`
- `issueId`
- `wakeReason`
- optional `delegationStyle`
- optional `delegatorAgentId`

These values become the seed for what memory should be recalled.

### Step 1: get the current bridge

It calls `getHippocampusBridge()`.

If mode is `off`, it returns `null` immediately.

### Step 2: check health

Even if mode is not off, it still calls `health()` through `isBridgeAvailable(...)`.

So enabled does not automatically mean usable.

### Step 3: derive recall/habit limits from delegation style

This is a subtle and very interesting product behavior.

The function changes memory retrieval breadth depending on delegation style.

For example:

- `directive` gets more recall
- `autonomous` gets less
- collaborative sits in the middle

That means memory injection is not one-size-fits-all.

The system assumes leadership style should change how much context gets pushed into the run.

### Step 4: build the recall query

The query is built from:

- issue title
- wake reason
- issue id

joined with separators.

This tells you something important:

pre-run memory retrieval is not based on some huge semantic planner here.
It is based on a compact task/wake context string.

### Step 5: fetch multiple memory sources in parallel

The function asks for:

- priming
- habits
- recalled memories
- delegation context, if applicable

Each call is individually guarded with `catch(...)` so one failing memory feature does not take down the whole memory block.

That is a strong resilience pattern.

### Step 6: format sections into markdown

The function turns the results into sections like:

- `## Agent Memory — Priming`
- `## Agent Memory — Relevant Recall`
- `## Agent Memory — Habits`
- `## Delegator Context`

This is extremely important.

The function does not return a structured JSON object for the adapter to interpret.

It returns markdown.

That tells you what this layer is for:

human-readable prompt enrichment.

Paperclip is using Hippocampus to make the agent’s execution context better, not to replace the adapter with a memory-native runtime.

### Why markdown instead of a raw object?

Because the downstream consumer is the execution prompt context.

Adapters like Arceus can place this directly into:

- `AGENTS.md`
- handoff markdown
- injected run context

So the format is intentionally optimized for prompt consumption.

## `extractMemoriesFromRun(...)`

This is the post-run learning hook.

It is called after a heartbeat run has already completed.

### What it receives

It receives:

- agent id
- run id
- issue id
- issue title
- outcome
- stdout excerpt
- stderr excerpt

### Step 1: bridge mode and health checks

Just like pre-run injection, post-run extraction is skipped entirely if:

- memory is off
- or bridge health is unavailable

### Step 2: build pseudo-messages from run excerpts

This is a very important detail.

The function does not send the whole run log into Hippocampus.

It builds a small pseudo-conversation from:

- stdout excerpt as `assistant`
- stderr excerpt as `system`

So the extraction input is intentionally a compact approximation of the run’s visible outcome.

### Step 3: skip weak content

If the extracted messages are too short or effectively empty, the function returns.

This avoids generating memory from noise.

### Step 4: call `extract(...)`

Now Hippocampus is asked to extract facts from those pseudo-messages.

Failures are logged and swallowed.

### Step 5: optionally call `processTrajectory(...)`

If the run is tied to an issue and the outcome is `succeeded` or `failed`, the function also sends a simplified trajectory.

That trajectory includes:

- action: issue title or fallback label
- result: run outcome
- reasoning: a short summary based on extract result

The current quality heuristic is simple:

- `0.8` for success
- `0.2` for failure

That means this file is not trying to solve all learning quality judgment itself.
It is providing a lightweight signal.

### Step 6: log completion

If extraction succeeded, it logs what was added or updated.

This gives operators at least some visibility into post-run learning activity.

## Best-Effort Is A Design Choice, Not A Shortcut

This file consistently treats memory as best-effort.

That is not because memory is unimportant.

It is because the system has a higher priority:

never let memory failures destroy core execution.

In other words:

- memory may enrich a run
- memory may learn from a run
- but memory does not own run success

That is a healthy architecture rule.

## `recordDelegationEvent(...)`

This function is narrower than full pre-run or post-run memory handling.

It records simple delegation relationship events for:

- the delegator
- the delegatee

### What it writes

It constructs lightweight system messages like:

- delegated task to X
- received delegated task from Y

and sends them through `extract(...)`.

### Why this matters

Not every useful memory event needs full run extraction.

Sometimes the memory system should simply remember:

- who delegated to whom
- what task was handed off
- what style was used
- which issue it related to

This function captures exactly that smaller relationship memory.

## Technical Thinking

The deep architectural lesson in this file is that memory is integrated at lifecycle boundaries, not sprayed everywhere.

Paperclip chooses three deliberate moments:

1. before the run, enrich context
2. after the run, learn from output
3. during delegation, record relationship signals

That makes the memory system easier to reason about and easier to debug.

## Self-Check

You understand this file if you can answer:

1. Why does pre-run memory return markdown instead of a structured machine object?
2. Why are all memory operations here guarded as best-effort?
3. How does delegation style change pre-run memory behavior?
4. Why does post-run extraction use excerpts instead of the full raw run log?
5. What is the difference between `extractMemoriesFromRun(...)` and `recordDelegationEvent(...)`?
