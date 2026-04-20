# Arceus Core Flows

> Auto-generated documentation of the eight core system flows.
> Each section traces the data path from trigger to completion with file references.

---

## 1. CEO Sprint Proposal

The CEO agent generates a sprint proposal after each sprint completes, presenting tasks, dependencies, and risks for board approval.

### Trigger

`triggerCeoSprintProposal()` in [apps/api/src/sprints/proposals.ts](../apps/api/src/sprints/proposals.ts) is called when `finalizeSprintCompletion()` completes a sprint.

**Guards** (prevent duplicate/premature proposals):
- `ceoProposalInFlight` concurrency flag
- Cooldown after consecutive failures (`CEO_PROPOSAL_COOLDOWN_MS`)
- Current sprint must be `"completed"`
- If a `sprint_proposal` card already exists, auto-approves it instead

### Generation

1. `ensureAgentSession(snapshot, "ceo")` creates/reuses the CEO's LLM session
2. System prompt from `getRoleSoul("ceo").systemPrompt`
3. User prompt from `CEO_SPRINT_PROPOSAL_USER_PROMPT` ([apps/api/src/prompts/ceo-sprint.ts](../apps/api/src/prompts/ceo-sprint.ts))
4. `runPromptText("ceo", sessionId, system, user)` sends to LLM
5. `classifyCeoResponse()` ([apps/api/src/agents/ceo.ts](../apps/api/src/agents/ceo.ts)) runs a second structured-completion pass to parse the prose into a typed `CeoCard` with `sprint_goal`, `key_tasks[]`, `carried_forward`, `risks`, `rationale`

### Presentation & Approval

- The card is saved via `appendChatMessage()` with `cardType: "sprint_proposal"`
- **Auto-approval**: If `orchestratorConfig.sprint.autoApproveProposals` is `true` and not at a board-review cadence boundary
- **Manual approval**: `POST /api/sprint-proposal/approve` — finds the latest proposal card and calls `approveSprintProposal(card)`
- **Rejection**: `POST /api/sprint-proposal/reject` — resets `executionStatus` to `"done"`

### Post-Approval

`approveSprintProposal(card)` in [proposals.ts](../apps/api/src/sprints/proposals.ts):

1. Creates Sprint N+1 via `createSprintRecord()`
2. Each `key_task` → `createWorkflowTask()` with role, priority, dependencies
3. Auto-adds an integration task if ≥2 implementation tasks exist
4. Auto-adds tester dependencies on all implementation tasks
5. Auto-adds a CTO "Sprint Review" `board_handoff` as final task
6. Promotes root tasks (no deps) to `"planned"`
7. Sprint → `"executing"`, begins heartbeat-driven execution

---

## 2. Task Assignment & Execution

Tasks flow from plan → assignment → specialist execution → completion with artifact cascading.

### Task Creation from CTO Plan

`generateWorkflowTaskPlan()` ([apps/api/src/tasks/planner.ts](../apps/api/src/tasks/planner.ts)):

1. Builds a roster-scoped Zod schema (LLM can only assign to hired roles)
2. Routes through CTO session (`runPromptText`) or falls back to `structuredCompletion()`
3. Produces a `WorkflowTaskPlan`: five fixed stages + a `task_graph` with dependencies
4. Each spec hydrated onto task records via `hydrateTaskFromSpec()` ([apps/api/src/tasks/mutations.ts](../apps/api/src/tasks/mutations.ts))

### Assignment

`isTaskReadyForAutonomousExecution()` ([apps/api/src/tasks/helpers.ts](../apps/api/src/tasks/helpers.ts)) gates dispatch:
- Role must be in `AUTONOMOUS_READY_TASK_ROLES` (tester, ui_designer, marketing, skills_lead)
- Task kind must not be a core execution kind
- All dependencies met

`runAutonomousReadyTasks()` ([apps/api/src/tasks/specialist-executor.ts](../apps/api/src/tasks/specialist-executor.ts)) collects qualifying tasks, sorts by role weight then priority, executes sequentially.

### Specialist Execution

`executeSpecialistTask(taskId)` ([specialist-executor.ts](../apps/api/src/tasks/specialist-executor.ts)):

