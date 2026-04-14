# Orchestration Architecture

## High-Level Flow

```mermaid
flowchart TB
    START([beginExecution]) --> PLAN[CTO: Technical Plan]
    PLAN --> SPEC[PM: Acceptance Spec]
    SPEC --> LOOP[Build → Preview → Review Loop]
    LOOP --> RECONCILE[Reconcile Specialist Tasks]
    RECONCILE --> DONE([Execution Complete])

    LOOP -- max cycles exhausted --> BOARD[Pause for Board Review]
    RECONCILE -- incomplete tasks --> BOARD
    BOARD -- human approves --> RECONCILE
```

Five core tasks are created with a strict dependency chain:

`technical_plan (CTO) → acceptance_spec (PM) → implementation (Developer) → local_preview (Developer) → board_handoff (CTO)`

---

## LLM Router — Dynamic Flow Engine

```mermaid
flowchart LR
    SNAP[Snapshot:<br/>task states +<br/>transitions +<br/>feedback] --> LLM[LLM Router]
    LLM --> PROPS[TransitionProposal[]]
    PROPS --> VAL{Validate}
    VAL -- valid --> EXEC[executeTransitionWork]
    VAL -- invalid --> DROP[Drop + log]
    EXEC --> SNAP
    VAL -- no valid transitions / max reached --> EXIT([Exit loop])
```

**Validation gates:** state machine legality, dependency satisfaction, iteration limits (3), confidence threshold.

---

## Phase Map

| `task.kind` | Function | Agent | Blocking? |
|---|---|---|---|
| `technical_plan` | `runPlanningPhase()` | CTO | Sync |
| `acceptance_spec` | `runAcceptancePhase()` | PM | Sync |
| `implementation` | `startDeveloperPhase()` | Developer | Async (yields) |
| `local_preview` | `startPreviewPhase()` | Developer | Sync |
| `board_handoff` | `startReviewPhase()` | CTO | Sync |
| specialist | `executeSpecialistTask()` | Various | Sync |

---

## Build → Preview → Review Loop (`runBuildPreviewReviewLoop`)

The core execution engine. Owns `developerStepLoopActive` for its entire duration to prevent race conditions with the event bridge.

```mermaid
flowchart TB
    DEV[startDeveloperPhase<br/>async prompt to OpenCode] --> PV{startPreviewPhase}

    PV -- PASS --> REV{startReviewPhase<br/>CTO structured verdict}
    PV -- FAIL --> CYC1{cycle < max?}
    CYC1 -- yes --> RW1[runDeveloperRework<br/>with preview feedback]
    CYC1 -- no --> BOARD([Pause for Board Review])
    RW1 --> PV

    REV -- PASS --> DONE([Both passed — exit loop])
    REV -- FAIL --> CYC2{cycle < max?}
    CYC2 -- yes --> RW2[runDeveloperRework<br/>with CTO feedback]
    CYC2 -- no --> BOARD
    RW2 --> PV

    style DEV fill:#1a73e8,color:#fff
    style DONE fill:#34a853,color:#fff
    style BOARD fill:#ea4335,color:#fff
```

**Config:** `maxReworkCycles` (default 3) via `ARCEUS_DEVELOPER_MAX_REWORK_CYCLES`.

---

## Preview Validation (`validatePreviewContent`)

Stack-agnostic source-code analysis (no HTML fetching).

```mermaid
flowchart LR
    SCAN[Scan all source files<br/>.ts .tsx .js .jsx .vue<br/>.svelte .py .html .css] --> CAP[Cap at 30k chars]
    CAP --> LLM[LLM QA Engineer<br/>structuredCompletion]
    LLM --> VERDICT{PreviewContentVerdict}
    VERDICT -- pass=true --> OK([Continue])
    VERDICT -- pass=false --> FAIL([Rework needed])
```

**FAIL conditions:**
- Entry point doesn't import product modules
- Only scaffold/boilerplate, no product logic
- Key spec features missing in source
- No meaningful styling (bare unstyled HTML)
- Hallucinated features not in spec (login pages, auth, etc.)

---

## Developer Step Execution with Retry

```mermaid
sequenceDiagram
    participant Loop as Rework Loop
    participant Step as runDeveloperStep
    participant OC as OpenCode
    participant Retry as withRetry (3 attempts)

    Loop->>Retry: runDeveloperStep(prompt)
    Retry->>Step: attempt 1
    Step->>OC: prompt_async
    OC-->>Step: session.idle
    Step-->>Retry: success

    Note over Retry,OC: On "fetch failed"
    Retry->>Step: resetOpencodeConnection()
    Retry->>Step: attempt 2 (backoff 2s→4s→8s)
    Step->>OC: prompt_async
    OC-->>Step: session.idle
    Step-->>Loop: success
```

Both `runDeveloperStep` and `runPromptText` are wrapped in `withRetry` (3 attempts, exponential backoff). On retryable errors (`TypeError: fetch failed`), the OpenCode connection is reset before the next attempt.

---

## Async Developer — Yield & Re-enter

