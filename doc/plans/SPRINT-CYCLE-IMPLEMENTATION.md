# Sprint Cycle Implementation Plan (Spec 06 + Spec 08)

> Branch: dev/arceus-sprints
> Date: 2026-04-08
> Status: PHASE 1-3 IN REVIEW

## Context

Arceus runs a single execution cycle with a rigid pipeline (CTO → PM → Developer → Preview → Board Handoff). This plan implements sprint cycles where Board Handoff is the sprint boundary. After handoff, the CEO analyzes results, decides what to build next AND who does it, proposes Sprint N+1, and the Board approves.

**Key design decisions:**
1. **Board handoff = sprint end** — execution stops cleanly, no follow-up auto-execution
2. **Follow-up tasks are CEO input, not execution targets** — they inform the CEO's proposal but never run autonomously
3. **Sprint 1 = rigid pipeline** (CTO plan → PM spec → Dev builds → Preview → Handoff)
4. **Sprint 2+ = CEO-driven task DAG** — any employees, any dependencies, any parallelism. CEO decides both tasks AND delegation.
5. **Handoffs via task dependencies** — no explicit handoff meetings in Sprint 2+. The DAG defines the execution order.
6. **No new `executionStatus` value** — `"done"` + `sprint.status = "completed"` infers "between sprints"

---

## Sprint Lifecycle

```
Sprint 1 (rigid pipeline):
  Strategy Approved → Sprint 1 (planning)
  → CTO plan → PM spec → Developer builds → Preview → Board Handoff
  → Sprint 1 completed, executionStatus = "done"
  → Follow-up tasks stored as CEO context (not executed)
  → CEO analyzes everything → proposes Sprint 2 (sprint_proposal card)
  → Board approves

Sprint 2+ (CEO-driven DAG):
  → Sprint 2 (planning)
  → CEO's tasks execute as a dependency graph:
      developer: "Add auth" ──┐
      marketing: "Update copy"  ├──→ cto: "Review" ──→ tester: "Verify"
      ui_designer: "Polish UI" ─┘
  → All tasks complete → Board Handoff
  → Sprint 2 completed
  → CEO proposes Sprint 3 → ...
```

---

## Sprint 1 vs Sprint 2+ Execution

| Aspect | Sprint 1 | Sprint 2+ |
|--------|----------|-----------|
| **Pipeline** | Rigid: CTO → PM → Dev → Preview → Handoff | Flexible: CEO-defined task DAG |
| **Who works** | Always CTO, PM, Developer | Any employee — CEO decides |
| **Task source** | `generateWorkflowTaskPlan()` | CEO's `sprint_proposal.key_tasks` |
| **Dependencies** | Linear chain | CEO-defined DAG (parallel where possible) |
| **Handoffs** | Meeting-based (CTO→PM, PM→Dev) | Implicit via task dependencies |
| **Entry point** | `POST /api/strategy/execute` | `POST /api/sprint/approve` |
| **Team** | Created by `applyStrategy()` | Reused — same agents |
| **Workspace** | Fresh | Accumulated code from Sprint N |

---

## Phase 1: Store — Sprint CRUD ✅ IMPLEMENTED

- `upsertSprint()`, `updateSprint()`, `updateCompanySprint()`
- Sprint type imported, mutation patterns match existing store

---

## Phase 2: Sprint Creation ✅ IMPLEMENTED

- `createSprintRecord()` helper
- `beginExecution()` creates Sprint record, sets sprintId on tasks
- `tagCurrentSprintSnapshot()` uses correct sprint number

---

## Phase 3: Sprint Completion at Board Handoff ✅ IMPLEMENTED

### 3a. Suppress follow-up task execution

The router currently auto-executes follow-up tasks after core pipeline completes, which delays board handoff. Fix:

- When all 5 core tasks (technical_plan, acceptance_spec, implementation, local_preview, board_handoff) are completed → router stops
- Follow-up tasks stay as `created` — never promoted, never executed
- `board_handoff` completion triggers `pauseForBoardReview()`