1. Dependency gate → skip if unmet
2. Agent lookup → `blocked` + escalation if missing
3. Role-specific pre-checks (tester needs preview URL, CTO needs reachable preview)
4. LLM execution via `runPromptText()` with role soul + skills + specialist prompt
5. Output wrapped into role-specific artifact, persisted, attached to task
6. Task → `completed` with role-specific side effects (memory handoffs, board approvals, skill packaging)

### Completion Cascade

`setTaskStatus()` ([packages/task-engine/src/task-state-machine.ts](../packages/task-engine/src/task-state-machine.ts)):

1. Status update + graph instrumentation + audit logging
2. `blocked` → triggers escalation meeting
3. `completed` → **artifact propagation**: `artifactIds` copied to children's `incomingArtifactIds`
4. `completed` → **dependency promotion**: downstream `created` tasks with all deps met → `planned`
5. Terminal status (`completed`/`failed`/`cancelled`) → hooks for hippocampus memory, skill evolution, pattern learning

---

## 3. Heartbeat Engine

The heartbeat engine drives all agent activity through periodic ticks with role-specific checklists.

### Start & Tick Loop

`HeartbeatEngine.start()` ([packages/company-runtime/src/heartbeat.ts](../packages/company-runtime/src/heartbeat.ts)):

1. Sets `running = true`, launches `setInterval` at `schedulerIntervalMs`
2. Each `tick()` expires stale locks, fetches agent roster
3. Agents sorted by role priority (CEO=0 → skills_lead=7)
4. Per-agent gating: role paused? Interval elapsed? Lock held? Semaphore full?
5. If all pass → `triggerBeat()`

### Four-Phase Executor

| Phase | Name | What Happens |
|-------|------|-------------|
| 1 | **Wake** | Acquire lock, build `AgentBeatContext`, early-exit if no agent/sprint/budget |
| 2 | **Observe** | `runChecklist(ctx)` — role-specific checks returning `ok`/`action_needed`/`blocked` |
| 3 | **Execute** | Select highest-priority task → `executeTask()`, or no-task action → `executeChecklistAction()` |
| 4 | **Serialize** | Flush mutations atomically with optimistic concurrency, audit, emit SSE |

### Role Checklists

Defined in [packages/company-runtime/src/heartbeat-checklist.ts](../packages/company-runtime/src/heartbeat-checklist.ts):

| Role | Checks |
|------|--------|
| CEO | meetingContribution, pendingApprovals, budgetHealth, sprintHealth, roadmap, boardMessages |
| CTO | escalationPending, meetingContribution, reviewQueue, buildStatus, devProgress, assignedTasks |
| PM | meetingContribution, scopeControl, sprintHealth, assignedTasks |
| Developer | meetingContribution, assignedTasks, dependenciesMet, buildStatus |
| Tester | meetingContribution, reviewPhaseActive, bugFixesReady, testQueue, assignedTasks |
| Skills Lead | meetingContribution, skillHealth, skillGaps, unusedSkills, skillQueue, assignedTasks |

### Beat Executors

`executeBeatTask()` ([apps/api/src/heartbeats/beat-executor.ts](../apps/api/src/heartbeats/beat-executor.ts)):
- **CEO**: Detects sprint completion → proposes next sprint; runs proactive governance
- **Specialists**: Delegates to `executeSpecialistTask()`
- **CTO/PM/Developer**: Builds prompt, applies governance pre-filter, calls OpenCode session

`executeChecklistAction()` ([apps/api/src/heartbeats/checklist-executor.ts](../apps/api/src/heartbeats/checklist-executor.ts)):
- Handles CEO sprint proposals, CTO escalation reviews, PM/CTO scope triage, tester sprint review, skills lead governance

### Reactive Events

`emitEvent()` queues events if agent is mid-beat (locked), drains after beat completes, triggering immediate event-driven beats. The event bridge ([apps/api/src/heartbeats/event-bridge.ts](../apps/api/src/heartbeats/event-bridge.ts)) streams OpenCode session events into agent state and prompt completion resolution.

---

## 4. Meeting Pipeline

Meetings coordinate multi-agent alignment through a phased pipeline.

### Scheduling

`MeetingScheduler` ([packages/company-runtime/src/meeting-scheduler.ts](../packages/company-runtime/src/meeting-scheduler.ts)):