```mermaid
sequenceDiagram
    participant Router as LLM Router
    participant Orch as Orchestrator
    participant OC as OpenCode
    participant EB as Event Bridge
    participant WD as Watchdog

    Router->>Orch: transition implementation → in_progress
    Orch->>Router: shouldYield → true (exit loop)
    Orch->>OC: prompt_async
    activate OC
    par Monitors
        EB->>EB: Stream SSE events
        EB->>WD: Reset on each event
    end
    OC-->>EB: session.idle
    deactivate OC
    EB->>Orch: continueExecutionFromCurrentState("post-developer-idle")
    Orch->>Router: Re-enter router loop
```

---

## Stall Prevention

```mermaid
flowchart TB
    subgraph "Layer 1 — Watchdog"
        WD[Developer Watchdog Timer] -- fires --> ERR[Mark error + escalation meeting]
        EVT[Any OpenCode event] -- resets --> WD
        FS[Filesystem change] -- resets --> WD
    end

    subgraph "Layer 2 — Workspace Monitor"
        POLL[Poll filesystem every Ns] -- detects changes --> WD
    end

    subgraph "Layer 3 — Event Bridge"
        SSE[SSE stream] -- PREVIEW_URL pattern --> REG[Register preview URL]
        SSE -- disconnect --> RECON[Auto-reconnect after 3s]
    end

    subgraph "Layer 4 — Router Safety"
        MAX[maxTransitionsPerCycle]
        ITER[maxFeedbackIterations = 3]
        CONF[Confidence threshold]
    end
```

---

## Post-Review Reconciliation

```mermaid
flowchart TB
    REV_DONE[CTO Review Passed] --> PRUNE[pruneAlreadyCompletedSpecialistTasks<br/>LLM scans workspace to auto-resolve<br/>tasks already covered by developer]
    PRUNE --> RUN[runAutonomousReadyTasks<br/>multi-pass specialist execution]
    RUN --> CHECK{shouldPauseForBoardReview?}
    CHECK -- pending approvals or<br/>incomplete core tasks --> BOARD[pauseForBoardReview]
    CHECK -- all clear --> COMPLETE([completeExecutionCycle<br/>tag sprint snapshot])

    BOARD -- human approves --> RUN

    style COMPLETE fill:#34a853,color:#fff
    style PRUNE fill:#fbbc04,color:#000
```

**Key:** No follow-up tasks are generated. All specialist work comes from the CTO's `task_graph`. Tasks already implemented by the developer are auto-pruned before specialist execution.

---

## CTO Review Verdict

```mermaid
flowchart LR
    SRC[Source files + spec] --> LLM[structuredCompletion<br/>CtoReviewVerdict]
    LLM --> V{verdict}
    V -- SHIP_IT --> PASS([PhaseResult ok=true])
    V -- NEEDS_WORK --> FAIL([PhaseResult ok=false<br/>+ reworkFeedback])
    V -- BLOCKED --> FAIL
```

Structured Zod schema — no free-text parsing.

---

## Scope & Quality Enforcement Points

```mermaid
flowchart TB
    subgraph "Prompt Layer"
        P1[CTO Plan Prompt<br/>scope discipline + UI quality]
        P2[Developer System Prompt<br/>CSS vars, typography, layout]
        P3[buildStepPrompt<br/>no-auth + styled-components]
        P4[Rework Prompt<br/>UI quality + no-auth]
    end

    subgraph "Validation Layer"
        V1[validatePreviewContent<br/>rejects bare HTML +<br/>hallucinated features]
        V2[CTO Review Verdict<br/>structured pass/fail]
    end

    P1 --> P2 --> P3
    P3 -- rework --> P4
    P3 --> V1
    V1 -- pass --> V2
    V1 -- fail --> P4
    V2 -- fail --> P4
    V2 -- pass --> DONE([Ship])

    style DONE fill:#34a853,color:#fff
```

Five prompt layers + two validation gates ensure UI quality and scope discipline.

---

## End-to-End Sequence

```mermaid
sequenceDiagram
    participant User
    participant Orch as Orchestrator
    participant CTO
    participant PM
    participant Dev as Developer (OpenCode)
    participant QA as LLM QA
    participant Spec as Specialist Pool

    User->>Orch: beginExecution(strategy)
    Orch->>CTO: runPlanningPhase()
    CTO-->>Orch: technical plan + task_graph
    Orch->>PM: runAcceptancePhase()
    PM-->>Orch: acceptance spec

    loop Build → Preview → Review (max 3 rework cycles)
        Orch->>Dev: startDeveloperPhase() / runDeveloperRework()
        Dev-->>Orch: code complete (session.idle)
        Orch->>QA: validatePreviewContent(source files)
        alt QA fails
            QA-->>Orch: {pass: false, reason}
            Note over Orch: continue → rework
        else QA passes
            QA-->>Orch: {pass: true}
            Orch->>CTO: startReviewPhase()
            alt CTO: NEEDS_WORK
                CTO-->>Orch: reworkFeedback
                Note over Orch: continue → rework
            else CTO: SHIP_IT
                CTO-->>Orch: approved
            end
        end
    end

    Orch->>Orch: pruneAlreadyCompletedSpecialistTasks()
    Orch->>Spec: runAutonomousReadyTasks()
    Spec-->>Orch: done
    Orch->>Orch: completeExecutionCycle()
    Orch-->>User: Execution complete
```