### 3b. Follow-up tasks as CEO context

```
Task planner generates follow-ups during Sprint N
  → Stored with kind="follow_up", status="created"
  → Router ignores them
  → Frontend hides them
  → CEO receives them as "suggested next work" at board handoff
  → CEO may include some in Sprint 2 (or propose different tasks)
```

---

## Phase 4: No Schema Changes ✅

Sprint.status tracks lifecycle. executionStatus unchanged.

---

## Phase 5: CEO Sprint Proposal (The Brain) ✅ IMPLEMENTED

**Files:** `apps/api/src/ceo.ts`, `apps/api/src/chat.ts`

### What the CEO analyzes

```
1. ORIGINAL VISION — company.goal, strategy.summary
2. WHAT WAS BUILT — Sprint N artifacts (CTO plan, PM spec, developer output)
3. WHAT WENT WRONG — failed tasks, escalations, preview failures
4. BOARD FEEDBACK — chat messages during Sprint N
5. FOLLOW-UP SUGGESTIONS — task planner's recommendations (not executed, just data)
6. WORKSPACE STATE — file tree of current code
7. AGENT LEARNINGS — Hippocampus memories (when available)
```

### What the CEO outputs

A `sprint_proposal` card with:

```typescript
sprint_proposal: {
  sprint_goal: "Add user authentication and persist quiz scores",
  key_tasks: [
    {
      title: "Implement auth API endpoints",
      assigned_role: "developer",
      priority: "critical",
      depends_on: [],           // no deps → starts immediately
      rationale: "Board requested auth as top priority"
    },
    {
      title: "Review auth architecture",
      assigned_role: "cto",
      priority: "high",
      depends_on: ["Implement auth API endpoints"],  // waits for dev
      rationale: "Security review before launch"
    },
    {
      title: "Update landing page messaging",
      assigned_role: "marketing",
      priority: "medium",
      depends_on: [],           // parallel with dev work
      rationale: "Follow-up from Sprint 1"
    },
    {
      title: "Auth flow smoke test",
      assigned_role: "tester",
      priority: "high",
      depends_on: ["Review auth architecture"],  // after CTO review
      rationale: "Verify before board handoff"
    }
  ],
  carried_forward: ["Auth was requested by Board in Sprint 1 chat"],
  risks: ["Auth adds complexity to the frontend bundle"],
  rationale: "Board's top request + most critical follow-up from Sprint 1"
}
```

### CEO decides delegation

The CEO assigns `assigned_role` for each task based on:
- The role's capabilities (from ROLE_SOULS)
- What the task requires (code = developer, architecture = cto, copy = marketing)
- The available team (snapshot.agents)

The Board can edit the proposal before approving — change roles, add/remove tasks, adjust priorities.

### Implementation

**A.** Add `"between_sprints"` to `ceoStageSchema`

**B.** Update `inferCeoStage()`:
- Completed sprint + agents exist + executionStatus "done" → `"between_sprints"`

**C.** `buildSprintRetrospectiveContext(snapshot)`:
- Sprint N artifacts (truncated)
- Follow-up task suggestions (title, role, rationale)
- Workspace file tree
- Board chat messages
- Failed tasks

**D.** Update CEO prompt with between_sprints instructions + priority order

**E.** `sprint_proposal` card schema with `key_tasks` including `depends_on` and `assigned_role`

**F.** Update classifier prompt with sprint_proposal docs

---

## Phase 6: Sprint 2+ Execution Path ✅ IMPLEMENTED

**File:** `apps/api/src/orchestrator.ts`

### `approveSprint()` — Board approves CEO's sprint proposal

```
1. Guard: executionStatus === "done", completed sprint exists
2. Create new Sprint record
3. Convert sprint_proposal.key_tasks into Task objects:
   - Each task gets assigned_role from proposal
   - Each task gets depends_on resolved to task IDs
   - All tasks get sprintId
4. Call beginExecution() with Sprint 2+ flag:
   - Skip applyStrategy (team exists)
   - Skip generateWorkflowTaskPlan (tasks come from CEO proposal, not CTO)
   - Use upsertTask() per task (preserve Sprint 1 tasks)
   - Add a board_handoff task at the end (depends on all other tasks)
5. Router drives execution via dependency DAG
   - Tasks with no deps start immediately (parallel)
   - Tasks with deps wait for upstream completion (auto-promote)
   - board_handoff triggers pauseForBoardReview when all done
```

