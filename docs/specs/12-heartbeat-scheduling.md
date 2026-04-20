# Spec 12: Heartbeat Scheduling Engine

> Status: PARTIAL — see Implementation Status below
> Last updated: 2026-04-14
> Depends on: Spec 11 (Control Plane Sovereignty)
> Enables: Spec 13 (Governance Gateway), Spec 14 (Self-Evolution), Spec 15 (Long-Horizon)

## Implementation Status

> **Implemented (✅):**
> - HeartbeatEngine class with 4-phase lifecycle (wake → observe → execute → serialize)
> - Beat scheduler with per-role intervals, role priority ordering (CEO first)
> - BeatLockManager + Semaphore concurrency control
> - All 8 role checklists (CEO, CTO, PM, Dev, Tester, UI, Marketing, Skills)
> - AgentBeatContext type + cpLoadAgentContext() assembly
> - Configuration: heartbeat.json defaults + env var overrides
> - All 6 API endpoints: start/stop/trigger/status/history/config
> - beat_records table (migration 004) + cpCommitBeatRecord()
> - beatId column in audit_events + withBeatScope() wiring
> - stageMutation() + batch flush in Phase 4
> - snapshot_version column on company_states
> - BeatEventBus pub/sub for SSE streaming
> - Budget enforcement: pauseWhenBudgetExhausted, beatTokenBudget ceiling
> - Sprint lifecycle: CEO detects completion → checkSprintCompletion → propose next → auto-approve
>
> **Not implemented (❌) — deferred to Spec 12 Phase 2:**
> - Event Triggers (Reactive dispatch): types exist but no event queue or reactive beat scheduling
> - commitTaskResult(): structured task completion + artifact + Hippocampus extraction
> - Optimistic Concurrency: expectedVersion plumbing exists but cpApplyMutations does not check it
> - TaskProgress: type exists, agentBeatContext.taskProgress always `[]`
> - Per-beat cost tracking: BeatRecord.costCents always 0
> - getBeatHistory from DB: only in-memory history (200 cap)
> - store.teardown() per beat: store persists across beats
> - OpenCode session destruction per beat
> - checkBuildStatus: returns stub — needs workspace integration
>
> **Deferred to future specs:**
> - Governance Gateway tool routing → Spec 13
> - trustFactor refinement → Spec 13
> - Roadmap alignment check → Spec 15
> - TaskProgress tracking across multi-beat tasks → Spec 15

## What This Is

The heartbeat is the clock that makes the company alive. Today, agents only advance when the orchestrator explicitly kicks them — a reactive, continuous loop that holds state in memory and collapses if anything goes wrong.

The heartbeat pattern replaces this with **temporal autonomy**: agents are dormant by default. At a configured interval, a daemon wakes them, they load fresh context from the Control Plane, observe their environment, execute bounded work, serialize results, and go back to sleep. Every cycle is independent. Every cycle is auditable. Every failure is contained.

This is not a background poller. This is the fundamental execution model for the autonomous company.

## Why This Matters

| Problem | Continuous Loop (Today) | Heartbeat (This Spec) |
|---------|------------------------|----------------------|
| Process crash mid-task | In-flight state lost. Manual restart. | Beat fails. Next beat resumes from Control Plane state. |
| Context window bloat | Orchestrator accumulates tokens across entire sprint | Fresh window per beat. ~2K tokens context, not 100K+ |
| Cost predictability | Unknown — sprint costs emerge after execution | Per-beat token budget enforced |
| Stale reasoning | Agent reasons over outdated assumptions from 20 minutes ago | Agent re-reads canonical truth every beat |
| Autonomy | Agents idle until human triggers execution | Agents wake on schedule, self-assess, act if needed |
| Debugging | Parse through monolithic session transcript | Each beat produces a discrete, bounded audit record |

## Heartbeat Lifecycle

Every heartbeat cycle follows four phases. This is rigid — no phase can be skipped.

