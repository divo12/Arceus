# `server/src/adapters/index.ts`

This guide explains [`server/src/adapters/index.ts`](/Users/divyansh/Arceus/server/src/adapters/index.ts) as the adapter boundary barrel.

If you want one sentence first:

`adapters/index.ts` is a tiny file, but it is important because it defines the public adapter surface heartbeat uses instead of depending on one concrete runtime implementation.

## Mental Model

Heartbeat should not need to know the internals of:

- Arceus
- OpenCode
- Claude-local
- future adapters

It should only need a contract.

This file helps expose that contract.

So this is not about logic volume. It is about architectural separation.

## What This File Exports

It re-exports:

- adapter registry helpers
- adapter contract types from `@paperclipai/adapter-utils`
- `runningProcesses`

That means the rest of the backend can say things like:

- find an adapter
- list adapter models
- use `AdapterExecutionContext`
- use `AdapterExecutionResult`

without importing a concrete adapter file directly.

## Why This Matters

This is what lets heartbeat think in terms of:

- “give me an adapter of type X”

instead of:

- “if type is Arceus, import this file and call these custom methods”

That keeps the runtime layer more modular.

## The Two Big Ideas Hidden In This Tiny File

## 1. Registry, Not Hardcoding

The exported registry helpers mean adapters are discoverable through a registry surface.

That is a sign of a pluggable architecture.

## 2. Contracts, Not Concrete Coupling

The exported types mean the rest of the system can depend on:

- execution context shape
- result shape
- environment test shape
- session codec shape

instead of adapter-specific internals.

That is one of the most important abstractions in the execution system.

## Why `runningProcesses` Shows Up Here

`runningProcesses` being re-exported tells you that some adapters involve local child processes and the runtime layer wants a shared place to inspect or manage those.

That makes sense in a system that may:

- spawn local runtimes
- track them
- recover from them

## How This Connects To The Rest Of Phase 4

This file answers:

- what is the adapter boundary?

Then:

- [`arceus-index-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/arceus-index-ts.md) answers which capabilities Arceus registers under that boundary
- [`arceus-execute-ts.md`](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/arceus-execute-ts.md) answers how Arceus actually performs execution

## Self-Check

You understand this file if you can answer:

1. Why is a tiny barrel file still architecturally important?
2. Why should heartbeat depend on adapter contracts instead of concrete adapter implementations?