### How the DAG executes

```
Sprint 2 tasks:
  [developer: auth]  ──┐
  [marketing: copy]    ├──→ [cto: review] ──→ [tester: verify] ──→ [board_handoff]
  [ui: polish]        ─┘

Router sees:
  - developer, marketing, ui → no deps → all go to in_progress (parallel)
  - cto → depends on developer → auto-promotes when dev completes
  - tester → depends on cto → auto-promotes when cto completes
  - board_handoff → depends on all → triggers board review
```

The existing router + auto-promote system handles this. No changes to router logic needed — the DAG structure is different from Sprint 1 but the execution engine is the same.

---

## Phase 7: API Routes

**File:** `apps/api/src/server.ts`

Already added:
- `POST /api/sprint/approve` — converts sprint_proposal → tasks → execution
- `GET /api/sprints` — list all sprints

---

## Phase 8: Frontend

**File:** `apps/web/app/page.tsx`

### A. Sprint proposal card (SprintProposalView)
- Shows sprint goal, key tasks with assigned roles, dependencies, risks
- Board can edit: change roles, remove tasks, add tasks
- "Approve & Start Sprint" button

### B. Sprint status in header
- "Sprint 1 · Executing" / "Sprint 1 · Done" / "Sprint 2 · Planning"

### C. Hide follow-up tasks
- Task pipeline only shows tasks for the current sprint
- Follow-ups visible only as CEO context (not in UI task list)

### D. Sprint completion message
- "Sprint N complete. Message the CEO to plan Sprint N+1."

---

## Phase 9: Spec 08 Storage

Already working. Sprint snapshots, git tags, workspace persistence all functional.

---

## Follow-Up Task Lifecycle

```
Task planner generates follow-ups during Sprint N
  → Stored: kind="follow_up", status="created", no sprintId
  → Router IGNORES (only core pipeline tasks execute)
  → Auto-promote SKIPS (follow-ups not dependency-driven)
  → Frontend HIDES from task display
  → CEO receives as context at board handoff
  → CEO includes relevant ones in Sprint N+1 proposal (or proposes new tasks)
  → Old follow-ups stay as historical data
```

---

## Implementation Order

```
✅ Phase 1: store.ts           — Sprint CRUD
✅ Phase 2: orchestrator.ts    — Sprint creation + sprintId
✅ Phase 3: orchestrator.ts    — Sprint completion at board handoff
✅ Phase 3a:                   — Suppress follow-up execution in router
✅ Phase 5: ceo.ts + chat.ts   — CEO sprint proposal brain + executionStatus wiring
✅ Phase 6: orchestrator.ts    — Sprint 2+ DAG execution path (approveSprint + CEO key_tasks)
✅ Phase 7: server.ts          — Sprint routes (approve accepts key_tasks)
   Phase 8: page.tsx           — Sprint UI + proposal editor
   Phase 9: Storage            — Already working
```

---

## Verification Checklist

- [x] Sprint record created on execution start
- [x] Tasks have sprintId
- [x] Sprint transitions planning → executing
- [x] Board handoff stops execution (no follow-up auto-execution)
- [x] Follow-up tasks stay as created (not activated)
- [x] Sprint marked completed at board handoff
- [x] CEO receives follow-ups + artifacts as context
- [x] CEO produces sprint_proposal with tasks + delegation + dependencies
- [ ] Board can edit sprint proposal before approving (Phase 8 — frontend)
- [x] Sprint 2 starts with CEO-defined DAG (not rigid pipeline)
- [ ] Multiple employees work in parallel where deps allow
- [ ] Board handoff at end of Sprint 2
- [ ] Frontend hides follow-up tasks, shows sprint indicator