```
┌─────────────────────────────────────────────────────────────────┐
│                      HEARTBEAT CYCLE N                           │
│                                                                  │
│  Phase 1: WAKE + CONTEXT ASSEMBLY                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 1. Scheduler triggers beat for agent                      │  │
│  │ 2. Create fresh BeatContext (no carryover from prior beat)│  │
│  │ 3. ControlPlane.loadAgentContext(companyId, agentId)      │  │
│  │    → agent identity + assigned tasks + memories + policies│  │
│  │ 4. ServiceRegistry.getToolsForRole(agent.role)            │  │
│  │    → available tools for this role                        │  │
│  │ 5. Inject SOUL + context + checklist into LLM prompt      │  │
│  │ 6. Record audit: beat_started                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  Phase 2: OBSERVE + ASSESS                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 1. Check HEARTBEAT_CHECKLIST for this role                │  │
│  │    (e.g., CTO: "any blocked tasks?", Dev: "build pass?") │  │
│  │ 2. Live environment checks (NOT cached assumptions):      │  │
│  │    - Read task statuses from Control Plane                │  │
│  │    - Check workspace state (file changes, build status)   │  │
│  │    - Check for pending approvals                          │  │
│  │    - Check for board messages since last beat             │  │
│  │ 3. Agent reasons: "Is there work for me right now?"       │  │
│  │    If NO → return HEARTBEAT_OK (skip Phase 3)            │  │
│  │    If YES → proceed to execution                         │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                    ┌─────────┴──────────┐                       │
│                    │                    │                        │
│                    ▼ (work needed)      ▼ (no work)             │
│  Phase 3: EXECUTE                     HEARTBEAT_OK              │
│  ┌──────────────────────────┐  ┌──────────────────────────┐    │
│  │ 1. Pick highest-priority │  │ Record: beat_completed   │    │
│  │    actionable task       │  │ outcome: HEARTBEAT_OK    │    │
│  │ 2. Execute via OpenCode  │  │ actions_taken: 0         │    │
│  │    session (fresh)       │  │ tokens: ~200 (assess)    │    │
│  │ 3. All tool calls go     │  │ Cost: ~$0.0001           │    │
│  │    through Governance    │  │                          │    │
│  │    Gateway (Spec 13)     │  │ → Enter dormancy         │    │
│  │ 4. Collect outputs       │  └──────────────────────────┘    │
│  │ 5. Stage mutations via   │                                   │
│  │    store.stageMutation() │                                   │
│  └──────────────────────────┘                                   │
│                              │                                   │
│                              ▼                                   │
│  Phase 4: SERIALIZE + DORMANCY                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 1. store.flush(causationEvent)                            │  │
│  │    → Push all staged mutations to Control Plane           │  │
│  │ 2. AuditLedger.append(beatCompletedEvent)                 │  │
│  │    → Log: actions taken, tokens used, cost, duration      │  │
│  │ 3. Hippocampus.processTaskCompletion() (if task finished) │  │
│  │    → Memory extraction (async, fire-and-forget)           │  │
│  │ 4. store.teardown()                                       │  │
│  │    → Destroy local cache. Zero state survives.            │  │
│  │ 5. Destroy OpenCode session                               │  │
│  │ 6. Agent enters DORMANCY until next scheduled beat        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Scheduler Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    HEARTBEAT DAEMON                               │
│                                                                  │
│   Runs in the API server process (apps/api)                      │
│   Single instance per deployment (no distributed scheduling)     │
│                                                                  │
│   ┌────────────────────────────────────────────────────────────┐ │
│   │                    BEAT SCHEDULER                           │ │
│   │                                                            │ │
│   │   For each active company:                                 │ │
│   │     For each active agent:                                 │ │
│   │       - Check: has interval elapsed since last beat?       │ │
│   │       - Check: any pending events for this agent?          │ │
│   │       - If yes → enqueue beat                              │ │
│   │                                                            │ │
│   │   Concurrency: max N beats executing simultaneously       │ │
│   │   (default: 4, configurable)                               │ │
│   │                                                            │ │
│   │   Priority: CEO > CTO > PM > Dev > Tester > others        │ │
│   └────────────────────────────────────────────────────────────┘ │
│                              │                                    │
│                              ▼                                    │
│   ┌────────────────────────────────────────────────────────────┐ │
│   │                    BEAT EXECUTOR                            │ │
│   │                                                            │ │
│   │   1. Acquire lock for (companyId, agentId)                 │ │
│   │   2. Run 4-phase heartbeat lifecycle                       │ │
│   │   3. Release lock                                          │ │
│   │   4. Record BeatRecord to DB                               │ │
│   │                                                            │ │
│   │   Timeout: max 5 minutes per beat (configurable)           │ │
│   │   If timeout → kill session, record beat_failed            │ │
│   └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Beat Triggers

Beats fire on two types of triggers:

### 1. Interval Trigger (Time-Based)

```typescript
// apps/api/src/config/heartbeat.ts

