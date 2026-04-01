# Phase 6: Memory And Hippocampus

This phase explains how Paperclip uses Hippocampus as a memory subsystem.

If you want one sentence first:

Paperclip still owns the company, agent, issue, and execution lifecycle, while Hippocampus is the specialized memory engine that Paperclip starts, talks to, injects before runs, and learns back into after runs.

## Why This Phase Matters

By the time you reach this phase, you already know that Paperclip can:

- queue work
- execute runs
- choose adapters
- manage workspaces
- persist results

Now the system gains a second kind of intelligence:

memory.

But it is very important to understand this the right way.

Hippocampus is not the boss of the system.
It is not replacing the database.
It is not deciding which agent runs next.

Paperclip remains the control plane.

Hippocampus is a subsystem Paperclip uses for:

- recall
- priming
- habits
- fact extraction
- trajectory learning
- graph views
- promotions and garbage collection
- delegation-related memory transfer

## The Boundary You Must Keep Clear

This is the most important idea in phase 6.

### Paperclip owns orchestration

Paperclip still owns:

- companies
- agents
- issues
- heartbeats
- roles
- runtime sessions
- run logs
- workspaces
- execution permissions

### Hippocampus owns memory operations

Hippocampus owns:

- storing memory records
- recalling relevant memories
- extracting facts from run output
- generating priming and habits
- graph search and neighborhood views
- promotions and garbage collection

So the right question is not:

“Is Hippocampus the whole system?”

The right question is:

“At what moments does Paperclip cross into Hippocampus, and why?”

## The Three Main Crossings

There are three especially important moments where Paperclip crosses the boundary.

### 1. Startup

When the server starts, Paperclip may boot the embedded Hippocampus runtime.

That flow is mostly:

- [`server/src/index.ts`](/Users/divyansh/Arceus/server/src/index.ts)
- [`server/src/services/hippocampus-bridge.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-bridge.ts)
- [`server/src/services/hippocampus-runtime-manager.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-runtime-manager.ts)

### 2. Before a run

Just before adapter execution, heartbeat asks memory-lifecycle code to build memory context for the run.

That is how memory influences live execution.

### 3. After a run

After a run finishes, Paperclip tries to extract learnings back into Hippocampus.

That is how experience becomes memory.

## The Core Mental Objects

Keep these six objects distinct in your head.

### 1. Bridge

The bridge is the TypeScript-facing memory interface the server talks to.

It gives the rest of Paperclip one stable API whether memory is:

- off
- or running as an embedded subprocess

### 2. Runtime manager

The runtime manager is the embedded-process controller.

It is the thing that:

- spawns Python
- speaks JSON-RPC over stdio
- tracks pending requests
- restarts after crashes

### 3. Lifecycle hooks

The lifecycle layer is where memory touches heartbeat execution.

It decides:

- what memory to inject before a run
- what to extract after a run

### 4. Scope services

These are higher-level helpers on top of the bridge.

They do things like:

- scoped recall by startup / employee / task containers
- graph projections
- profile generation
- delegation memory transfer

### 5. Routes

The routes expose memory as an operator-facing HTTP surface.

This is mostly for:

- inspection
- debugging
- manual maintenance
- advanced tooling

### 6. Containers

Memory is not treated as one big bucket.

The scope layer distinguishes containers like:

- startup-wide
- employee-specific
- task-specific
- sub-agent-specific

That scoped design is one of the smartest parts of the memory subsystem.

## Read Order

If you want to understand phase 6 deeply without reading raw source first, use this order:

1. [`hippocampus-bridge-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/hippocampus-bridge-ts.md)
2. [`hippocampus-runtime-manager-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/hippocampus-runtime-manager-ts.md)
3. [`memory-lifecycle-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/memory-lifecycle-ts.md)
4. [`delegation-memory-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/delegation-memory-ts.md)
5. [`memory-routes-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/memory-routes-ts.md)
6. [`pipeline.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/06-memory-and-hippocampus/pipeline.md)

Why this order:

- the bridge tells you what the server thinks “memory” is
- the runtime manager tells you how embedded memory actually runs
- the lifecycle file shows where memory touches heartbeat
- the delegation file shows a specialized memory-transfer flow
- the routes show the operator-facing surface
- the pipeline ties the whole thing together

## What Each File Really Owns

[`server/src/services/hippocampus-bridge.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-bridge.ts)

- owns the process-wide bridge abstraction, disabled vs embedded mode behavior, and memory service registration

[`server/src/services/hippocampus-runtime-manager.ts`](/Users/divyansh/Arceus/server/src/services/hippocampus-runtime-manager.ts)

- owns the Python subprocess lifecycle and the JSON-RPC transport

[`server/src/services/memory-lifecycle.ts`](/Users/divyansh/Arceus/server/src/services/memory-lifecycle.ts)

- owns the heartbeat hook points where memory is injected before a run and extracted after a run

[`server/src/services/delegation-memory.ts`](/Users/divyansh/Arceus/server/src/services/delegation-memory.ts)

- owns task-scoped memory transfer and selective delegation learning

[`server/src/routes/memory.ts`](/Users/divyansh/Arceus/server/src/routes/memory.ts)

- owns the operator-facing HTTP surface for memory inspection, projections, delegation flows, and maintenance

## Technical Thinking

The biggest architectural lesson in this phase is that Paperclip does not “sprinkle memory everywhere.”

It keeps memory behind deliberate layers:

- contract
- bridge
- runtime manager
- lifecycle hooks
- higher-level helper services
- routes

That layering is what stops memory from becoming a fuzzy magical subsystem.

It stays explicit.

## Self-Check

You understand phase 6 if you can answer:

1. What is the difference between the Hippocampus bridge and the Hippocampus runtime manager?
2. Where does memory actually affect a live run?
3. Why are many memory features exposed mainly through board/operator routes?
4. Why are containers important to the design?
5. What does Paperclip still own even when Hippocampus is enabled?
