# Spec 15: Long-Horizon Strategic Execution

> **Status:** DRAFT v2
> **Last updated:** 2026-04-14
> **Depends on:** Spec 11 (Control Plane), Spec 12 (Heartbeat), Spec 13 (Governance), Spec 14 (Self-Evolution)
> **Absorbs:** V3-9 (Autonomy Levels)
> **Enables:** Full autonomous company lifecycle, Spec 17 (Self-Healing), Spec 20 (Artifact UX)

---

## What This Is

The company today has no future. It can execute a sprint, maybe two. But it has no roadmap, no OKRs, no multi-sprint milestones, and no way to autonomously decide what Sprint 3 should be. The board says "build a notes app" and the company builds a notes app. Then it stops. And waits.

This spec gives the company six abilities:

1. **Roadmap** — phases with milestones spanning multiple sprints
2. **OKRs** — objectives and key results tracked across sprints
3. **Lifecycle** — 7 stages from idea to scaling, each with distinct behavior
4. **Autonomy** — 5-level governance scale that increases as trust is earned
5. **Checkpoints** — intra-sprint artifacts surfaced to the board mid-execution
6. **Spec Quality** — explicit quality ladder from vague idea to bounded task

The CEO isn't just a message-passer — it's a strategic leader that thinks about where the company is going, monitors execution quality, and earns increasing autonomy.

---

## Why This Matters

```
WITHOUT long-horizon execution:
  Board: "Build a SaaS todo app"
  Sprint 1: Homepage, auth, basic CRUD → completes
  → Company stops. Board must manually initiate Sprint 2.
  → CEO has no roadmap. No understanding of what Sprint 2 should be.
  → Board has no visibility into mid-sprint progress.
  → Every sprint needs the same level of board involvement.

WITH long-horizon execution:
  Board: "Build a SaaS todo app"
  CEO: "Here's my proposed roadmap:
    Phase 1 (Sprint 1-2): Core product — auth, CRUD, basic UI
    Phase 2 (Sprint 3-4): Growth — real-time sync, collaboration
    Phase 3 (Sprint 5-6): Revenue — billing, teams, premium
    OKR: Ship to production within 6 sprints"
  Board: [Approves roadmap]
  Sprint 1 executes. Mid-sprint: CEO shows preview screenshot to board.
  Sprint 1 completes. CEO evaluates, auto-initiates Sprint 2 (autonomy level 3).
  Sprint 4: CEO surfaces OKR progress: "Collaboration 80% done."
  Sprint 6: CEO transitions to shipping stage. Deploys.
  Board never had to manually trigger a sprint after the first approval.
```

---

## The Six Systems