export const heartbeatConfig = {
  /** Global interval between beat scheduling checks (ms). */
  schedulerIntervalMs: 15_000,        // 15 seconds

  /** Per-role beat intervals. How often each role wakes up. */
  roleIntervals: {
    ceo:          60_000,             // 1 minute — strategic oversight
    cto:          45_000,             // 45 seconds — technical oversight
    pm:           60_000,             // 1 minute — scope management
    developer:    30_000,             // 30 seconds — active building
    tester:       45_000,             // 45 seconds — verification cycles
    ui_designer:  60_000,             // 1 minute
    marketing:    120_000,            // 2 minutes — less urgent
    skills_lead:  120_000,            // 2 minutes — background work
  } as Record<RoleSoul["role"], number>,

  /** Max concurrent beats across all agents. */
  maxConcurrentBeats: 4,

  /** Max duration for a single beat before timeout (ms). */
  beatTimeoutMs: 300_000,             // 5 minutes

  /** Per-beat token budget. Beat must stop if exceeded. */
  beatTokenBudget: 50_000,            // 50K tokens

  /** Per-beat cost ceiling (cents). */
  beatCostCeilingCents: 50,           // $0.50

  /** HEARTBEAT_OK token cost threshold.
   *  If observation phase uses fewer tokens than this, skip execution. */
  idleThresholdTokens: 500,
};
```

### 2. Event Trigger (Reactive)

<!-- ❌ NOT IMPLEMENTED — Spec 12 Phase 2
     Types BeatTrigger and BeatEventTrigger are defined in contracts/domain.ts,
     but no reactive dispatch exists. Currently only interval triggers fire.
     Needs: event queue per agent, wiring from task/chat/approval mutations
     to call heartbeatEngine.triggerBeat() with event-type triggers. -->

Some events should wake an agent immediately, regardless of interval:

```typescript
type BeatTrigger =
  | { type: "interval"; scheduledAt: string }
  | { type: "event"; event: BeatEventTrigger };

type BeatEventTrigger =
  | "task_assigned"           // agent got a new task
  | "task_dependency_met"     // upstream task completed, agent unblocked
  | "board_message"           // board sent a chat message (wakes CEO)
  | "approval_granted"        // board approved something (wakes assignee)
  | "feedback_received"       // CTO sent rework feedback (wakes developer)
  | "sprint_started"          // new sprint began (wakes all agents)
  | "escalation_received";    // another agent escalated to this one
```

When an event fires, the scheduler checks if a beat is already running for that agent. If yes, event is queued for next beat. If no, beat is immediately scheduled (respecting concurrency limits).

## Heartbeat Checklists

Each role has a proactive monitoring checklist evaluated during Phase 2 (Observe). These replace the passive "wait for orchestrator to assign work" model.

```typescript
// packages/company-runtime/src/heartbeat-checklist.ts

type ChecklistItem = {
  id: string;
  description: string;
  check: (ctx: AgentBeatContext) => Promise<CheckResult>;
  priority: "critical" | "high" | "low";
};

type CheckResult = {
  status: "ok" | "action_needed" | "blocked";
  detail?: string;
  suggestedAction?: string;
};

const CEO_CHECKLIST: ChecklistItem[] = [
  {
    id: "pending_approvals",
    description: "Any approvals waiting for board?",
    priority: "critical",
    check: async (ctx) => {
      const pending = ctx.approvals.filter(a => a.status === "pending");
      if (pending.length > 0) return {
        status: "action_needed",
        detail: `${pending.length} approvals waiting`,
        suggestedAction: "Remind board about pending approvals"
      };
      return { status: "ok" };
    }
  },
  {
    id: "budget_health",
    description: "Is spending on track vs roadmap?",
    priority: "high",
    check: async (ctx) => {
      const pctUsed = ctx.company.spentCents / ctx.company.budgetCents;
      if (pctUsed > 0.9) return {
        status: "action_needed",
        detail: `Budget at ${(pctUsed * 100).toFixed(0)}%`,
        suggestedAction: "Alert board about budget status"
      };
      return { status: "ok" };
    }
  },
  {
    id: "sprint_health",
    description: "Are any tasks stalled or blocked?",
    priority: "high",
    check: async (ctx) => {
      const blocked = ctx.tasks.filter(t => t.status === "blocked");
      const stale = ctx.tasks.filter(t =>
        t.status === "in_progress" &&
        Date.now() - new Date(t.startedAt!).getTime() > 30 * 60 * 1000
      );
      if (blocked.length > 0 || stale.length > 0) return {
        status: "action_needed",
        detail: `${blocked.length} blocked, ${stale.length} stale tasks`
      };
      return { status: "ok" };
    }
  },
  {
    id: "roadmap_alignment",
    description: "Is current sprint aligned with roadmap milestones?",
    priority: "low",
    check: async (ctx) => {
      // Spec 15 — roadmap alignment checks
      return { status: "ok" };
    }
  }
];

