# Spec 21 — Sprint Verification & QA Framework

> **Status**: Proposed
> **Depends on**: Spec 02 (Agent Execution), Spec 06 (Sprint Cycle), Spec 09 (Product Verification — superseded), Spec 12 (Heartbeat Scheduling), Spec 13 (Policy Governance Gateway)
> **Supersedes**: Spec 09 (Draft, never implemented)

---

## Problem

In the orchestrator model, the tester would notice broken UI, notify the developer, who would fix it — and this feedback loop continued until quality was acceptable. The heartbeat model lost this loop entirely:

1. **Tester completes immediately** — `executeSpecialistTask` marks tester tasks `"completed"` with no rework path
2. **No bug tracking** — There's no `bug_fix` task kind, no defect entity, no way to track issues found during verification
3. **Sprint "reviewing" status is dead** — The enum value exists but `checkSprintCompletion()` jumps straight from all-tasks-terminal → `"completed"`
4. **No build/test gate** — Nobody runs `npm run build` or `npm run test`. Broken code ships silently.
5. **Tester can't write code** — `canWriteCode: false` contradicts the vision of test file authoring
6. **No rework loop** — When tester finds a problem, there's no mechanism to assign a fix back to the developer (or ui_designer) and re-test

The result: sprints "complete" with untested, potentially broken code. Quality depends entirely on individual agent diligence.

---

## Design Goals

1. **Verification-as-a-phase** — Sprint transitions through a formal `"reviewing"` status with automated gates and agent-driven QA
2. **Bug lifecycle** — Tester creates trackable `bug_fix` tasks assigned to the right agent, with FeedbackRound audit trail
3. **Rework loop** — Bug → fix → re-test, up to 3 cycles, then CTO escalation
4. **Automated gates** — Real `npm run build` and `npm run test` execution with exit code enforcement
5. **Reactive wiring** — Bug tasks trigger immediate agent wake-ups, not idle polling
6. **Sprint completion requires verification** — No sprint can complete without passing the gate and tester sign-off

---

## Architecture

```
ALL implementation tasks terminal
              │
              ▼
  ┌──────────────────────────────────────┐
  │     PHASE 1: PRE-REVIEW GATE         │
  │  Sprint status → "reviewing"         │
  │                                      │
  │  1. npm install (if needed)          │
  │  2. npm run build                    │
  │     fail? → create bug_fix task      │
  │             for developer            │
  │             (build_failure kind)      │
  │                                      │
  │  pass? → proceed to Phase 2          │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │     PHASE 2: TESTER VERIFICATION     │
  │                                      │
  │  Tester agent beats execute:         │
  │  1. Run npm run test (if exists)     │
  │  2. Read source code + artifacts     │
  │  3. Verify each DoD item             │
  │  4. Write test files (optional)      │
  │  5. Produce QA Report artifact       │
  │                                      │
  │  Tester verdict:                     │
  │    PASS → proceed to Phase 3         │
  │    FAIL → create bug_fix tasks       │
  │           ↓                          │
  │    ┌──────────────────┐              │
  │    │   REWORK LOOP    │              │
  │    │  (max 3 cycles)  │              │
  │    │                  │              │
  │    │  bug_fix task    │              │
  │    │  → dev/designer  │              │
  │    │  → reactive wake │              │
  │    │  → dev fixes     │              │
  │    │  → re-test       │              │
  │    │  → pass/fail     │              │
  │    └──────┬───────────┘              │
  │           │ 3 failures               │
  │           ▼                          │
  │    CTO escalation meeting            │
  │    CTO decides: fix / skip / abort   │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │     PHASE 3: FINAL GATE              │
  │                                      │
  │  1. npm run build (must pass)        │
  │  2. npm run test  (must pass)        │
  │  3. All bug_fix tasks resolved       │
  │                                      │
  │  pass? → Sprint "completed"          │
  │  fail? → Loop back to Phase 2        │
  └──────────────────────────────────────┘
```

---