```
┌──────────────────────────────────────────────────────────────────────┐
│                    SPEC 15: LONG-HORIZON EXECUTION                    │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ SYSTEM 1:  │  │ SYSTEM 2:  │  │ SYSTEM 3:  │  │ SYSTEM 4:    │  │
│  │ ROADMAP    │  │ LIFECYCLE  │  │ AUTONOMY   │  │ CHECKPOINTS  │  │
│  │            │  │            │  │ LEVELS     │  │              │  │
│  │ Phases     │  │ 7 stages   │  │            │  │ Mid-sprint   │  │
│  │ Milestones │  │ Transitions│  │ 1-5 scale  │  │ artifacts    │  │
│  │ OKRs       │  │ CEO behave │  │ Earned     │  │ Board can    │  │
│  │ Adjustments│  │            │  │ trust-based│  │ intervene    │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────┘  │
│                                                                      │
│  ┌─────────────────────────┐  ┌──────────────────────────────────┐  │
│  │ SYSTEM 5:               │  │ SYSTEM 6:                        │  │
│  │ SPEC QUALITY LADDER     │  │ TOKEN BUDGET MONITORING          │  │
│  │                         │  │                                  │  │
│  │ L0: Board idea          │  │ Track tokens per task            │  │
│  │ L1: CEO strategy        │  │ Warn at 500K threshold           │  │
│  │ L2: CTO plan            │  │ Force decomposition at 1M        │  │
│  │ L3: PM acceptance       │  │ Quality signal, not just cost    │  │
│  │ L4: Developer task      │  │                                  │  │
│  └─────────────────────────┘  └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## System 1: Company Roadmap

The roadmap is the CEO's strategic artifact. It lives in the Control Plane, persists across sprints, and drives all strategic decisions.

### Types

```typescript
interface CompanyRoadmap {
  id: string;
  companyId: string;
  status: "draft" | "proposed" | "approved" | "active" | "completed" | "abandoned";
  vision: string;
  phases: RoadmapPhase[];
  okrs: CompanyOKR[];
  lifecycle: CompanyLifecycleStage;
  autonomyLevel: AutonomyLevel;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RoadmapPhase {
  id: string;
  name: string;                             // "Phase 1: Core Product"
  description: string;
  order: number;
  status: "upcoming" | "active" | "completed" | "skipped";
  targetSprintRange: [number, number];      // [1, 2] = sprints 1-2
  milestones: PhaseMilestone[];
  completedAt: string | null;
}

interface PhaseMilestone {
  id: string;
  description: string;
  status: "pending" | "achieved" | "missed";
  evidence: string | null;                  // link to artifact that proves it
  evaluatedAt: string | null;
}

interface CompanyOKR {
  id: string;
  objective: string;
  keyResults: KeyResult[];
  timeframe: string;                        // "6 sprints" | "Phase 1-2"
  status: "active" | "achieved" | "missed" | "revised";
}

interface KeyResult {
  id: string;
  metric: string;
  target: string;
  current: string;
  status: "on_track" | "at_risk" | "behind" | "achieved";
  updatedAt: string;
}
```

### Roadmap Generation

When the CEO receives the company brief, it generates the first roadmap:

```typescript
async function generateInitialRoadmap(brief: string, companyId: string): Promise<CompanyRoadmap> {
  // LLM: gpt-4o, ~2000 tokens, ~$0.05
  // Output: vision, 2-4 phases with milestones, 1-2 OKRs with key results
  // Realistic scope: each sprint = 3-7 tasks, typical project = 4-8 sprints
}
```

### Roadmap Adjustment

The roadmap isn't static. CEO proposes adjustments based on sprint outcomes:

```typescript
interface RoadmapAdjustment {
  type: "schedule_shift" | "phase_restructure" | "okr_revision" | "scope_reduction";
  description: string;
  reason: string;
  requiresBoardApproval: boolean;    // true for structural changes
  proposedChanges: RoadmapDiff;
}
```

**Rules:**
- Schedule shifts (same phases, shifted dates) → CEO auto-approves if autonomy >= 3
- Structural changes (phases added/removed) → always requires board approval
- OKR revision → requires board approval if autonomy < 4
- Scope reduction → CEO auto-approves if autonomy >= 2

### Sprint Auto-Initiation

When a sprint completes:

```
Sprint N completes
    │
    ▼
CEO heartbeat evaluates:
    │
    ├─ 1. Evaluate Sprint N outcomes
    │     "What was planned? What was delivered? Any gaps?"
    │
    ├─ 2. Update roadmap
    │     "Mark completed milestones. Update OKR key_results.current."
    │
    ├─ 3. Check phase completion
    │     "All Phase K milestones achieved? → Phase K status = completed"
    │
    ├─ 4. Propose Sprint N+1
    │     "Based on roadmap, next sprint should focus on: [...]"
    │
    ├─ 5. Auto-initiation gate
    │     ┌───────────────────────────────────────────────┐
    │     │ Can auto-initiate if ALL TRUE:                │
    │     │  □ Autonomy level >= required for action      │
    │     │  □ Board has approved the current roadmap      │
    │     │  □ Sprint is within a board-approved phase     │
    │     │  □ Budget remaining > estimated sprint cost   │
    │     │  □ Lifecycle stage allows auto-initiation      │
    │     │  □ No pending board escalations                │
    │     │                                               │
    │     │ If ALL TRUE → auto-start Sprint N+1           │
    │     │ If ANY FALSE → propose to board and wait      │
    │     └───────────────────────────────────────────────┘
    │
    └─ 6. Communicate to board
          "Sprint N complete. Phase 1 at 67%. Starting Sprint N+1."
```

---

## System 2: Company Lifecycle

Every company progresses through defined stages. The stage determines CEO behavior, sprint frequency, and governance policies.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    COMPANY LIFECYCLE                                       │
│                                                                           │
│   ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│   │  IDEA   │──▶│ PLANNING │──▶│ BUILDING │──▶│ TESTING  │             │
│   │         │   │          │   │          │   │          │             │
│   │ Board   │   │ CEO      │   │ Multiple │   │ QA focus │             │
│   │ gives   │   │ proposes │   │ sprints  │   │ Bug fix  │             │
│   │ brief   │   │ roadmap  │   │ execute  │   │ sprints  │             │
│   └─────────┘   └──────────┘   └──────────┘   └──────────┘             │
│                                                      │                    │
│                                                      ▼                    │
│                ┌──────────┐   ┌──────────┐   ┌──────────┐              │
│                │ SCALING  │◀──│ITERATING │◀──│ SHIPPING │              │
│                │          │   │          │   │          │              │
│                │ Perf     │   │ Feedback │   │ Deploy   │              │
│                │ optimize │   │ driven   │   │ to prod  │              │
│                │ growth   │   │ sprints  │   │ announce │              │
│                └──────────┘   └──────────┘   └──────────┘              │
└───────────────────────────────────────────────────────────────────────────┘
```

```typescript
type CompanyLifecycleStage =
  | "idea"          // Board has given brief, no work started
  | "planning"      // CEO is crafting roadmap, no sprints yet
  | "building"      // Active development sprints
  | "testing"       // Focus on QA, stability, bug-fix sprints
  | "shipping"      // Deploying to production
  | "iterating"     // Post-launch improvements based on feedback
  | "scaling";      // Performance optimization, feature expansion

const LIFECYCLE_CONFIG: Record<CompanyLifecycleStage, LifecycleStageConfig> = {
  idea: {
    ceoBehavior: "Analyze brief, research competitors, propose roadmap",
    heartbeatMultiplier: 0.5,
    minAutonomyRequired: 1,
    autoSprintInitiation: false,
    allowedBlastRadius: ["green"],
  },
  planning: {
    ceoBehavior: "Draft roadmap, define phases, set OKRs, seek board approval",
    heartbeatMultiplier: 1.0,
    minAutonomyRequired: 1,
    autoSprintInitiation: false,
    allowedBlastRadius: ["green"],
  },
  building: {
    ceoBehavior: "Monitor sprint health, evaluate milestones, initiate next sprints",
    heartbeatMultiplier: 1.0,
    minAutonomyRequired: 2,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
  testing: {
    ceoBehavior: "Focus on quality, request test plans, gate shipping on test results",
    heartbeatMultiplier: 1.0,
    minAutonomyRequired: 2,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
  shipping: {
    ceoBehavior: "Coordinate deployment, verify production health, communicate to board",
    heartbeatMultiplier: 2.0,
    minAutonomyRequired: 4,           // deploy is high-stakes
    autoSprintInitiation: false,
    allowedBlastRadius: ["green", "yellow", "red"],
  },
  iterating: {
    ceoBehavior: "Review metrics, gather feedback signals, propose improvement cycles",
    heartbeatMultiplier: 1.0,
    minAutonomyRequired: 3,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
  scaling: {
    ceoBehavior: "Optimize performance, plan capacity, propose growth features",
    heartbeatMultiplier: 0.75,
    minAutonomyRequired: 3,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
};

interface LifecycleStageConfig {
  ceoBehavior: string;
  heartbeatMultiplier: number;
  minAutonomyRequired: AutonomyLevel;
  autoSprintInitiation: boolean;
  allowedBlastRadius: BlastRadius[];
}
```

### Lifecycle Transitions

```typescript
const LIFECYCLE_TRANSITIONS: Record<CompanyLifecycleStage, {
  next: CompanyLifecycleStage[];
  condition: string;
}> = {
  idea:      { next: ["planning"],             condition: "CEO ready to propose roadmap" },
  planning:  { next: ["building"],             condition: "Board approved roadmap" },
  building:  { next: ["testing", "shipping"],  condition: "Phase milestones achieved OR board directs testing" },
  testing:   { next: ["shipping", "building"], condition: "Quality gate met OR back to building for major bugs" },
  shipping:  { next: ["iterating"],            condition: "Successfully deployed to production" },
  iterating: { next: ["building", "scaling"],  condition: "Next iteration planned OR scaling needed" },
  scaling:   { next: ["iterating"],            condition: "Scaling objectives met, return to iteration" },
};
```

---

## System 3: Autonomy Levels

Autonomy is a spectrum, not a binary. A brand-new company needs board approval for everything. A company on Sprint 8 with a trusted CEO runs nearly independently.

### The 5 Levels

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    AUTONOMY LEVELS                                            │
│                                                                              │
│  Level 1: SUPERVISED                                                         │
│    Board approves: everything (strategy, sprints, all tasks)                 │
│    CEO can: propose, recommend, communicate                                  │
│    Auto-merge: nothing                                                       │
│    When: Brand new company. Sprint 0-1. CEO unproven.                        │
│                                                                              │
│  Level 2: GUIDED                                                             │
│    Board approves: strategy, phase transitions, structural roadmap changes   │
│    CEO can: auto-initiate sprints within approved phases                     │
│    Auto-merge: schedule shifts, minor scope adjustments                      │
│    When: Board approved roadmap. CEO completed 1+ sprints successfully.      │
│                                                                              │
│  Level 3: TRUSTED                                                            │
│    Board approves: phase transitions, structural changes, budget increases   │
│    CEO can: auto-initiate sprints, adjust OKRs, reduce scope                │
│    Auto-merge: green + yellow tier changes                                   │
│    When: CEO trust >= 0.7. 3+ sprints completed. No major failures.          │
│                                                                              │
│  Level 4: AUTONOMOUS                                                         │
│    Board approves: budget increases, deploy to production, structural pivots │
│    CEO can: everything except red-tier actions                               │
│    Auto-merge: all non-red changes                                           │
│    When: CEO trust >= 0.85. 5+ sprints. Company in building/iterating.       │
│                                                                              │
│  Level 5: SELF-GOVERNING                                                     │
│    Board approves: nothing (board is informed, not consulted)                │
│    CEO can: everything including red-tier (deploy, structural changes)       │
│    Auto-merge: all changes                                                   │
│    Board role: oversight, can override/pause at any time                     │
│    When: CEO trust >= 0.95. 10+ sprints. Proven track record.                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Autonomy Type

```typescript
type AutonomyLevel = 1 | 2 | 3 | 4 | 5;

interface AutonomyConfig {
  level: AutonomyLevel;
  name: string;
  boardApproves: string[];
  ceoCanAutoExecute: string[];
  autoMergeScope: BlastRadius[];
  trustThreshold: number;
  minSprintsCompleted: number;
}

const AUTONOMY_CONFIGS: Record<AutonomyLevel, AutonomyConfig> = {
  1: {
    level: 1,
    name: "Supervised",
    boardApproves: ["strategy", "sprints", "tasks", "roadmap_changes", "budget", "deploy"],
    ceoCanAutoExecute: ["propose", "communicate"],
    autoMergeScope: [],
    trustThreshold: 0,
    minSprintsCompleted: 0,
  },
  2: {
    level: 2,
    name: "Guided",
    boardApproves: ["strategy", "phase_transitions", "structural_changes", "budget", "deploy"],
    ceoCanAutoExecute: ["sprint_initiation", "schedule_shifts", "scope_reduction"],
    autoMergeScope: ["green"],
    trustThreshold: 0.5,
    minSprintsCompleted: 1,
  },
  3: {
    level: 3,
    name: "Trusted",
    boardApproves: ["phase_transitions", "structural_changes", "budget_increase", "deploy"],
    ceoCanAutoExecute: ["sprint_initiation", "okr_revision", "scope_reduction", "schedule_shifts"],
    autoMergeScope: ["green", "yellow"],
    trustThreshold: 0.7,
    minSprintsCompleted: 3,
  },
  4: {
    level: 4,
    name: "Autonomous",
    boardApproves: ["budget_increase", "deploy", "structural_pivots"],
    ceoCanAutoExecute: ["sprint_initiation", "phase_transitions", "okr_revision", "roadmap_adjustments"],
    autoMergeScope: ["green", "yellow"],
    trustThreshold: 0.85,
    minSprintsCompleted: 5,
  },
  5: {
    level: 5,
    name: "Self-Governing",
    boardApproves: [],
    ceoCanAutoExecute: ["everything"],
    autoMergeScope: ["green", "yellow", "red"],
    trustThreshold: 0.95,
    minSprintsCompleted: 10,
  },
};
```

### Autonomy Progression

Autonomy increases automatically when conditions are met:

```
After each sprint completion:
    │
    ├─ currentLevel = company.autonomyLevel
    ├─ ceoTrust = getCeoTrustScore(companyId)
    ├─ sprintsCompleted = getCompletedSprintCount(companyId)
    │
    ├─ Check next level requirements:
    │     nextConfig = AUTONOMY_CONFIGS[currentLevel + 1]
    │     if ceoTrust >= nextConfig.trustThreshold
    │        AND sprintsCompleted >= nextConfig.minSprintsCompleted:
    │
    │     → Propose autonomy upgrade to board
    │     → CEO: "I've completed 3 sprints with trust 0.74.
    │             Requesting upgrade from Guided (2) to Trusted (3).
    │             This means I can auto-adjust OKRs and reduce scope."
    │
    │     → If autonomy >= 3: auto-upgrade (CEO trusted enough to self-promote)
    │     → If autonomy < 3: board must approve
    │
    └─ Board can also:
       - Pin autonomy to a level ("Stay at level 2 indefinitely")
       - Downgrade autonomy ("Too many failures, back to level 1")
       - Override any auto-upgrade
```

### Autonomy × Lifecycle Matrix

```
              │ idea │ planning │ building │ testing │ shipping │ iterating │ scaling
──────────────┼──────┼──────────┼──────────┼─────────┼──────────┼───────────┼─────────
Autonomy 1    │  ✓   │    ✓     │    ✗     │    ✗    │    ✗     │     ✗     │    ✗
Autonomy 2    │  ✓   │    ✓     │    ✓     │    ✓    │    ✗     │     ✗     │    ✗
Autonomy 3    │  ✓   │    ✓     │    ✓     │    ✓    │    ✗     │     ✓     │    ✓
Autonomy 4    │  ✓   │    ✓     │    ✓     │    ✓    │    ✓     │     ✓     │    ✓
Autonomy 5    │  ✓   │    ✓     │    ✓     │    ✓    │    ✓     │     ✓     │    ✓

✓ = CEO can operate in this stage at this autonomy level
✗ = Lifecycle stage requires higher autonomy (falls back to board approval)
```

---

## System 4: Intra-Sprint Artifact Checkpoints

> From Aman (Cursor): "It would suck to do a $10K run and come back to garbage. You want to intervene at sub-points."

During a sprint, the CEO surfaces artifacts to the board at key moments. The board sees these in CEO chat as structured cards. They can intervene or let execution continue.

### Checkpoint Moments

| Moment | What CEO Surfaces | Board Can Do |
|--------|------------------|-------------|
| **After CTO plan** | Plan summary: architecture, tech stack, file structure | "That's wrong, use X instead" → replans |
| **After PM spec** | Acceptance criteria summary, definition of done | "Add requirement Y" → PM updates |
| **Mid-Developer** (every 3 steps) | File count, current state, any blockers | "Pause — let me look at the preview" |
| **After build completes** | Preview screenshot, test results, file manifest | "Looks wrong, redo the header" |
| **After CTO review** | Review findings, architecture compliance | "Ship it" or "Fix these issues first" |

### Checkpoint Types

```typescript
interface SprintCheckpoint {
  id: string;
  companyId: string;
  sprintId: string;
  type: "plan_ready" | "spec_ready" | "progress_update" | "build_complete" | "review_complete";
  summary: string;                        // 2-3 sentence summary
  artifacts: CheckpointArtifact[];
  boardActionRequired: boolean;           // true = blocking, false = informational
  boardResponse: string | null;
  createdAt: string;
  respondedAt: string | null;
}

interface CheckpointArtifact {
  type: "text" | "screenshot" | "file_manifest" | "test_results" | "review_report";
  title: string;
  content: string;                        // the actual content or URL
}
```

### Checkpoint Flow

```
Developer completes Step 3 of 6
    │
    ▼
Orchestrator: Is this a checkpoint moment?
    (every 3 steps, or after CTO/PM complete, or after build)
    │
    YES
    │
    ▼
CEO heartbeat picks up checkpoint:
    │
    ├─ Assemble checkpoint artifacts:
    │     - Current file count and names
    │     - Which steps are done vs remaining
    │     - Any errors or rework that happened
    │     - Preview screenshot (if preview is running)
    │
    ├─ Determine if blocking:
    │     - Autonomy 1-2: all checkpoints are blocking (board must acknowledge)
    │     - Autonomy 3-4: only "build_complete" is blocking
    │     - Autonomy 5: nothing is blocking (purely informational)
    │
    ├─ Post to CEO chat as structured card:
    │     "📋 Sprint 3 Progress — Step 3/6 Complete
    │      Files: 8 created (App.tsx, TodoList.tsx, TodoItem.tsx...)
    │      Status: Implementation on track, 0 errors
    │      Steps remaining: 3 (styling, testing, cleanup)
    │      [View Preview] [Pause Sprint] [Continue]"
    │
    └─ If blocking: pause execution until board responds
       If informational: continue, log that checkpoint was surfaced
```

### Checkpoint Frequency by Autonomy

| Autonomy | Checkpoint Frequency | Blocking? |
|----------|---------------------|-----------|
| Level 1 | Every phase boundary + every 2 Developer steps | All blocking |
| Level 2 | Every phase boundary + after build complete | Build blocking |
| Level 3 | After build complete only | Build blocking |
| Level 4 | After sprint complete only | Informational |
| Level 5 | Sprint summary in CEO chat | Informational |

---

## System 5: Spec Quality Ladder

> From Aman: "Right now you need really detailed specs. As agents get better, the burden decreases."

Every task goes through a refinement pipeline. At each level, the spec becomes more precise. If agents keep failing, the problem might be upstream — vague specs, not bad skills.

### The 5 Quality Levels

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    SPEC QUALITY LADDER                                     │
│                                                                          │
│  L0: BOARD IDEA                                                          │
│    "Build a todo app"                                                    │
│    Quality: vague, unscoped, aspirational                                │
│    Responsibility: Board                                                  │
│    Measured: does the idea exist? (binary)                                │
│                                                                          │
│  L1: CEO STRATEGY                                                        │
│    Vision, phases, scope boundary, team composition, OKRs                │
│    Quality: directional, bounded, but not technical                      │
│    Responsibility: CEO                                                    │
│    Measured: are milestones concrete? is scope bounded?                   │
│                                                                          │
│  L2: CTO PLAN                                                            │
│    Architecture, tech stack, file structure, component breakdown          │
│    Quality: technical, implementable, but not step-by-step              │
│    Responsibility: CTO                                                    │
│    Measured: can a PM derive acceptance criteria from this?               │
│                                                                          │
│  L3: PM ACCEPTANCE                                                       │
│    Definition of done, acceptance criteria, test expectations            │
│    Quality: verifiable, specific, contractual                            │
│    Responsibility: PM                                                    │
│    Measured: can a Developer know when they're done?                     │
│                                                                          │
│  L4: DEVELOPER TASK                                                      │
│    Bounded step with expected files, verification command                │
│    Quality: atomic, executable, measurable                               │
│    Responsibility: Orchestrator (from CTO plan decomposition)           │
│    Measured: does the step have expected outputs and verify criteria?    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Quality Tracking

```typescript
interface SpecQualityScore {
  level: 0 | 1 | 2 | 3 | 4;
  score: number;                            // 0.0 - 1.0
  evaluatedBy: string;                      // "system" | agentRole
  issues: string[];                         // what's missing or vague
  evaluatedAt: string;
}

// Attached to each task
interface TaskSpecQuality {
  taskId: string;
  scores: SpecQualityScore[];               // one per level that was evaluated
  lowestLevel: number;                      // bottleneck level
  recommendation: string | null;            // "CTO plan needs more detail on API routes"
}
```

### Quality Evaluation

After each refinement step, the system evaluates spec quality:

```
CEO produces strategy (L1)
    │
    ▼
Evaluate L1 quality (gpt-4o-mini, ~$0.003):
    "Does this strategy have:
     - Clear scope boundary? (not open-ended)
     - Concrete milestones? (not 'make it good')
     - Realistic sprint targets?"
    
    Score: 0.85 (good — clear scope, concrete milestones)
    │
    ▼
CTO produces plan (L2)
    │
    ▼
Evaluate L2 quality:
    "Does this plan have:
     - Tech stack specified?
     - File structure defined?
     - Component breakdown with responsibilities?
     - Can a PM derive acceptance criteria?"
    
    Score: 0.65 (weak — missing component responsibilities)
    → Flag to CEO: "CTO plan scored 0.65. Missing component details."
    → CEO can request CTO to revise before PM starts.
```

### Quality as Diagnostic

When the Developer fails, trace back to spec quality:

```
Developer fails at task "Implement auth"
    │
    ▼
Check spec quality scores:
    L4 (Developer task): 0.90 — clear step
    L3 (PM acceptance): 0.80 — good criteria
    L2 (CTO plan): 0.55 — vague on auth approach  ← BOTTLENECK
    L1 (CEO strategy): 0.85 — clear direction

    → Root cause: CTO plan didn't specify auth approach
    → Fix: ask CTO to revise plan, not punish Developer
    → This is different from a skill failure (Spec 14)
```

---

## System 6: Token Budget Monitoring

> From Aman: "Single agents fall apart at millions of tokens."

Token consumption per task is tracked not just for cost (Spec 10) but as a **quality signal**. A task consuming 500K+ tokens is likely struggling — the agent is going in circles, retrying, or lost.

### Thresholds

```typescript
const TOKEN_THRESHOLDS = {
  warning: 500_000,       // 500K tokens — flag to CEO
  critical: 1_000_000,    // 1M tokens — force checkpoint
  abort: 2_000_000,       // 2M tokens — kill task, escalate
};
```

### Flow

```
Agent is executing a task
    │
    ├── Running total of tokens consumed (input + output across all LLM calls)
    │
    ├── At 500K tokens (warning):
    │     CEO notified: "Developer has used 500K tokens on 'Implement auth'.
    │                    This is higher than typical. May be struggling."
    │     Action: informational only. CEO adds to checklist.
    │
    ├── At 1M tokens (critical):
    │     Force checkpoint:
    │       1. Save current progress (commit files)
    │       2. Summarize what's done vs what's remaining
    │       3. CEO decides:
    │          a) Continue with more budget → extend token limit
    │          b) Decompose → split remaining work into sub-tasks (→ Spec 19)
    │          c) Abort → mark task failed, escalate to CTO
    │
    └── At 2M tokens (abort):
          Force kill. Task marked failed.
          CTO escalation meeting: "This task consumed 2M tokens. Likely wrong approach."
          Spec quality check: was the task well-defined? (System 5)
```

### Token Tracking

```typescript
interface TaskTokenUsage {
  taskId: string;
  companyId: string;
  sprintId: string;
  agentRole: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  llmCalls: number;
  thresholdReached: "none" | "warning" | "critical" | "abort";
  checkpointedAt: string | null;         // when critical threshold forced checkpoint
  decomposedInto: string[] | null;       // sub-task IDs if decomposed
}
```

---

## Proactive CEO: Strategic Heartbeat Checklist

The CEO's heartbeat checklist (Spec 12) gets expanded:

```typescript
const CEO_STRATEGIC_CHECKLIST: HeartbeatChecklist = {
  role: "ceo",
  items: [
    // === EXISTING (Spec 12) ===
    { key: "pending_approvals",     priority: 1, source: "control_plane" },
    { key: "budget_health",         priority: 2, source: "control_plane" },
    { key: "sprint_health",         priority: 3, source: "control_plane" },
    { key: "board_messages",        priority: 4, source: "control_plane" },

    // === STRATEGIC (this spec) ===
    { key: "roadmap_phase_status",  priority: 2, source: "control_plane" },
    { key: "okr_progress",          priority: 3, source: "control_plane" },
    { key: "sprint_completion",     priority: 1, source: "control_plane" },
    { key: "lifecycle_transition",  priority: 2, source: "control_plane" },
    { key: "autonomy_upgrade",     priority: 3, source: "control_plane" },
    { key: "team_health",           priority: 4, source: "control_plane" },

    // === CHECKPOINTS (new) ===
    { key: "pending_checkpoints",   priority: 1, source: "control_plane" },
    { key: "token_warnings",        priority: 2, source: "control_plane" },
    { key: "spec_quality_flags",    priority: 3, source: "control_plane" },
  ]
};
```

---

## Board Interaction Model

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    BOARD INTERACTION BY AUTONOMY LEVEL                    │
│                                                                          │
│  Level 1 (Supervised):                                                   │
│    Board → "Build a notes app"                                           │
│    CEO → "Here's my roadmap." Board: [Approve]                           │
│    CEO → "Sprint 1 plan ready." Board: [Approve]                         │
│    CEO → "Developer at step 3." Board: [Continue]                        │
│    CEO → "Sprint 1 done." Board: [Approve Sprint 2]                      │
│    → Board involved at every step.                                       │
│                                                                          │
│  Level 3 (Trusted):                                                      │
│    Board → "Build a notes app"                                           │
│    CEO → "Here's my roadmap." Board: [Approve]                           │
│    CEO → "Sprint 1 auto-started. Will report at completion."             │
│    CEO → "Sprint 1 done. Preview looks good. Starting Sprint 2."         │
│    CEO → "Sprint 2 done. Phase 1 complete. Starting Phase 2."            │
│    Board → (optional) "Add dark mode" → CEO adjusts roadmap.             │
│    → Board approves strategy, CEO handles execution.                     │
│                                                                          │
│  Level 5 (Self-Governing):                                               │
│    Board → "Build a notes app"                                           │
│    CEO → "Roadmap approved. Building. Will update weekly."               │
│    CEO → "Sprint 3 complete. OKR 67%. On track."                         │
│    CEO → "Deployed to production. Entering iteration stage."             │
│    → Board is informed, not consulted. CEO runs everything.              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Dashboard: Strategic View

```
┌──────────────────────────────────────────────────────────────────────────┐
│  COMPANY: MinimalNotes Inc.                                              │
│  Stage: 🏗️ building     Autonomy: ⭐⭐⭐ Trusted (3)                      │
│  Vision: "Simple, beautiful collaborative notes"                         │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  ROADMAP                                                        │    │
│  │                                                                 │    │
│  │  Phase 1: Foundation          ██████████████████████  COMPLETE  │    │
│  │    ✅ User auth                Sprint 1-2                       │    │
│  │    ✅ Note CRUD                                                 │    │
│  │    ✅ Basic UI                                                  │    │
│  │                                                                 │    │
│  │  Phase 2: Collaboration       ██████████░░░░░░░░░░░  60%       │    │
│  │    ✅ Real-time sync           Sprint 3-4 (in Sprint 4)        │    │
│  │    ⬜ Shared notebooks                                          │    │
│  │    ✅ Activity feed                                             │    │
│  │                                                                 │    │
│  │  Phase 3: Ship                ░░░░░░░░░░░░░░░░░░░░░  UPCOMING  │    │
│  │    ⬜ Mobile responsive        Sprint 5-6                       │    │
│  │    ⬜ Offline support                                           │    │
│  │    ⬜ Production deploy                                         │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  OKRs                                                           │    │
│  │  Ship collaborative notes app                                   │    │
│  │    KR1: CRUD operational         ████████████████████ 100% ✅   │    │
│  │    KR2: Multi-user collaboration ████████████░░░░░░░░  60% ⚠️   │    │
│  │    KR3: Production deployed      ░░░░░░░░░░░░░░░░░░░░   0% ⬜   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Sprint 4 (active): "Complete collaboration features"                    │
│    Tasks: 5 total | 3 done | 1 in-progress | 1 blocked                  │
│    Budget: $4.20 / $15.00    Tokens: 234K (normal)                       │
│    Spec quality: L1=0.85 L2=0.78 L3=0.82 L4=0.90                        │
│                                                                          │
│  Recent checkpoint: "Build complete — 12 files, preview running"         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

```sql
-- Company roadmaps (extends existing spec)
CREATE TABLE company_roadmaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'draft',
  vision TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'idea',
  autonomy_level INTEGER NOT NULL DEFAULT 1,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_roadmap_active
  ON company_roadmaps(company_id)
  WHERE status IN ('approved', 'active');

-- Roadmap phases
CREATE TABLE roadmap_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_id UUID NOT NULL REFERENCES company_roadmaps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  phase_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming',
  target_sprint_start INTEGER NOT NULL,
  target_sprint_end INTEGER NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE(roadmap_id, phase_order)
);

