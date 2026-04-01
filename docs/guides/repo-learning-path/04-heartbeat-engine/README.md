# Phase 4: Heartbeat Engine

This phase is where Paperclip stops feeling like a normal web app and starts feeling like a runtime control plane.

If Phase 3 taught:

- how the UI reaches the backend

Phase 4 teaches:

- how the backend turns “an agent should do work” into a real execution attempt

## The Core Mental Model

Read this phase as one pipeline:

`wake request -> queued run -> claimed run -> execution context -> workspace/runtime preparation -> adapter execution -> result persistence -> cleanup/recovery`

If you keep that shape in mind, the large runtime files stay understandable.

If you do not, they feel like random helpers.

## What The Heartbeat Layer Is Trying To Do

At a high level, the heartbeat layer answers:

- should this agent run now?
- what exact work context should it receive?
- what workspace should it use?
- what runtime services should exist around it?
- which adapter should execute it?
- how do we persist what happened?
- how do we recover if the server restarts or a run gets orphaned?

That is much more than “call an LLM.”

## Read Order

1. [`heartbeat-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/heartbeat-ts.md)
2. [`adapters-index-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/adapters-index-ts.md)
3. [`arceus-index-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/arceus-index-ts.md)
4. [`arceus-execute-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/arceus-execute-ts.md)
5. [`execution-workspace-policy-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/execution-workspace-policy-ts.md)
6. [`workspace-runtime-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/workspace-runtime-ts.md)

## Why This Order

Start with heartbeat because it is the orchestrator.

Then read the adapter surface so you understand what heartbeat expects from a runtime.

Then read the concrete Arceus adapter to see how that contract is implemented.

Then read workspace policy and workspace runtime so you understand:

- how execution mode is chosen
- how directories, worktrees, and sidecar runtime services are actually created

## The Beginner Translation

If you are new to runtime orchestration, translate the parts like this:

- wakeup request = “please make this agent do something”
- heartbeat run = “this specific execution attempt”
- adapter = “the driver that knows how to talk to a concrete agent runtime”
- workspace policy = “what kind of coding sandbox/work folder should be used”
- workspace runtime = “the machinery that creates and cleans that environment”

## The Most Important Runtime Distinctions

While reading this phase, keep these pairs separate:

- wakeup request vs heartbeat run
- policy decision vs runtime execution
- adapter registration vs adapter execution
- current runtime state vs historical run record
- workspace reuse vs isolated worktree creation

Those distinctions are what make the system robust.

## What You Should Understand By The End

You do not need to memorize the giant files.

But you should be able to narrate:

1. how a run gets queued
2. how one run is claimed safely
3. how the system decides which workspace mode to use
4. how the adapter receives context and environment
5. how result data gets persisted
6. how recovery and cleanup happen after failure or restart

## Self-Check

Before moving on, see if you can answer:

1. What is the difference between a wakeup request and a heartbeat run?
2. Where does the system decide workspace mode?
3. Where does the system actually create a worktree or reuse a workspace?
4. Does the Arceus adapter execute code directly, or does it hand work to another runtime?