## Data Model Changes

### New TaskKind: `"bug_fix"`

Added to the `TaskKind` union in `domain.ts`:

```typescript
"bug_fix"
```

A `bug_fix` task is created by the tester (or build gate) when a defect is found. It carries:
- `parentTaskId` → the original task that the bug was found in
- `assignedRole` → auto-inferred from defect area (see routing rules below)
- `definitionOfDone` → specific fix criteria from the tester's report
- `priority` → "critical" for build failures, "high" for functional bugs, "medium" for cosmetic

### New BeatEventTrigger: `"bug_reported"`

Added to the `BeatEventTrigger` enum:

```typescript
"bug_reported"
```

Emitted via `emitReactive(targetRole, "bug_reported")` when a `bug_fix` task is created, immediately waking the assigned agent.

### FeedbackRound for bug audit trail

Each bug_fix cycle creates a `FeedbackRound`:
- `fromRole` → "tester"
- `toRole` → "developer" | "ui_designer" (whoever the bug is assigned to)
- `verdict` → "revise" (initial report), "approve" (fix accepted), "escalate" (3 failures)
- `feedback` → structured defect description
- `taskId` → the bug_fix task ID

### Sprint "reviewing" status

`checkSprintCompletion()` no longer jumps to `"completed"`. Instead:

```
all impl tasks terminal → sprint status = "reviewing" → verification phases → "completed"
```

### VerificationGateResult type (new in domain.ts)

```typescript
interface VerificationGateResult {
  passed: boolean;
  buildResult: { exitCode: number; stdout: string; stderr: string } | null;
  testResult: { exitCode: number; stdout: string; stderr: string; summary: string } | null;
  phase: "pre_review" | "final";
  timestamp: string;
}
```

### SprintReviewState type (new in domain.ts)

```typescript
interface SprintReviewState {
  phase: "pre_gate" | "tester_verification" | "rework" | "final_gate" | "complete" | "escalated";
  gateResults: VerificationGateResult[];
  bugTaskIds: string[];
  reworkCycleCount: number;
  maxReworkCycles: number;      // default 3
  testerVerdict: "pending" | "pass" | "fail" | null;
  escalatedToCto: boolean;
  ctoDecision: "fix" | "skip" | "abort" | null;
  startedAt: string;
  completedAt: string | null;
}
```

This is stored as a field on the Sprint: `reviewState: SprintReviewState | null`.

---

## Bug Routing Rules

When the tester finds a defect, it includes a `defect_area` in its report:

| Defect Area | Assigned Role | Examples |
|---|---|---|
| `build_failure` | developer | Compilation errors, missing imports, syntax errors |
| `test_failure` | developer | Failing test assertions, runtime errors in tests |
| `ui_rendering` | ui_designer | Layout broken, wrong colors, missing elements, responsive issues |
| `ui_interaction` | developer | Click handlers broken, forms not submitting, state bugs |
| `api_behavior` | developer | Wrong response shape, missing endpoints, 500 errors |
| `accessibility` | ui_designer | Missing ARIA labels, contrast failures, keyboard nav broken |
| `content` | marketing | Placeholder text, wrong copy, missing content |
| `design_mismatch` | ui_designer | Implementation doesn't match design spec |
| `logic_error` | developer | Incorrect calculations, wrong business logic |
| `performance` | developer | Slow renders, memory leaks, excessive re-renders |

Default: `developer` (when area is ambiguous).

---

## Tester Role Updates

### Role soul changes

```typescript
tester: {
  canWriteCode: true,    // CHANGED from false — can now author .test.ts files
  canEditFiles: true,
  canRunShell: true,
  // rest unchanged
}
```

### Governance policy: tester code writing scope

Tester can use `write` and `edit` tools but ONLY for `*.test.*` and `*.spec.*` files. A new policy rule enforces this:

```typescript
{
  id: "tester-write-tests-only",
  name: "Tester: Write Tests Only",
  description: "Tester can write/edit only test files (*.test.*, *.spec.*). Production code is denied.",
  appliesTo: ["tester"],
  toolPatterns: ["write", "edit", "apply_patch"],
  decision: "allow",         // allow for test files
  priority: 550,             // above tester-no-code-write (500)
  minTrust: 0,
  // Custom: runtime check verifies file path matches test pattern
}
```

The existing `tester-no-code-write` rule (priority 500) denies `write` and `apply_patch`. The new rule at priority 550 creates a carve-out. The governance gateway is extended to support a `filePattern` field on rules for path-based enforcement.

### Tester checklist updates

New checklist items for the reviewing phase:

```typescript
tester: [
  checkReviewPhaseActive,    // NEW: sprint in "reviewing"? → run verification
  checkBugFixesReady,        // NEW: any bug_fix tasks just completed? → re-test
  checkTestQueue,            // existing: tasks in "verifying" status
  checkAssignedTasks,        // existing: tasks assigned to tester
]
```

---

## Verification Gate Implementation

### `runVerificationGate(phase: "pre_review" | "final"): Promise<VerificationGateResult>`

New function in orchestrator. Runs real shell commands in the product workspace:

```
1. Detect project type
   - Read <workspace>/package.json
   - If no package.json → skip gate, return { passed: true }

2. Install dependencies (if node_modules missing)
   - Run: npm install
   - Timeout: 120s
   - Failure → { passed: false, buildResult: { exitCode, stderr } }

3. Build check
   - Run: npm run build (if "build" script exists)
   - Timeout: 120s
   - Capture stdout, stderr, exit code
   - exit code 0 → proceed
   - exit code ≠ 0 → { passed: false, buildResult: { exitCode, stderr } }

4. Test check (final gate only, or if tests exist)
   - Run: npm run test (if "test" script exists)
   - Timeout: 120s
   - Capture stdout, stderr, exit code, test summary
   - exit code 0 → { passed: true }
   - exit code ≠ 0 → { passed: false, testResult: { exitCode, stderr, summary } }
   - No "test" script → skip (warn, don't fail)
```

Shell commands run via `child_process.execFile` with `{ cwd: productDir, timeout, shell: true }`.

---

## Sprint Review Flow (detailed)

### Entry: `enterSprintReview()`

Called when `checkSprintCompletion()` detects all non-follow_up tasks are terminal. REPLACES the current immediate-completion logic.

```
1. Set sprint.status = "reviewing"
2. Initialize sprint.reviewState = {
     phase: "pre_gate",
     gateResults: [],
     bugTaskIds: [],
     reworkCycleCount: 0,
     maxReworkCycles: 3,     // from config
     testerVerdict: null,
     escalatedToCto: false,
     ctoDecision: null,
   }
3. Run Phase 1: pre-review gate
4. Emit activity: "Sprint N entering review phase"
```

### Phase 1: Pre-review gate

```
1. Run runVerificationGate("pre_review")
2. If FAIL (build error):
   a. Create bug_fix task from build errors → assign to developer
   b. Set reviewState.phase = "rework"
   c. emitReactive("developer", "bug_reported")
   d. WAIT for developer to fix and re-test (handled by heartbeat)
3. If PASS:
   a. Set reviewState.phase = "tester_verification"
   b. emitReactive("tester", "task_assigned")  // wake tester
```

### Phase 2: Tester verification

Tester's heartbeat picks up the review via `checkReviewPhaseActive`:

```
1. Tester beat detects sprint.reviewState.phase === "tester_verification"
2. Tester runs verification:
   a. Execute npm run test (capture results)
   b. Read sprint task artifacts + source code
   c. Verify each completed task's definitionOfDone
   d. Optionally write new test files
   e. Produce structured QA report with verdict per task
3. For each FAIL finding:
   a. Create bug_fix task with:
      - parentTaskId → original failed task
      - defect_area → inferred from finding
      - assignedRole → from routing rules
      - definitionOfDone → specific fix criteria
      - priority → based on severity
   b. Create FeedbackRound (fromRole=tester, verdict=revise)
   c. emitReactive(assignedRole, "bug_reported")
4. If ALL pass:
   a. Set reviewState.testerVerdict = "pass"
   b. Set reviewState.phase = "final_gate"
5. If ANY fail:
   a. Set reviewState.testerVerdict = "fail"
   b. Set reviewState.phase = "rework"
   c. Increment reviewState.reworkCycleCount
```

