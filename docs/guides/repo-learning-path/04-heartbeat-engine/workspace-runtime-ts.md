# `server/src/services/workspace-runtime.ts`

This guide explains [`server/src/services/workspace-runtime.ts`](/Users/divyansh/Arceus/server/src/services/workspace-runtime.ts) as the execution environment machinery layer.

If you want one sentence first:

`workspace-runtime.ts` is the file that turns a workspace decision into real filesystem/process reality: project workspaces, git worktrees, cleanup commands, and runtime sidecar services.

## Mental Model

If `execution-workspace-policy.ts` answers:

- what mode should we use?

then `workspace-runtime.ts` answers:

- okay, now create, reuse, track, and later clean up the actual environment

So this file is where high-level runtime decisions become:

- directories
- branches
- worktrees
- commands
- child processes
- persisted runtime service records

## What This File Owns

This file owns two closely related domains:

1. execution workspace realization and cleanup
2. runtime services attached to those workspaces

That is why the file is large. It is both filesystem orchestration and sidecar-service lifecycle management.

## 1. Type Definitions At The Top

Interfaces like:

- `ExecutionWorkspaceInput`
- `ExecutionWorkspaceIssueRef`
- `ExecutionWorkspaceAgentRef`
- `RealizedExecutionWorkspace`
- `RuntimeServiceRef`

tell you what this file needs to know.

It needs both:

- enough issue/agent context to name and shape workspaces
- enough runtime metadata to track services over time

## 2. In-Memory Runtime Service Registries

Maps like:

- `runtimeServicesById`
- `runtimeServicesByReuseKey`
- `runtimeServiceLeasesByRun`

show that runtime service lifecycle is partly tracked in memory.

Why?

Because local processes and live leases are operational facts, not just database rows.

But later in the file you also see persistence helpers, which means the design is hybrid:

- in-memory truth for live process control
- database truth for recovery and inspection across restarts

That is an important system design choice.

## 3. Helper Functions: Safety And Naming

Many early helpers do very practical work:

- stable stringifying
- sanitizing env
- stable runtime service id generation
- slug sanitization
- workspace template rendering
- branch name sanitization
- absolute path checks
- formatted command display

These may look boring, but they are exactly what keep runtime infrastructure reliable and debuggable.

When a file manages git worktrees and child processes, naming and safety helpers matter a lot.

## 4. Command Execution Helpers

Helpers like:

- `executeProcess(...)`
- `runGit(...)`
- `runWorkspaceCommand(...)`
- recording wrappers for git and workspace operations

show that this file is not only choosing paths.

It is actually the layer that runs shell and git operations needed to realize an execution environment.

This is one place where the system touches operating-system reality very directly.

## 5. `realizeExecutionWorkspace(...)`

This is the most important workspace function.

At a high level it decides:

- if the strategy is not `git_worktree`, just use the project primary workspace
- if it is `git_worktree`, compute branch/worktree details, create or reuse the worktree, and return the resulting realized workspace

### Key steps

- parse strategy config
- compute repo root
- render branch template using issue/agent/project data
- choose worktree parent directory
- choose base ref
- reuse existing worktree if safe
- otherwise create a new worktree
- optionally run provisioning
- return normalized realized workspace info

### Why this matters

This is the bridge from abstract workspace strategy to actual `cwd` the adapter can run in.

Without this function, heartbeat would know the desired mode but not where execution should actually happen.

## 6. `cleanupExecutionWorkspaceArtifacts(...)`

This is the cleanup twin of realization.

It handles things like:

- running cleanup/teardown commands
- removing git worktrees
- deleting runtime-created branches when safe
- removing local directories when safe

The safety checks here matter a lot.

For example, the code refuses to delete a local path if it would contain the main project workspace.

That is exactly the kind of guardrail you want in a system that can create and destroy workspaces automatically.

## 7. Runtime Services: More Than Just Folders

Later in the file you see functions around runtime services:

- `ensureRuntimeServicesForRun(...)`
- `releaseRuntimeServicesForRun(...)`
- `stopRuntimeServicesForExecutionWorkspace(...)`
- `reconcilePersistedRuntimeServicesOnStartup(...)`
- `persistAdapterManagedRuntimeServices(...)`

This reveals another major idea:

an execution workspace may need local helper services around it.

Examples could include:

- dev servers
- sandboxes
- adapter-managed companion processes

So the runtime layer is not only about a folder path. It is about a runnable environment.

## 8. Persistence Of Runtime Services

The file includes persistence helpers for workspace runtime services.

This is important because if the server restarts, the system should not forget:

- what services were attached to which workspace
- which ones are still supposed to exist

That is why you see both:

- in-memory maps
- database persistence and reconciliation logic

This is exactly what long-lived execution systems need.

## 9. Startup Reconciliation

`reconcilePersistedRuntimeServicesOnStartup(...)` exists because live systems crash and restart.

On startup, the backend can inspect persisted runtime service records and reconcile them against fresh in-memory state.

This is a strong sign of production-oriented thinking:

- not “everything works if the process never dies”
- but “the system can re-establish truth after restart”

## 10. Why This File Is Separate From Heartbeat

Heartbeat already has enough responsibility:

- queueing
- sessions
- context
- adapter invocation
- persistence

If workspace realization and runtime service process management lived there too, that file would become unmanageable.

So this file is a valuable separation:

- heartbeat orchestrates
- workspace runtime materializes environment reality

## Self-Check

You understand this file if you can answer:

1. Why is workspace policy not enough on its own?
2. What is the job of `realizeExecutionWorkspace(...)`?
3. Why does the system track runtime services in both memory and the database?
4. Why are cleanup safety checks so important here?
