# Orchestration Architecture

## Entry: `beginExecution()`

Creates **5 core tasks** in a strict dependency chain:

```
technical_plan (CTO) → acceptance_spec (PM) → implementation (Developer) → local_preview (Developer) → board_handoff (CTO)
```

Each task has `dependsOnTaskIds` pointing to its predecessor. The event bridge (OpenCode SSE stream) is started, and execution begins with the planning phase.

## The LLM Router — Dynamic Flow Engine

The system does **not** use a hardcoded phase pipeline. Instead, `router.ts` implements `runRouterLoop()`:

1. After every task completion or status change, the LLM is asked *"what should happen next?"* given current task states, recent transitions, and feedback history.
2. The LLM responds with typed `TransitionProposal[]`, each with a confidence score.
3. Each proposal is validated against:
   - A **state machine** of valid status transitions (e.g., `in_progress` → `completed|failed|blocked|verifying`)
   - **Dependency satisfaction** — a task can't start until predecessors are complete
   - **Iteration limits** — max feedback loop reopens per task (default 3)
   - **Confidence threshold** — low-confidence proposals are recorded but not executed (need approval)
4. The loop keeps cycling until: all tasks done, router says pause, max transitions reached, or no valid transitions exist.

This means the flow is genuinely **dynamic** — the LLM can skip phases, re-open completed tasks for revision, or route to specialists based on what it observes in the snapshot.

## Phase Execution (`executeTransitionWork`)

When the router transitions a task, the orchestrator maps `task.kind` to the right phase function:

| `task.kind` | Phase Function | Agent | Blocking? |
|---|---|---|---|
| `technical_plan` | `runPlanningPhase()` | CTO | Sync (awaits prompt) |
| `acceptance_spec` | `runAcceptancePhase()` | PM | Sync (awaits prompt) |
| `implementation` | `startDeveloperPhase()` | Developer | **Async** (yields) |
| `local_preview` | `startPreviewPhase()` | Developer | Sync (launches preview) |
| `board_handoff` | `startReviewPhase()` | CTO | Sync (awaits prompt) |
| specialist tasks | `executeSpecialistTask()` | Various | Sync |

## The Async Developer — Yield & Re-enter Pattern

The developer phase is the only async phase. Here's how it avoids blocking:

1. Router proposes transitioning the `implementation` task to `in_progress`.
2. The `shouldYield` callback recognizes it and **yields** control back — the router loop exits.
3. `startDeveloperPhase()` fires an **async prompt** (`prompt_async`) to OpenCode and returns immediately.
4. Three monitors run in parallel during developer work:
   - **Event Bridge** — streams OpenCode SSE events (text chunks, tool calls, file edits, shell commands) and updates telemetry in real time.
   - **Workspace Monitor** — polls the filesystem every N seconds for changed files.
   - **Developer Watchdog** — timeout timer reset on every activity signal.
5. When OpenCode emits `session.idle`, the event bridge catches it and calls `continueExecutionFromCurrentState("post-developer-idle")` — **re-entering the router loop** to decide what's next (usually preview → review).

## Stall Prevention (3 layers)

### Layer 1 — Developer Watchdog Timer (`DEVELOPER_STALL_TIMEOUT_MS`)

- Started when developer begins working; **reset** on every OpenCode event OR filesystem change.
- If it fires: marks status → `error`, build task → `failed`, creates an escalation meeting with diagnostic details (last event, tool counts, file edits, shell commands).
- This is the hard safety net.

### Layer 2 — Workspace Monitor

- Even if the OpenCode event stream drops, filesystem polling detects file changes and resets the watchdog.
- Also triggers live preview attempts during implementation (detects runnable targets early).

### Layer 3 — Event Bridge PREVIEW_URL Detection

- Scans developer text output for `PREVIEW_URL: http://...` patterns.
- Registers reported preview URLs immediately, enabling early preview validation.

### Router-level Safety Valves

- `maxTransitionsPerCycle` — prevents infinite routing loops.
- `maxFeedbackIterations` per task — caps revision cycles at 3.
- Confidence threshold gates risky transitions.
- `shouldPauseForBoardReview()` checks: pending approvals, blocked/failed tasks, incomplete core tasks.

## Post-Developer Reconciliation

After the CTO review phase completes:

1. `reconcilePostReviewExecution()` runs autonomous specialist tasks (tester, UI designer, marketing, skills lead) via multi-pass scheduling.
2. Checks if board review is needed (pending approvals, blockers, incomplete tasks).
3. If clean → `completeExecutionCycle()` → tags sprint snapshot → done.
4. If not → `pauseForBoardReview()` → status becomes `awaiting_board_review` → human approves via `approveBoardReview()`.

## Known Stall Risks

| Risk | Scenario | Mitigation |
|---|---|---|
| **Sync prompt hang** | CTO/PM OpenCode prompt never returns | No timeout on `runPromptText()` — these are blocking `await` calls with no watchdog |
| **Event bridge disconnect** | SSE stream drops silently | Bridge sets `eventBridgeStarted = false` but doesn't reconnect. Workspace monitor still works as backup |
| **Router deadlock** | LLM proposes only invalid transitions repeatedly | `maxTransitionsPerCycle` + "no valid transitions" exit, but execution enters limbo (not error, not done) |
| **Preview launch hang** | `startLocalPreview()` blocks on unreachable port | Has internal timeout, but failure path throws and can leave execution in error without clear recovery |

The developer phase is well-protected. The remaining stall surface is in the **synchronous phases** (planning, acceptance, review) where there's no watchdog equivalent, and in the router's ability to get stuck proposing invalid transitions without escalating to error state.
