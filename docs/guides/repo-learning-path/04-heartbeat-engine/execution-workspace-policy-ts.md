# `server/src/services/execution-workspace-policy.ts`

This guide explains `[server/src/services/execution-workspace-policy.ts](/Users/divyansh/Arceus/server/src/services/execution-workspace-policy.ts)` as the workspace policy decision layer.

If you want one sentence first:

`execution-workspace-policy.ts` does not create workspaces; it interprets project and issue settings and decides what execution workspace mode and adapter-facing config should be used.

## Mental Model

This file is about policy, not machinery.

That means:

- it parses settings
- normalizes them
- resolves precedence
- returns a clean decision

It does not:

- run git commands
- create directories
- remove worktrees

Those belong to `[workspace-runtime-ts.md](/Users/divyansh/Arceus/docs/guides/repo-learning-path/04-heartbeat-engine/workspace-runtime-ts.md)`.

This distinction is very important.

## The Core Problem It Solves

Paperclip may have workspace preferences coming from multiple places:

- project policy
- issue overrides
- legacy flags like `useProjectWorkspace`
- adapter config defaults

If all of those were interpreted ad hoc inside heartbeat or workspace runtime, the system would become messy quickly.

This file centralizes that reasoning.

## 1. Parsing Helpers

The file starts with helpers like:

- `cloneRecord(...)`
- `parseExecutionWorkspaceStrategy(...)`

These do normalization work:

- ensure the input is shaped like an object
- only accept known strategy types
- extract optional fields like branch template, base ref, worktree parent dir, provision/teardown commands

This is policy hygiene:

- accept messy input
- return normalized trusted shape

## 2. `parseProjectExecutionWorkspacePolicy(...)`

This function parses project-level workspace policy.

It handles things like:

- whether workspace isolation is enabled
- default mode
- default project workspace id
- whether issue override is allowed
- workspace strategy
- runtime, branch, PR, and cleanup policy objects

This is the project’s “default execution workspace constitution.”

## 3. `gateProjectExecutionWorkspacePolicy(...)`

This is a small but important function.

It can null out project workspace policy if isolated workspaces are not enabled at the broader system level.

That means:

- even if a project declares workspace policy
- a higher-level system flag may still disable it

This is a classic policy gate pattern.

## 4. `parseIssueExecutionWorkspaceSettings(...)`

This parses issue-level overrides.

Important supported modes include:

- `inherit`
- `shared_workspace`
- `isolated_workspace`
- `operator_branch`
- `reuse_existing`
- `agent_default`

That tells you the system supports finer-grained execution control than “always same folder.”

An issue can influence how isolated or shared its coding environment should be.

## 5. `defaultIssueExecutionWorkspaceSettingsForProject(...)`

This function answers:

if the project has a policy, what issue-level default should that imply?

This is useful because it keeps later layers from re-implementing the same project-to-issue default mapping repeatedly.

## 6. `resolveExecutionWorkspaceMode(...)`

This is the core decision function in the file.

It resolves the final workspace mode from:

- issue settings
- project policy
- legacy `useProjectWorkspace`

The precedence is basically:

1. issue override if explicit
2. project policy if enabled
3. legacy fallback
4. default shared workspace

This is the answer to the question:

“for this run, what execution mode should we actually use?”

## 7. `buildExecutionWorkspaceAdapterConfig(...)`

After the mode is resolved, this function builds the adapter-facing config that matches that decision.

It may:

- set or remove `workspaceStrategy`
- set or remove `workspaceRuntime`
- merge issue overrides over project policy
- clear workspace-specific config when mode is `agent_default`

This is important because policy decisions eventually have to become concrete runtime config.

So this function is the bridge from:

- resolved policy

to:

- usable adapter/workspace config

## What Makes This File Valuable

Without this file, workspace behavior would be scattered across:

- heartbeat
- workspace runtime
- adapter config handling

Centralizing policy reasoning gives you:

- clearer precedence rules
- easier testing
- easier future changes to workspace modes

## The Key Distinction To Remember

This file decides.

It does not do.

That is the whole reason it should exist separately.

## Self-Check

You understand this file if you can answer:

1. Why is workspace policy resolution separate from workspace creation?
2. What kinds of inputs can influence final workspace mode?
3. Why does `buildExecutionWorkspaceAdapterConfig(...)` matter after mode resolution?