### Rework Loop

When a bug_fix task is created:

```
1. Target agent (developer/ui_designer) is reactively woken
2. Agent's beat picks up the bug_fix task (normal task execution)
3. Agent fixes the issue, marks bug_fix task "completed"
4. checkBugFixesReady triggers tester re-verification
5. Tester re-tests ONLY the fixed items (not full regression)
6. If fix accepted:
   a. Create FeedbackRound (verdict=approve)
   b. If all bugs resolved → reviewState.phase = "final_gate"
7. If fix rejected:
   a. Create FeedbackRound (verdict=revise)
   b. Increment iterationCount on bug_fix task
   c. Reset bug_fix to "planned", re-assign
```

### Escalation (after 3 rework cycles)

```
1. Set reviewState.escalatedToCto = true
2. Create escalation meeting:
   - type: "escalation"
   - facilitatorRole: "tester"
   - participants: [cto, developer, tester, pm]
   - summary: "Sprint verification failed after 3 rework cycles"
3. CTO responds with decision:
   - "fix": Create new targeted bug_fix tasks with CTO guidance
   - "skip": Mark remaining bugs as known issues, proceed to final gate
   - "abort": Cancel sprint, mark as "failed"
4. Set reviewState.ctoDecision = decision
```

### Phase 3: Final gate

```
1. Run runVerificationGate("final")
2. If PASS:
   a. Set reviewState.phase = "complete"
   b. Complete sprint (existing logic: tag snapshot, CEO proposes next)
3. If FAIL:
   a. If reworkCycleCount < maxReworkCycles:
      - Create bug_fix tasks from gate failures
      - Loop back to Phase 2
   b. Else:
      - Escalate to CTO
```

---

## Tester Prompt Engineering

### Verification prompt (replaces current buildSpecialistTaskPrompt for tester)

The tester receives a structured prompt during the review phase:

```
You are verifying Sprint {N}: "{goal}".

## Completed Tasks
{for each completed task:}
  - [{task.id}] {task.title}
    Kind: {task.kind}
    Definition of Done: {task.definitionOfDone.join(", ")}
    Artifacts: {task.artifactIds}
    Status: {task.status}

## Product Workspace
Root: {productDir}
Files: {file listing}

## Your Verification Steps
1. Run the test suite: `npm run test` (if it exists)
2. Read the source files related to each task
3. For EACH task, verify every item in its definitionOfDone
4. Write test files for any untested functionality (*.test.ts)
5. Produce a structured QA report

## QA Report Format (required)
You MUST output a JSON block with this structure:
{
  "verdict": "pass" | "fail",
  "tasks": [
    {
      "taskId": "task_xxx",
      "verdict": "pass" | "fail",
      "findings": [
        {
          "defect_area": "ui_rendering" | "logic_error" | ...,
          "severity": "critical" | "high" | "medium" | "low",
          "description": "What is wrong",
          "expected": "What should happen",
          "actual": "What actually happens",
          "file": "path/to/file.ts",
          "fix_suggestion": "How to fix it"
        }
      ],
      "dod_checklist": [
        { "item": "DoD item text", "status": "pass" | "fail", "evidence": "..." }
      ]
    }
  ],
  "test_files_written": ["src/components/Menu.test.tsx", ...],
  "build_status": "pass" | "fail" | "skipped",
  "test_suite_status": "pass" | "fail" | "skipped" | "no_tests"
}
```

---

## HeartbeatConfig Extension

