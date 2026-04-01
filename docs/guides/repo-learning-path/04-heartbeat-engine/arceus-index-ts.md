# `server/src/adapters/arceus/index.ts`

This guide explains `[server/src/adapters/arceus/index.ts](/Users/divyansh/Arceus/server/src/adapters/arceus/index.ts)` as the Arceus adapter registration card.

If you want one sentence first:

`arceus/index.ts` does not execute runs itself. It registers Arceus as an available adapter by declaring its capabilities, model list, and hook functions.

## Mental Model

Imagine heartbeat asks:

“I found an agent whose adapter type is `arceus`. What object should I use?”

This file answers that question.

It is basically a descriptor:

- adapter type name
- execute function
- environment test function
- skills functions
- model list
- configuration documentation

So this file is the adapter’s identity card.

## What This File Owns

It owns the adapter registration metadata:

- `type: "arceus"`
- `execute`
- `testEnvironment`
- `listSkills`
- `syncSkills`
- `supportsLocalAgentJwt`
- `models`
- `agentConfigurationDoc`

It does not own the detailed runtime behavior. That lives in:

- `[server/src/adapters/arceus/execute.ts](/Users/divyansh/Arceus/server/src/adapters/arceus/execute.ts)`

## Why This File Is Small On Purpose

This file is small because a clean adapter system separates:

- registration metadata
- actual execution logic

If those were mixed together, the runtime layer would be harder to inspect and extend.

## Key Fields

## `type`

This is the identity heartbeat and registry use to select the adapter.

If an agent row says adapter type is `arceus`, the system needs a registered module whose `type` matches.

## `execute`

This is the main runtime hook.

It points to the implementation that actually performs a run.

Important:

the function is referenced here, not implemented here.

## `testEnvironment`

This is used when the system wants to check whether the adapter environment is ready.

That is an operational capability, not only an execution capability.

## `listSkills` and `syncSkills`

These show that Arceus runtime capability is partly skill-driven.

That connects to the earlier UI workbench skills tab and to the adapter execution logic that materializes runtime skills.

## `supportsLocalAgentJwt`

This tells the rest of the system something about auth/runtime expectations for this adapter.

Even a small boolean like this matters because it shapes how the control plane can talk to the running agent.

## `models`

This is the operator-facing list of selectable models.

It is not just internal metadata. The UI and configuration flows can surface these options to users.

## `agentConfigurationDoc`

This is embedded documentation explaining adapter configuration fields and environment variables.

That is a nice pattern:

- adapter code and adapter config documentation live close together

which reduces drift.

## The Important Reality About Arceus Today

This file makes Arceus look like a fully independent runtime entry.

But to understand what it really does today, you have to read the execute implementation.

That implementation reveals an important truth:

Arceus is currently an adapter layer that hands work to an OpenCode-backed runtime flow.

So this file says “Arceus exists.”

The execute file says “here is how Arceus really runs work.”

## Self-Check

You understand this file if you can answer:

1. Why is adapter registration separate from adapter execution?
2. Which fields in this file are about runtime capability versus operator configuration?