1. Interval timer at `tickIntervalMs`
2. Auto-creates `daily_sync` when 2+ agents active (one-per-sprint gate)
3. `assessMeetingNeed()` evaluates: always meet if `maxConsecutiveSkips` reached or tasks blocked; skip if no activity

### Pipeline Phases

`MeetingPipeline.run()` ([packages/company-runtime/src/meeting-pipeline.ts](../packages/company-runtime/src/meeting-pipeline.ts)):

| Step | Status | Action |
|------|--------|--------|
| 1 | `collecting` | Each participant agent produces contribution via LLM (whatIDid, whatImDoing, blockers, learnings, questions) |
| 2 | `synthesizing` | Facilitator agent identifies conflicts, blockers, alignment issues |
| 3 | `resolving` | Facilitator decides actions (create_task, modify_task, escalate_to_board, note) per issue |
| 4 | `learning` | Extract memories from contributions into hippocampus |
| 5 | `completed` | Record health snapshot (duration, counts, tokens, meeting debt) |

### Meeting Effects

Applied via [apps/api/src/meetings/effects.ts](../apps/api/src/meetings/effects.ts):
- Creates new tasks from meeting decisions
- Modifies existing task statuses/assignments
- Creates escalation records for board attention

---

## 5. Memory (Hippocampus)

Three-tier memory system providing role-scoped context to agent prompts.

### Architecture

| Tier | Store | Content | Lifecycle |
|------|-------|---------|-----------|
| L1 — Static | `StaticMemoryStore` | Permanent facts from successful completions | Persists indefinitely |
| L2 — Dynamic | `DynamicMemoryStore` | Temporal facts from partial/failed completions | 7-day TTL, GC'd |
| L3 — Procedural | `ProceduralMemoryStore` | Habits (trigger → action pairs) | Usage-counted |
| Priming | `PrimingStore` | Agent emotional state (confidence, caution, morale) | Updated per completion |

### Storage Flow

`processTaskCompletion()` ([packages/hippocampus/src/service.ts](../packages/hippocampus/src/service.ts)):

1. **With LLM extractor**: Extract structured facts → route each through action decision (ADD/UPDATE/DELETE/NONE) → store to appropriate tier
2. **Without extractor**: Store raw output as single `MemoryUnit` (success → static, failure → dynamic with 7-day TTL)
3. Always update priming state and habit usage counters

Memory Agent ([apps/api/src/memory/extractors.ts](../apps/api/src/memory/extractors.ts)) provides three phases:
- **EXTRACT**: Structured `ExtractedFact[]` with type, confidence, temporal flag
- **DECIDE**: Per-fact action against existing memories
- **PRIME**: Disposition generation from agent state

### Retrieval Flow

`prepareAgentContext(agentId, taskDescription)`:

1. Embed task description (pgvector)
2. Parallel fetch: embedding query, all habits, priming state
3. LLM habit matching (or naive token fallback)
4. Vector similarity search across static + dynamic stores
5. MMR ranking (relevance vs. diversity balance)
6. Generate disposition string from priming state
7. Returns `{ memories, habits, priming }`

### Role-Scoped Operations

[apps/api/src/memory/operations.ts](../apps/api/src/memory/operations.ts):
- `updateRoleMemory()`: Replace agent's `currentFocus` (cap 6)
- `enrichRoleMemory()`: Merge into focus/learnings/patterns/blockers/decisions
- `formatHippocampusContext()`: Convert to prompt-ready text with headers

---

## 6. Preview Lifecycle

Live preview provides real-time visibility into developer output.

### Starting Preview

1. Workspace monitor detects file changes → calls `maybeStartDeveloperLivePreview()` ([apps/api/src/workspace/monitor.ts](../apps/api/src/workspace/monitor.ts))
2. `collectCandidateWorkspaces()` scans product dir for project roots
3. Framework detection classifies as `browser` or `service`
4. `startLocalPreview()` ([apps/api/src/workspace/preview.ts](../apps/api/src/workspace/preview.ts)):
   - Installs deps if `node_modules` missing
   - Spawns dev server with `PORT`/`HOST`/`BROWSER=none`
   - `waitForUrl()` polls until HTTP 200 or timeout

### Workspace Monitoring