-- Phase milestones
CREATE TABLE phase_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phase_id UUID NOT NULL REFERENCES roadmap_phases(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence TEXT,
  evaluated_at TIMESTAMPTZ
);

-- Company OKRs
CREATE TABLE company_okrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_id UUID NOT NULL REFERENCES company_roadmaps(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

-- OKR key results
CREATE TABLE key_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  okr_id UUID NOT NULL REFERENCES company_okrs(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  target TEXT NOT NULL,
  current TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'on_track',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roadmap adjustments
CREATE TABLE roadmap_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_id UUID NOT NULL REFERENCES company_roadmaps(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  required_board_approval BOOLEAN NOT NULL,
  approved BOOLEAN,
  diff JSONB NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Sprint checkpoints (new)
CREATE TABLE sprint_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  sprint_id UUID NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  artifacts JSONB NOT NULL DEFAULT '[]',
  board_action_required BOOLEAN NOT NULL DEFAULT false,
  board_response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX idx_checkpoints_sprint ON sprint_checkpoints(company_id, sprint_id);

-- Task token usage (new)
CREATE TABLE task_token_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  company_id UUID NOT NULL,
  sprint_id UUID,
  agent_role TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  threshold_reached TEXT NOT NULL DEFAULT 'none',
  checkpointed_at TIMESTAMPTZ,
  decomposed_into JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_token_usage_task ON task_token_usage(company_id, task_id);

-- Spec quality scores (new)
CREATE TABLE spec_quality_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL,
  company_id UUID NOT NULL,
  sprint_id UUID,
  level INTEGER NOT NULL,
  score REAL NOT NULL,
  evaluated_by TEXT NOT NULL,
  issues JSONB NOT NULL DEFAULT '[]',
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_spec_quality_task ON spec_quality_scores(company_id, task_id);

-- Extend companies table
ALTER TABLE companies ADD COLUMN lifecycle_stage TEXT NOT NULL DEFAULT 'idea';
ALTER TABLE companies ADD COLUMN autonomy_level INTEGER NOT NULL DEFAULT 1;
```

---

## Integration With Other Specs

### Spec 11 (Control Plane)
- Roadmap = first-class Control Plane entity
- OKR updates go through StateMutation pipeline
- All roadmap/autonomy changes recorded in Audit Ledger

### Spec 12 (Heartbeat)
- CEO checklist extended with strategic + checkpoint + token items
- Sprint completion triggers roadmap evaluation
- Lifecycle stage affects heartbeat multiplier

### Spec 13 (Governance)
- Autonomy level determines what needs board approval
- Roadmap structural changes: red blast-radius
- New policies: `roadmap-phase-gate`, `autonomy-gate`, `token-threshold`

### Spec 14 (Self-Evolution)
- Cross-sprint skill transfer runs at sprint boundaries
- Spec quality scores feed into failure attribution (bad spec ≠ bad skill)
- Skills Lead prepares skills for NEXT phase proactively

### Spec 19 (Recursive Execution)
- Token budget critical threshold triggers task decomposition
- Spec 15 decides WHEN to decompose, Spec 19 handles HOW

### Spec 20 (Artifact UX)
- Checkpoint artifacts follow Spec 20 formatting standards
- Sprint summaries, OKR progress, roadmap views are all Spec 20 artifacts

---

## Cost Model

```
Roadmap generation (once):           ~$0.05  (gpt-4o, 2000 tokens)
Sprint evaluation (per sprint):      ~$0.02  (gpt-4o-mini, 800 tokens)
OKR update (per sprint):             ~$0.01  (gpt-4o-mini, 400 tokens)
Roadmap adjustment:                  ~$0.03  (gpt-4o, 1200 tokens)
Spec quality evaluation (per level): ~$0.003 (gpt-4o-mini, 300 tokens)
Checkpoint assembly:                 ~$0.005 (gpt-4o-mini, 400 tokens)
Autonomy evaluation:                 ~$0.002 (pure logic, minimal LLM)

Per-sprint strategic overhead:       ~$0.08
6-sprint company lifecycle:          ~$0.53 total strategic cost

Negligible compared to execution costs ($3-7 per sprint).
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Autonomy levels | 5 levels (1-5) | Granular enough to feel progressive, simple enough to understand. Earned through trust + sprints. |
| Autonomy × lifecycle | Two independent axes | A new company in "building" stage might be autonomy 2. An established company in "idea" stage for a new product might be autonomy 4. They're orthogonal. |
| Checkpoint frequency | Decreases with autonomy | Level 1 needs constant oversight. Level 5 just needs sprint summaries. Trust reduces communication overhead. |
| Spec quality tracking | Score per level, trace back to bottleneck | When Developer fails, is it Developer's fault or vague CTO plan? Spec quality provides the diagnostic. |
| Token monitoring | 3 thresholds (warn/critical/abort) | Warning = informational. Critical = force decision. Abort = safety net. Prevents runaway agents. |
| Board can override | Always | Autonomy is earned, never absolute. Board can pin, downgrade, or pause at any time. |
| Auto-initiation gate | Autonomy level + lifecycle + budget + escalations | Multiple conditions prevent premature auto-initiation. Conservative by default. |

---

## Implementation Phases

### Phase 1: Roadmap + Lifecycle (Foundation)
**Build:** Roadmap types, database tables, roadmap generation, lifecycle stages, CEO strategic checklist, sprint evaluation flow.
**Test:** Create company → CEO generates roadmap → board approves → Sprint 1 completes → CEO evaluates and proposes Sprint 2.
**Effort:** 3 days

### Phase 2: Autonomy Levels
**Build:** Autonomy config, progression logic, autonomy-aware auto-initiation gate, board override controls.
**Test:** Company starts at level 1 → after 1 sprint, propose upgrade to level 2 → board approves → Sprint 2 auto-initiates within approved phase.
**Effort:** 2 days

### Phase 3: Checkpoints
**Build:** Checkpoint types, checkpoint moments in orchestrator, CEO chat cards, blocking/informational logic by autonomy level.
**Test:** During Sprint 1, verify checkpoints surface after CTO plan, after build complete. At autonomy 1, verify execution pauses for board response. At autonomy 3, verify it continues.
**Effort:** 2 days

### Phase 4: Spec Quality Ladder
**Build:** Quality evaluation prompts, score tracking, bottleneck diagnosis, CEO notification on low-quality specs.
**Test:** CEO produces strategy (L1 score: 0.85). CTO produces vague plan (L2 score: 0.55). System flags bottleneck. After Developer failure, trace shows L2 was the issue.
**Effort:** 2 days

### Phase 5: Token Budget Monitoring
**Build:** Token tracking per task, threshold checks in orchestrator, CEO notification, critical checkpoint + decomposition trigger.
**Test:** Agent exceeds 500K tokens → CEO warned. Agent hits 1M → checkpoint forced, progress saved. Agent hits 2M → task aborted, CTO escalation.
**Effort:** 2 days

### Phase 6: Dashboard + Integration
**Build:** Strategic dashboard view (roadmap, OKRs, autonomy badge, checkpoints, spec quality, token usage).
**Test:** Full lifecycle: idea → planning → building (3 sprints) → autonomy upgrade → testing → shipping.
**Effort:** 2 days

**Total: 13 days** (Phases 1-2 = 5 day MVP)

---

## Verification Checklist

### System 1: Roadmap
- [ ] CEO generates roadmap with 2-4 phases, milestones, and OKRs from board brief
- [ ] Board can approve/reject roadmap via CEO chat card
- [ ] Approved roadmap stored in `company_roadmaps` with phases and milestones
- [ ] After sprint completion, CEO evaluates milestones and updates status
- [ ] Phase transitions from "upcoming" → "active" → "completed" tracked
- [ ] OKR key_results.current updated after each sprint
- [ ] Roadmap schedule_shift auto-approved when autonomy >= 3
- [ ] Roadmap structural changes require board approval regardless of autonomy
- [ ] `GET /api/roadmap` returns current roadmap with all phases, milestones, OKRs

### System 2: Lifecycle
- [ ] Company starts at "idea" stage
- [ ] Transitions: idea → planning (CEO proposes roadmap), planning → building (board approves)
- [ ] Each stage has correct heartbeat multiplier
- [ ] Each stage has correct allowed blast-radius
- [ ] Lifecycle badge visible on dashboard
- [ ] CEO behavior string injected into CEO heartbeat context
- [ ] Transition requires minimum autonomy level for target stage

### System 3: Autonomy
- [ ] Company starts at autonomy level 1
- [ ] After 1 sprint + trust >= 0.5 → level 2 upgrade proposed
- [ ] At autonomy < 3: upgrade requires board approval
- [ ] At autonomy >= 3: upgrade is auto-approved
- [ ] Board can pin autonomy level (override auto-progression)
- [ ] Board can downgrade autonomy at any time
- [ ] Auto-initiation gate checks autonomy level (not just trust score)
- [ ] Autonomy level visible on dashboard (star rating)
- [ ] Each autonomy level has correct board approval requirements
- [ ] Autonomy × lifecycle matrix enforced (can't be in "shipping" at level 2)

### System 4: Checkpoints
- [ ] Checkpoint created after CTO plan completion
- [ ] Checkpoint created after PM spec completion
- [ ] Checkpoint created every 3 Developer steps
- [ ] Checkpoint created after build completion
- [ ] Checkpoint includes relevant artifacts (summary, file count, preview state)
- [ ] At autonomy 1: checkpoint blocks execution until board responds
- [ ] At autonomy 3: only build_complete checkpoint blocks
- [ ] At autonomy 5: no checkpoints block (all informational)
- [ ] Board can respond to checkpoint with "continue" or "pause" or feedback
- [ ] Checkpoint cards appear in CEO chat with action buttons

### System 5: Spec Quality
- [ ] CEO strategy evaluated for L1 quality (scope, milestones, clarity)
- [ ] CTO plan evaluated for L2 quality (tech stack, components, implementable)
- [ ] PM spec evaluated for L3 quality (criteria, definition of done, testable)
- [ ] Developer task evaluated for L4 quality (bounded, expected files, verify command)
- [ ] Scores stored in `spec_quality_scores` table
- [ ] Low L2 score flags CTO plan for revision before PM starts
- [ ] On Developer failure, bottleneck analysis traces to lowest-scoring level
- [ ] Spec quality visible on dashboard per sprint

### System 6: Token Monitoring
- [ ] Token usage tracked per task across all LLM calls
- [ ] 500K threshold: CEO notified (informational)
- [ ] 1M threshold: checkpoint forced, progress saved, CEO decides next step
- [ ] 2M threshold: task aborted, CTO escalation meeting created
- [ ] Token usage visible on dashboard per task
- [ ] At critical threshold, CEO can choose: continue / decompose / abort
- [ ] If decomposed, sub-task IDs stored in `decomposed_into`

### End-to-End Scenario
- [ ] Board creates company with brief → autonomy 1, lifecycle "idea"
- [ ] CEO generates roadmap → lifecycle transitions to "planning"
- [ ] Board approves roadmap → lifecycle transitions to "building"
- [ ] Sprint 1 starts (board approves at autonomy 1)
- [ ] Mid-sprint checkpoints surface to board (blocking at level 1)
- [ ] Sprint 1 completes → CEO evaluates → milestones updated
- [ ] Autonomy upgrade to level 2 proposed → board approves
- [ ] Sprint 2 auto-initiates (within approved phase, autonomy 2)
- [ ] Sprint 2 checkpoints are informational (only build_complete blocks)
- [ ] Sprint 3 completes → Phase 1 complete → CEO proposes Phase 2
- [ ] After Sprint 5 → autonomy 3 (auto-upgrade, CEO trust 0.72)
- [ ] Developer task exceeds 500K tokens → CEO warned
- [ ] Spec quality shows L2 = 0.55 → CTO plan flagged for revision
- [ ] Sprint 6 → lifecycle transitions to "shipping"
- [ ] Autonomy 4 required for shipping → CEO proposes, board approves
- [ ] Deploy succeeds → lifecycle "iterating" → company continues autonomously

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `packages/company-runtime/src/roadmap.ts` | Roadmap CRUD, phase transitions, OKR evaluation |
| `packages/company-runtime/src/lifecycle.ts` | Lifecycle stage machine, transitions, stage configs |
| `packages/company-runtime/src/autonomy.ts` | Autonomy levels, progression, gate evaluation |
| `packages/company-runtime/src/strategic-planner.ts` | Sprint proposal, roadmap adjustment, auto-initiation |
| `packages/company-runtime/src/checkpoint-manager.ts` | Checkpoint creation, artifact assembly, blocking logic |
| `packages/company-runtime/src/spec-quality.ts` | Quality evaluation per level, bottleneck diagnosis |
| `packages/company-runtime/src/token-monitor.ts` | Token tracking, threshold checks, decomposition trigger |
| `packages/db/src/schema/roadmap.ts` | All roadmap + checkpoint + token + quality tables |

### Modified Files

| File | Change |
|------|--------|
| `packages/contracts/src/domain.ts` | Add all new types (Roadmap, Lifecycle, Autonomy, Checkpoint, SpecQuality, TokenUsage) |
| `packages/db/src/schema/companies.ts` | Add lifecycle_stage, autonomy_level columns |
| `packages/company-runtime/src/heartbeat-checklist.ts` | Extend CEO checklist with strategic + checkpoint + token items |
| `packages/company-runtime/src/policies/base-policies.ts` | Add roadmap-phase-gate, autonomy-gate, token-threshold policies |
| `apps/api/src/orchestrator.ts` | Integrate sprint evaluation, checkpoints, token monitoring |
| `apps/web/components/` | Strategic dashboard panel |