```typescript
interface HeartbeatConfig {
  // ... existing fields ...

  // Spec 21: Sprint Verification
  verification: {
    maxReworkCycles: number;          // default: 3
    gateTimeoutMs: number;            // default: 120_000
    enableBuildGate: boolean;         // default: true
    enableTestGate: boolean;          // default: true
    autoSkipOnNoPackageJson: boolean; // default: true
  };
}
```

---

## Implementation Plan

### Phase 1: Data Model (domain.ts + db)
1. Add `"bug_fix"` to `TaskKind` union
2. Add `"bug_reported"` to `BeatEventTrigger` enum
3. Add `VerificationGateResult` type
4. Add `SprintReviewState` type
5. Add `reviewState` field to Sprint schema
6. DB migration for `review_state` JSONB column on sprints table

### Phase 2: Tester Role + Governance
7. Update tester role soul: `canWriteCode: true`
8. Add `tester-write-tests-only` governance policy rule (priority 550)
9. Extend governance gateway for file-pattern rules (optional — can defer)

### Phase 3: Verification Gate
10. Implement `runVerificationGate()` — shell execution in product workspace
11. Create `GateResult` artifact builder for logging/display

### Phase 4: Sprint Review Flow
12. Modify `checkSprintCompletion()` → call `enterSprintReview()` instead of immediate completion
13. Implement `enterSprintReview()` with Phase 1 (pre-gate)
14. Implement tester verification beat logic with structured QA report parsing
15. Implement bug_fix task creation with routing rules
16. Implement FeedbackRound creation for audit trail
17. Wire `emitReactive(role, "bug_reported")` for immediate agent wake

### Phase 5: Rework Loop
18. Implement `checkBugFixesReady` checklist item for tester
19. Implement re-test logic (tester re-verifies only fixed items)
20. Implement rework cycle counter + escalation at limit
21. Implement CTO escalation meeting + decision handling

### Phase 6: Final Gate + Sprint Completion
22. Wire Phase 3 final gate after tester passes
23. Modify sprint completion to require reviewState.phase === "complete"
24. Update activity log / SSE events for review phase visibility

### Phase 7: UI + Observability
25. Update tester checklist (`checkReviewPhaseActive`, `checkBugFixesReady`)
26. Add review phase indicators to sprint dashboard
27. Add bug_fix task rendering in task list
28. Update governance dashboard for tester policy

---

## Edge Cases

| Case | Behavior |
|---|---|
| No package.json in workspace | Skip build/test gates, proceed to tester verification |
| No "test" script in package.json | Skip test gate, warn in gate result |
| No "build" script in package.json | Skip build gate, warn in gate result |
| Tester finds no bugs | Verdict = "pass", proceed to final gate |
| All impl tasks failed/cancelled | Sprint "reviewing" still runs — gate checks what's there |
| Bug_fix task itself fails | Counts as rework cycle, re-escalate if at limit |
| CTO says "abort" | Sprint marked "cancelled", CEO proposes new sprint |
| CTO says "skip" | Remaining bugs logged as known issues, final gate runs |
| Preview not ready | Tester blocks on preview (existing behavior preserved) |
| Budget exhausted mid-review | Governance denies tools, review pauses until budget restored |
| Sprint has zero tasks | Skip review entirely, mark completed (existing behavior) |

---

## Success Criteria

1. **Build failures caught** — If `npm run build` fails, developer gets a bug_fix task within one heartbeat cycle
2. **Test failures caught** — If `npm run test` fails, developer gets a bug_fix task with failing test details
3. **Tester finds UI bug** — ui_designer gets a bug_fix task, fixes it, tester re-verifies
4. **3 rework cycles** — After 3 failed fix attempts, CTO is escalated with full context
5. **Sprint completion requires passing** — No sprint reaches "completed" without gate + tester sign-off
6. **Audit trail** — Every bug, fix attempt, and re-test is tracked via FeedbackRound
7. **Reactive** — Bug_fix tasks wake target agents immediately, no idle polling
