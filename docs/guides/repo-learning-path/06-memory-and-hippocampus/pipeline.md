# Memory Storage Pipeline

This guide explains the real end-to-end memory pipeline across Paperclip and Hippocampus.

If you want one sentence first:

Paperclip decides when memory should matter, Hippocampus performs the memory operations, and adapters materialize the resulting context into the runtime.

## The Big Picture

The memory pipeline is not one file.

It is a cross-subsystem flow involving:

- heartbeat orchestration
- memory lifecycle hooks
- bridge abstraction
- runtime manager transport
- Python Hippocampus runtime
- adapter prompt/runtime materialization

So the best way to understand it is as a timeline.

## Phase A: Startup

### 1. Server decides whether memory is enabled

During backend startup, config determines whether Hippocampus mode is:

- `off`
- `embedded`

### 2. The bridge is initialized

[`server/src/services/hippocampus-bridge.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-bridge.ts) installs either:

- a disabled bridge
- or an embedded bridge backed by a runtime manager

### 3. The embedded runtime may be started

If memory is enabled, [`server/src/services/hippocampus-runtime-manager.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-runtime-manager.ts) spawns the Python runtime and waits for a successful health RPC.

### 4. Higher-level memory services are registered

When the bridge is live, Paperclip initializes helper services for:

- scope
- projections
- profile generation
- delegation memory

That finishes the startup side of the memory subsystem.

## Phase B: Before A Run

This is the first moment memory directly affects agent execution.

### 1. Heartbeat prepares a run

Inside [`server/src/services/heartbeat.ts`](/Users/divyansh/Arceus/server/src/services/heartbeat.ts), `executeRun(...)` reaches the point just before adapter execution.

### 2. Heartbeat asks memory-lifecycle for context

It calls [`server/src/services/memory-lifecycle.ts`](/Users/divyansh/Arceus/server/src/services/memory-lifecycle.ts) through `buildMemoryContextForRun(...)`.

### 3. Memory-lifecycle checks bridge health

If memory is off or unhealthy, it returns `null` and the run continues without memory.

This is an important architectural rule:

memory enriches runs, but does not own run survivability.

### 4. Memory-lifecycle fetches memory ingredients

It asks the bridge for:

- priming
- habits
- relevant recall
- delegation context, if the run came through delegation

### 5. Bridge translates calls into runtime RPC

[`server/src/services/hippocampus-bridge.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-bridge.ts) forwards those calls into the runtime manager.

### 6. Runtime manager sends JSON-RPC over stdio

[`server/src/services/hippocampus-runtime-manager.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-runtime-manager.ts) serializes requests, writes them to the Python process, and resolves responses back into promises.

### 7. Memory-lifecycle formats markdown

The results are shaped into a markdown block like:

- priming section
- relevant recall section
- habits section
- delegator context section

### 8. Heartbeat injects that into run context

Heartbeat stores it as `paperclipMemoryContext`.

It also appends it into session handoff markdown so downstream runtime surfaces can see it.

## Phase C: Adapter Materialization

The memory block does not help the agent until it is actually surfaced into the runtime.

### 1. Adapter receives enriched context

When heartbeat calls the adapter, the context already contains the memory markdown.

### 2. Adapter writes runtime-visible instructions

For example, [`server/src/adapters/arceus/execute.ts`](/Users/divyansh/Arceus/server/src/adapters/arceus/execute.ts) writes `paperclipMemoryContext` into `AGENTS.md`.

That is the moment memory becomes something the live agent can actually read.

This is a critical point:

Hippocampus does not run the agent directly.
Paperclip and the adapter convert Hippocampus output into agent-visible execution context.

## Phase D: After A Run

This is the learning side of the pipeline.

### 1. Heartbeat finishes the run

It already knows:

- outcome
- stdout excerpt
- stderr excerpt

### 2. Heartbeat triggers post-run extraction

It calls `extractMemoriesFromRun(...)` from `memory-lifecycle.ts`.

### 3. Memory-lifecycle builds pseudo-messages

Instead of sending raw full logs, it creates a compact pseudo-conversation from:

- stdout excerpt
- stderr excerpt

### 4. Hippocampus extracts facts

The bridge forwards `extract(...)` into Hippocampus.

### 5. Hippocampus may process a trajectory

If the run is tied to an issue and the outcome is meaningful, the lifecycle layer also calls `processTrajectory(...)`.

That gives Hippocampus a task/outcome signal, not just raw extracted facts.

### 6. Failures are swallowed

If post-run learning fails, the run itself is not marked failed retroactively.

Again, memory is best-effort augmentation.

## Phase E: Delegation-Specific Memory Flow

Delegation introduces a second, narrower memory pipeline.

### 1. Delegated work can trigger scoped memory transfer

[`server/src/services/delegation-memory.ts`](/Users/divyansh/Arceus/server/src/services/delegation-memory.ts) recalls relevant memory from the delegator’s employee container.

### 2. It copies that memory into the delegatee’s task container

This is task-scoped transfer, not broad permanent merge.

### 3. Later, learnings can be internalized selectively

If the delegation result quality is high enough, the learnings can be written back into the delegatee’s employee memory.

So delegation memory is:

- transfer now
- internalize later, if deserved

## Phase F: Operator And Maintenance Surface

Separately from live run execution, the memory subsystem is exposed via:

- raw recall/list/remember routes
- scoped recall
- shareable-memory views
- profile generation
- graph exploration
- delegation routes
- GC and promotion routes
- health

This lets operators inspect and maintain the subsystem without needing to trigger live runs.

## Where Data Lives

This is one of the most important distinctions in the whole architecture.

### Paperclip SQL stores control-plane state

Examples:

- companies
- agents
- issues
- heartbeat runs
- runtime state
- workspace state

### Hippocampus stores memory state

Examples:

- memory records
- habits
- priming
- graph relationships
- promotions

### Adapters temporarily materialize memory into runtime-visible forms

Examples:

- `AGENTS.md`
- handoff markdown
- other prompt-adjacent context surfaces

So the memory pipeline crosses systems, but each system still has a clear job.

## Why This Split Exists

Because memory is not the source of truth for the whole product.

Memory augments execution.

Paperclip still owns:

- the workflow
- the scheduling
- the runtime lifecycle
- the permissions
- the product state

Hippocampus gives that workflow a learned context layer.

## Technical Thinking

The most important lesson in this pipeline is that memory is integrated through explicit boundary crossings.

Paperclip does not let memory leak into every layer invisibly.

Instead it chooses specific moments:

- startup
- pre-run enrichment
- post-run learning
- delegation transfer
- operator inspection

That makes the subsystem much easier to reason about.

## Self-Check

You understand the pipeline if you can answer:

1. At what exact point in a run does memory first become execution-relevant?
2. How does Hippocampus output actually reach the live runtime?
3. Why is post-run extraction best-effort?
4. How is delegation memory different from ordinary pre-run recall?
5. Which data still lives in Paperclip even when memory is enabled?
