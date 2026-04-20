# Task Assignment & Execution

Tasks flow through a state machine from creation to completion, driven by heartbeats.

## State Machine

```
created → planned → in_progress → code_complete → verified → done
                       ↓                              ↓
                    blocked                       rework → in_progress
```

Transitions are managed by `transitionTask()` in `packages/task-engine/src/state-machine.ts`.

## Assignment (Heartbeat-Driven)

During a heartbeat beat, each agent:

1. Runs its pre-beat checklist (`buildChecklist()` in `packages/company-runtime/src/checklist.ts`)
2. Picks the best task via `pickTask()` (`apps/api/src/orchestration/task-utils.ts`)
   - Filters tasks matching the agent's role
   - Scores by priority, dependencies met, sprint order
   - Prefers tasks the agent previously worked on
3. Transitions the chosen task to `in_progress`

## Developer Execution

When a developer agent picks a task:

1. `executeDeveloperBeat()` in `apps/api/src/agents/developer.ts`
2. Opens an OpenCode session for the task
3. Builds a structured prompt: task description + context from Hippocampus memory
4. Runs the prompt through OpenCode, producing file edits
5. On completion: task → `code_complete`

## Tester Verification

When the tester agent picks a `code_complete` task:

1. `executeTesterBeat()` in `apps/api/src/agents/tester.ts`
2. Runs build + test commands in the workspace
3. Pass → task → `verified` → `done`
4. Fail → task → `rework` with failure notes, loops back to developer

## Dependency Resolution

When a task completes, downstream dependents may become unblocked:

- `promotePlannedTasks()` in `packages/task-engine/src/sprint-lifecycle.ts`
- Scans all `planned` tasks; if every dependency is `done`, promotes to `planned` (ready for pickup)
- This drives the DAG execution order within a sprint

## Board Handoff

Special `board_handoff` tasks pause execution and present results to the board:

- Task transitions to `board_review` instead of `done`
- Board can approve (→ `done`) or reject (→ `rework`)
- Used for sprint review gates