`startDeveloperWorkspaceMonitor()` ([monitor.ts](../apps/api/src/workspace/monitor.ts)):
1. Takes initial snapshot (`mtimeMs` per file)
2. Periodic polling compares current vs. previous snapshot
3. Changed files → touch agent session, reschedule watchdog, emit activity, attempt preview

### Stall Detection

`scheduleDeveloperWatchdog()` ([apps/api/src/workspace/watchdog.ts](../apps/api/src/workspace/watchdog.ts)):
- Timer at `DEVELOPER_STALL_TIMEOUT_MS`
- Reset on every detected file change
- On fire → `failDeveloperStall()`: error status, fail build task, record escalation meeting

---

## 7. Sprint Review & Verification

Multi-phase quality gate between implementation and sprint completion.

### Review Trigger

When all non-followup/bugfix tasks reach terminal status → `checkSprintCompletion()` ([packages/task-engine/src/sprint-lifecycle.ts](../packages/task-engine/src/sprint-lifecycle.ts)) transitions sprint to `"reviewing"`.

### Verification Gate

`runVerificationGate(productDir, phase)` ([apps/api/src/sprints/verification-gate.ts](../apps/api/src/sprints/verification-gate.ts)):
1. `npm install` if `node_modules` missing
2. `npm run build` with 2-min timeout → fail on non-zero exit
3. `npm run test` (final phase only) with result summary extraction
4. Preview health probe (warning on `pre_review`, hard fail on `final`)

### Tester QA Verification

`executeSprintReviewVerification()` ([apps/api/src/sprints/review.ts](../apps/api/src/sprints/review.ts)):
1. Collect completed tasks, probe preview, check entry-point imports
2. LLM tester produces structured QA report (defects, DoD checklist, verdict)
3. **Hard overrides**: Preview unreachable → forced FAIL; entry-point disconnected → forced FAIL

### Rework Cycles

On FAIL:
1. `reworkCycleCount++`, phase → `"rework"`
2. Bug tasks filed per finding (capped at `MAX_FINDINGS_PER_TASK`)
3. Reactive `"bug_reported"` event wakes assigned agents
4. After fixes → `executeRetestAfterRework()` resets to `"tester_verification"`

### CTO Escalation

When `reworkCycleCount >= maxReworkCycles`:
1. Phase → `"escalated"`, notify CTO
2. CTO reviews and decides:
   - **`"fix"`**: Grant one more rework cycle
   - **`"skip"`**: Ship with known defects → `finalizeSprintCompletion()`
   - **`"abort"`**: Cancel sprint entirely

### Sprint Finalization

`finalizeSprintCompletion()` ([apps/api/src/sprints/lifecycle.ts](../apps/api/src/sprints/lifecycle.ts)):
1. Stop preview
2. Sprint → `"completed"` with summary stats
3. Tag workspace snapshot for rollback capability
4. Cross-sprint pattern transfer (fire-and-forget)
5. CEO notified → triggers next sprint proposal

---

## 8. Execution Cycle

Orchestration layer managing the overall flow from sprint start to completion.

### Execution Start

`beginSprintExecution()` ([apps/api/src/sprints/proposals.ts](../apps/api/src/sprints/proposals.ts)):
1. `executionStatus` → `"executing"`
2. Ensure workspace is local
3. Start event bridge
4. Hand off to heartbeat engine

### Post-Core Reconciliation

`reconcilePostReviewExecution()` ([apps/api/src/orchestration/execution-cycle.ts](../apps/api/src/orchestration/execution-cycle.ts)):
1. Prune already-completed specialist tasks (LLM audit)
2. Run autonomous-ready specialist tasks
3. Check board review requirements

### Board Review

If `shouldPauseForBoardReview()` returns `true`:
- `pauseForBoardReview()` → status `"awaiting_board_review"`, record meeting
- `approveBoardReview()` → resolve approvals, mark done, check sprint completion

### Cycle Completion

`completeExecutionCycle()`:
1. Status → `"done"`
2. Mark review task as verified
3. Record completion meeting
4. `checkSprintCompletion()` → may trigger sprint finalization

### Forced Stop

`stopExecution()`:
1. Clear watchdog/monitor, stop preview
2. All `in_progress`/`verifying` tasks → `blocked`
3. All working sessions → `idle`
4. Status → `"paused"`