const CTO_CHECKLIST: ChecklistItem[] = [
  {
    id: "code_review_queue",
    description: "Any tasks awaiting my review?",
    priority: "critical",
    check: async (ctx) => {
      const waiting = ctx.tasks.filter(t =>
        t.kind === "board_handoff" && t.status === "created"
      );
      return waiting.length > 0
        ? { status: "action_needed", detail: `${waiting.length} tasks need review` }
        : { status: "ok" };
    }
  },
  {
    id: "build_health",
    description: "Does the workspace build cleanly?",
    priority: "high",
    check: async (ctx) => {
      // Run `npm run build` check
      return { status: "ok" };
    }
  },
  {
    id: "developer_progress",
    description: "Is the developer making progress?",
    priority: "high",
    check: async (ctx) => {
      const devTasks = ctx.tasks.filter(t =>
        t.assignedRole === "developer" && t.status === "in_progress"
      );
      // Check last file modification timestamps
      return { status: "ok" };
    }
  }
];

const DEVELOPER_CHECKLIST: ChecklistItem[] = [
  {
    id: "assigned_tasks",
    description: "Any tasks assigned to me?",
    priority: "critical",
    check: async (ctx) => {
      const myTasks = ctx.tasks.filter(t =>
        t.assignedAgentId === ctx.agentId &&
        ["planned", "in_progress"].includes(t.status)
      );
      return myTasks.length > 0
        ? { status: "action_needed", detail: `${myTasks.length} tasks to work on` }
        : { status: "ok" };
    }
  },
  {
    id: "build_status",
    description: "Does my latest code compile?",
    priority: "high",
    check: async (ctx) => {
      return { status: "ok" };
    }
  }
];

// ... similar for PM, Tester, UI Designer, Marketing, Skills Lead

export const ROLE_CHECKLISTS: Record<RoleSoul["role"], ChecklistItem[]> = {
  ceo: CEO_CHECKLIST,
  cto: CTO_CHECKLIST,
  pm: PM_CHECKLIST,
  developer: DEVELOPER_CHECKLIST,
  tester: TESTER_CHECKLIST,
  ui_designer: UI_DESIGNER_CHECKLIST,
  marketing: MARKETING_CHECKLIST,
  skills_lead: SKILLS_LEAD_CHECKLIST,
};
```

## AgentBeatContext: What An Agent Sees

```typescript
// packages/contracts/src/domain.ts — new type

interface AgentBeatContext {
  // Beat metadata
  beatId: string;
  beatNumber: number;
  trigger: BeatTrigger;
  startedAt: string;

  // Agent identity (from SOUL)
  agentId: string;
  agentName: string;
  role: RoleSoul["role"];
  soul: RoleSoul;

  // Company state (from Control Plane)
  company: Company;
  currentSprint: Sprint | null;

  // This agent's tasks (from current sprint)
  tasks: Task[];

  // Upstream artifacts relevant to this agent's tasks
  artifacts: Artifact[];

  // Memory context (from Hippocampus)
  memories: string[];           // top-5 relevant memories
  habits: string[];             // matching habits for current task
  priming: string;              // disposition text

  // Governance context
  availableTools: ServiceRegistryEntry[];
  trustFactor: number;          // 0.0 - 1.0 (Spec 13)

  // Environment
  approvals: Approval[];        // pending approvals visible to this agent
  recentBoardMessages: ChatMessage[];   // since last beat
  recentMeetings: Meeting[];            // since last beat

  // Budget constraints
  beatTokenBudget: number;
  beatCostCeilingCents: number;
  companyBudgetRemainingCents: number;
}
```

## Beat Execution Engine

```typescript
// packages/company-runtime/src/heartbeat.ts

interface HeartbeatEngine {
  /** Start the scheduler daemon. */
  start(companyId: string): void;

  /** Stop the scheduler (graceful — waits for running beats to finish). */
  stop(): Promise<void>;

  /** Manually trigger a beat for a specific agent (used by event triggers). */
  triggerBeat(companyId: string, agentId: string, trigger: BeatTrigger): Promise<BeatRecord>;

  /** Get the last N beat records for an agent. */
  getBeatHistory(agentId: string, limit: number): Promise<BeatRecord[]>;

  /** Check if a beat is currently running for an agent. */
  isBeating(agentId: string): boolean;
}

interface BeatRecord {
  id: string;
  companyId: string;
  agentId: string | null;
  beatNumber: number;
  trigger: BeatTrigger;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "failed" | "skipped" | "timed_out";
  snapshotVersionRead: number;
  snapshotVersionWritten: number | null;
  phases: {
    contextAssembly: { durationMs: number; tokensUsed: number };
    observation: { durationMs: number; tokensUsed: number; checkResults: CheckResult[] };
    execution: { durationMs: number; tokensUsed: number; toolCalls: number; actionsCount: number } | null;
    serialization: { durationMs: number; mutationCount: number } | null;
  };
  outcome: "HEARTBEAT_OK" | "WORK_DONE" | "ERROR" | "TIMED_OUT" | "BUDGET_EXCEEDED";
  totalTokens: number;
  costCents: number;
  errorMessage: string | null;
  summary: string;
}
```

## HEARTBEAT_OK: Efficient Idle Detection

Most beats will have nothing to do. A CTO beat where all tasks are proceeding normally should cost almost nothing.

```
Phase 2 (Observe):
  → Load checklist: 3 items for CTO
  → Run checks:
    code_review_queue: ok
    build_health: ok
    developer_progress: ok
  → All OK, no board messages, no events
  → Agent assessment: "Nothing needs my attention"
  → Cost: ~200-500 tokens ($0.0001-$0.0003)
  → Return HEARTBEAT_OK

NO Phase 3 (execution skipped)
NO Phase 4 (nothing to serialize)

Total beat cost: < $0.001
Time: < 2 seconds
```

This is critical for cost predictability. If a company has 8 agents, each beating every 60 seconds, that's 480 beats/hour. At $0.001/idle-beat, that's $0.48/hour for an idle company. When work is happening, only the working agents incur execution costs.

## Heartbeat vs Current Orchestrator: Migration

### Sprint 1 Execution (Hardcoded Pipeline)

Today's orchestrator runs a rigid sequence: CTO → PM → Developer → Tester → Review. This becomes heartbeat-driven:

```
BEFORE (orchestrator.ts — continuous loop):
  executeSprint() →
    while (hasReadyTasks) {
      const ready = getReadyTasks();
      await Promise.all(ready.map(executeTask));
    }

AFTER (heartbeat-driven):
  Each agent beats independently:
    CTO beats → finds "technical_plan" task assigned to me → executes it
    PM beats → checks dependencies → CTO plan not done yet → HEARTBEAT_OK
    PM beats → CTO plan done! → finds "acceptance_spec" task → executes it
    Developer beats → checks deps → PM spec not done → HEARTBEAT_OK
    Developer beats → PM spec done! → finds "implementation" task → executes it
    ...
```

The key difference: **no central orchestrator loop**. Each agent self-assesses and self-drives. The dependency graph is still in the Control Plane, but agents check it themselves during Phase 2.

### Sprint 2+ Execution (Router-Based)

Today's `router.ts` LLM-driven routing also becomes heartbeat-compatible:

```
BEFORE (router.ts — LLM proposes transitions):
  runRouterLoop() →
    while (activeTasks) {
      transitions = await llm.proposeTransitions(taskStates);
      for (t of transitions) validateAndExecute(t);
    }

AFTER (heartbeat-driven with LLM routing):
  CTO beats → Phase 2: observes task states → calls LLM router for assessment
    → LLM: "Developer task done, assign CTO review" → execute transition
  Developer beats → Phase 2: checks for assigned work → finds implementation task → executes
```

The LLM routing logic moves into the CTO's and CEO's Phase 2 (Observe) — they become the decision-makers about task transitions, while individual agents focus on executing their assigned work.

## Long-Running Tasks Within A Beat

<!-- ❌ NOT IMPLEMENTED — Deferred to Spec 15 (Long-Horizon Execution)
     TaskProgress type exists in contracts/domain.ts but agentBeatContext.taskProgress
     is always []. No progress tracking, step counting, or progress notes across beats.
     The workspace DOES persist (git-tracked), and tasks span beats via in_progress status,
     but there is no structured step-level tracking.
     See Spec 15 § Carried Forward from Spec 12. -->

Some tasks (e.g., Developer implementation) may take longer than a single beat. The heartbeat handles this by tracking **task progress across beats**:

```
Beat N: Developer starts task "Build auth API"
  Phase 3: Opens OpenCode session
  Phase 3: Executes step 1 of 4 (create auth schema)
  Phase 4: Saves progress: "Step 1/4 complete. Files: auth-schema.ts, migrations/"
           Task status stays "in_progress"
           → Dormancy

Beat N+1: Developer wakes
  Phase 2: Checks tasks → "Build auth API" still in_progress
           Reads progress notes from last beat
  Phase 3: Opens fresh OpenCode session
           Loads workspace (files from step 1 are there)
           Executes step 2 of 4 (create auth routes)
  Phase 4: Saves progress: "Step 2/4 complete."
           → Dormancy

Beat N+2: Step 3
Beat N+3: Step 4 → Task complete → artifacts collected
```

This means the Developer doesn't need to finish everything in one beat. The workspace persists between beats (git-tracked). Only the LLM context is fresh each time.

```typescript
// Per-task progress tracking (stored in task metadata, not volatile memory)
interface TaskProgress {
  taskId: string;
  totalSteps: number | null;        // null if unknown
  completedSteps: number;
  currentStepDescription: string;
  lastBeatId: string;
  filesModified: string[];          // workspace paths changed
  notes: string;                    // free-form progress notes for next beat
}
```

## Cost Model

<!-- ❌ NOT IMPLEMENTED — Spec 12 Phase 2
     BeatRecord.costCents is always 0. No per-beat cost calculation exists.
     Token counts are partially tracked (execution phase) but not converted to cost.
     Needs: LLM response token/cost extraction wired into BeatRecord. -->

```
Idle company (8 agents, no work):
  8 agents × 1 beat/min × 60 min = 480 beats/hour
  480 × $0.0005 (HEARTBEAT_OK) = $0.24/hour
  Monthly idle: $0.24 × 24 × 30 = ~$173/month

Active sprint (3 agents working, 5 idle):
  5 idle × 60 beats/hr × $0.0005 = $0.15/hour
  3 working × 60 beats/hr × $0.05/beat = $9.00/hour
  Active sprint hour: ~$9.15/hour
  Sprint (30 min active): ~$4.58

Compared to today:
  Sprint 1 estimate (Spec 10): $2-5 total
  With heartbeat overhead: $3-7 total
  Idle overhead when not executing: $0.24/hour

Optimization: Pause heartbeats for idle companies (no active sprint).
```

## Deferred from Spec 11

The following Control Plane interfaces were specified in Spec 11 but deferred because they only make sense once heartbeat scheduling exists. **This spec must implement them.**

> **Status of each deferred item:**
> 1. loadAgentContext() — ✅ Implemented
> 2. loadActiveSprint() — ✅ Implemented
> 3. commitBeatRecord() + beat_records — ✅ Implemented
> 4. commitTaskResult() — ❌ Not implemented
> 5. Optimistic Concurrency — ❌ Plumbing only (not enforced)
> 6. beatId in Audit Events — ✅ Implemented
> 7. stageMutation() — ✅ Implemented
> 8. snapshot_version — ✅ Migration done

### 1. `loadAgentContext()` — Minimal Beat Context

Spec 11 defines `ControlPlane.loadAgentContext(companyId, agentId)` returning `AgentBeatContext` — the minimal context an agent needs for one beat cycle. Currently `cpLoadSnapshot()` returns the full snapshot. This spec must:

- Define the `AgentBeatContext` type (agent identity + assigned tasks + relevant memories + policies)
- Implement `cpLoadAgentContext()` that assembles only what the agent needs
- Call it in Phase 1 (WAKE + CONTEXT ASSEMBLY) of every heartbeat cycle

### 2. `loadActiveSprint()` — Sprint with Dependency Graph

Spec 11 defines `ControlPlane.loadActiveSprint(companyId)` returning `Sprint & { tasks: Task[] }`. This is called at beat start to determine what work is available. Implement it when building the beat scheduler's task selection logic.

### 3. `commitBeatRecord()` + `beat_records` Table

Spec 11 specifies a `beat_records` table (see Spec 11 Database Changes section) and a `commitBeatRecord()` method. Each heartbeat cycle must produce one row capturing:

- `beat_number` (monotonic per agent), `started_at`, `ended_at`, `status`
- `snapshot_version_read` / `snapshot_version_written` (for concurrency tracking)
- `actions_taken`, `tool_calls`, `llm_calls`, `total_tokens`, `cost_cents`
- `outcome` (HEARTBEAT_OK | WORK_DONE | ERROR | SKIPPED), `summary`

**Migration required:** Create the `beat_records` table (DDL is in Spec 11 § Database Changes).

### 4. `commitTaskResult()` — Artifacts + Memory Extraction

<!-- ❌ NOT IMPLEMENTED — Spec 12 Phase 2
     Task completion is currently ad-hoc: setTaskStatus(taskId, "completed") in
     orchestrator.ts executeBeatTask(). No structured artifact collection or
     Hippocampus memory extraction is triggered on task completion.
     Hippocampus DOES run during beats (habit matching, priming, fact extraction)
     but not specifically on task completion events. -->

Spec 11 defines `commitTaskResult(companyId, taskId, result, causation)` which records task completion along with artifacts and triggers Hippocampus memory extraction. Implement when building the beat's Phase 3 (EXECUTE + RECORD) action handler.

### 5. Optimistic Concurrency — Version Conflict Detection

<!-- ❌ NOT ENFORCED — Spec 12 Phase 2
     The expectedVersion parameter flows through: HeartbeatEngine.flushStagedMutations()
     passes it to cpApplyMutations(). BUT cpApplyMutations() ignores it — always succeeds.
     snapshotVersionRead/Written are recorded in BeatRecord for future use.
     Needs: version check in cpApplyMutations, structured conflict error,
     retry-on-next-tick behavior in fourPhaseExecutor. -->

Spec 11 specifies optimistic concurrency: when a beat reads snapshot version N and another beat writes version N+1 before it commits, the late writer must fail and retry on next cycle. Currently `cpApplyMutations()` always succeeds. This spec must:

- Pass `expectedVersion` to `cpApplyMutations()`
- Detect conflicts and return a structured error
- Handle conflicts in the beat lifecycle (skip remaining mutations, mark beat as CONFLICT, retry next tick)

### 6. `beatId` in Audit Events

Spec 11's `AuditEvent` schema includes a `beatId` field that links events to specific heartbeat cycles. Currently not captured. This spec must:

- Add `beat_id TEXT` column to `audit_events` table (ALTER TABLE migration)
- Pass `beatId` to all `audit()` calls made within a beat's scope
- Add index: `CREATE INDEX idx_audit_beat ON audit_events(beat_id) WHERE beat_id IS NOT NULL`

### 7. `stageMutation()` — Batch Mutation Collection

Spec 11 describes a `stageMutation()` pattern where mutations are collected locally during a beat and flushed atomically at beat end (rather than persisting on every mutation). This changes the write path from immediate `replaceState()` → `persistState()` to staged collection → `flush()`. Implement as part of the beat's Phase 4 (SERIALIZE + PUSH).

### 8. `snapshot_version` Column on Companies Table

Spec 11 specifies `ALTER TABLE companies ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 0`. This DB-persisted version counter is needed for the optimistic concurrency model. Currently version tracking is ephemeral (resets on process restart). Wire this when implementing concurrency detection.

## Configuration

```typescript
// apps/api/src/config/heartbeat.ts — full configuration

export const heartbeatConfig = {
  // Scheduler
  schedulerIntervalMs: readNumberEnv("HEARTBEAT_SCHEDULER_INTERVAL_MS", 15_000),
  maxConcurrentBeats: readNumberEnv("HEARTBEAT_MAX_CONCURRENT", 4),

  // Per-role intervals
  roleIntervals: {
    ceo:         readNumberEnv("HEARTBEAT_CEO_INTERVAL_MS", 60_000),
    cto:         readNumberEnv("HEARTBEAT_CTO_INTERVAL_MS", 45_000),
    pm:          readNumberEnv("HEARTBEAT_PM_INTERVAL_MS", 60_000),
    developer:   readNumberEnv("HEARTBEAT_DEV_INTERVAL_MS", 30_000),
    tester:      readNumberEnv("HEARTBEAT_TEST_INTERVAL_MS", 45_000),
    ui_designer: readNumberEnv("HEARTBEAT_UI_INTERVAL_MS", 60_000),
    marketing:   readNumberEnv("HEARTBEAT_MARKETING_INTERVAL_MS", 120_000),
    skills_lead: readNumberEnv("HEARTBEAT_SKILLS_INTERVAL_MS", 120_000),
  },

  // Beat limits
  beatTimeoutMs: readNumberEnv("HEARTBEAT_BEAT_TIMEOUT_MS", 300_000),
  beatTokenBudget: readNumberEnv("HEARTBEAT_BEAT_TOKEN_BUDGET", 50_000),
  beatCostCeilingCents: readNumberEnv("HEARTBEAT_BEAT_COST_CEILING_CENTS", 50),

  // Idle detection
  idleThresholdTokens: readNumberEnv("HEARTBEAT_IDLE_THRESHOLD_TOKENS", 500),

  // Company-level controls
  pauseWhenNoActiveSprint: true,        // pause heartbeats when between sprints
  pauseWhenBudgetExhausted: true,       // hard stop at 100% budget
  pauseRoles: [] as RoleSoul["role"][],  // manually paused roles (e.g., pause marketing)
};
```

## API Endpoints

```
POST /api/heartbeat/start
  Body: { companyId }
  → Start heartbeat daemon for company
  → Returns: { status: "started", agentCount: 8 }

POST /api/heartbeat/stop
  Body: { companyId }
  → Gracefully stop all beats for company
  → Returns: { status: "stopped", pendingBeats: 0 }

POST /api/heartbeat/trigger
  Body: { companyId, agentId, trigger }
  → Manually trigger a beat for one agent
  → Returns: BeatRecord

GET /api/heartbeat/status/:companyId
  → Returns: { running: boolean, agents: [{ agentId, lastBeat, nextBeatAt, status }] }

GET /api/heartbeat/history/:companyId
  Query: ?agentId=&limit=20
  → Returns: BeatRecord[]

PATCH /api/heartbeat/config/:companyId
  Body: { roleIntervals?, maxConcurrentBeats?, paused? }
  → Update runtime heartbeat config for a company
```

## How Heartbeat Integrates With Existing Specs

| Spec | Current Integration | With Heartbeat |
|------|-------------------|----------------|
| Spec 01 (Onboarding) | Orchestrator fires after strategy approval | Heartbeat starts after strategy approval. CEO beats immediately. Agent beats begin on first task assignment. |
| Spec 02 (Execution) | Orchestrator drives agents directly | Agents self-drive via heartbeat. Dependency checks in Phase 2 replace orchestrator's `getReadyTasks()`. |
| Spec 03 (Dashboard) | SSE from orchestrator events | SSE from beat events. Dashboard shows beat activity per agent. |
| Spec 05a (Hippocampus) | Called by orchestrator on task completion | Called in Phase 4 (Serialization) when task reaches terminal state. Memory retrieval in Phase 1. |
| Spec 06 (Sprint Cycle) | Orchestrator detects sprint completion | CEO beat detects "all tasks done" in Phase 2 → proposes next sprint. |
| Spec 08 (Workspace) | Git commit after each task | Git commit in Phase 4 when files changed. |
| Spec 10 (Budget) | Cost tracking per task | Cost tracking per beat. Per-beat budget ceiling enforced. |

## Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| Interval model | Fixed per-role (configurable) | Simple, predictable costs. Adaptive intervals add complexity without immediate benefit. |
| Concurrency model | Max N concurrent beats (default 4) | Prevents Azure API rate limiting. 4 agents can share 5000 req/min comfortably. |
| Beat scope | One task per beat maximum | Keeps beats bounded and auditable. Multi-task beats would complicate cost tracking. |
| Long tasks | Progress tracking across beats | Developer implementation spans multiple beats. Workspace persists, context is fresh. |
| Idle optimization | HEARTBEAT_OK suppression | Critical for cost. Idle beats cost < $0.001. |
| Failure handling | Record beat_failed, retry on next tick | No retry within same beat. Next beat loads fresh context and tries again. |
| Lock mechanism | In-memory mutex per (company, agent) | Single-process deployment. Use DB advisory locks if we go multi-process. |
| Sprint transition | CEO beat detects, not central orchestrator | CEO actively governs company via Phase 2 observations. |

## Files Changed

| File | Change |
|------|--------|
| NEW: `packages/company-runtime/src/heartbeat.ts` | HeartbeatEngine implementation |
| NEW: `packages/company-runtime/src/heartbeat-checklist.ts` | Per-role checklist definitions |
| NEW: `apps/api/src/config/heartbeat.ts` | Heartbeat configuration |
| MODIFY: `packages/contracts/src/domain.ts` | Add BeatRecord, AgentBeatContext, BeatTrigger, TaskProgress types |
| MODIFY: `apps/api/src/orchestrator.ts` | Refactor from continuous loop to beat executor |
| MODIFY: `apps/api/src/server.ts` | Add heartbeat API endpoints |
| MODIFY: `apps/api/src/router.ts` | Move routing logic into CTO/CEO Phase 2 assessment |
| MODIFY: `apps/api/src/activity.ts` | Emit beat events to SSE stream |
| NEW: `packages/db/src/schema/heartbeat.ts` | beat_records table (if not in Spec 11) |
