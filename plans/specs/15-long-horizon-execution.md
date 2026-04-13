# Spec 15: Long-Horizon Strategic Execution

> Status: DRAFT
> Last updated: 2026-04-13
> Depends on: Spec 11 (Control Plane), Spec 12 (Heartbeat), Spec 13 (Governance), Spec 14 (Self-Evolution)
> Enables: Full autonomous company lifecycle

## What This Is

The company today has no future. It can execute a sprint, maybe two. But it has no concept of a roadmap, no OKRs, no multi-sprint milestones, and no way to autonomously decide "Sprint 2 is done, here's what Sprint 3 should be." The board says "build a notes app" and the company builds a notes app. Then it stops. And waits.

This spec gives the company a **strategic time horizon**. The CEO maintains a company roadmap with milestones spanning multiple sprints. Sprints are autonomously initiated when the previous one completes. The company has lifecycle stages (idea → building → scaling). OKRs persist across sprints and get evaluated. The CEO isn't just a message-passer — it's a strategic leader that thinks about where the company is going.

## Why This Matters

```
WITHOUT long-horizon execution:
  Board: "Build a SaaS todo app"
  Sprint 1: Homepage, auth, basic CRUD → completes
  → Company stops. Board must manually initiate Sprint 2.
  → No understanding of what Sprint 2 should even BE.
  → CEO has no roadmap, no OKRs, nothing to aim at beyond "next task."

WITH long-horizon execution:
  Board: "Build a SaaS todo app"
  CEO: "Here's the roadmap I propose:
    Phase 1 (Sprint 1-2): Core product — auth, CRUD, basic UI
    Phase 2 (Sprint 3-4): Growth — real-time sync, collaboration, mobile
    Phase 3 (Sprint 5-6): Revenue — billing, teams, premium features
    OKR: Ship to production within 6 sprints"
  Board: [Approves roadmap]
  Sprint 1: Homepage, auth, basic CRUD → completes
  → CEO evaluates: Phase 1 progress: 50%
  → CEO proposes Sprint 2: "Remaining Phase 1 work + begin UI polish"
  → If trust > 0.9 AND board pre-approved Phase 1: auto-initiate Sprint 2
  → Sprint 2 completes → Phase 1 milestone achieved
  → CEO evaluates: "Phase 1 complete. Proposing Phase 2 Sprint 3."
```

## Company Roadmap

The roadmap is the CEO's strategic artifact. It lives in the Control Plane, persists across sprints, and drives all strategic decisions.

```typescript
// packages/contracts/src/domain.ts — new types

interface CompanyRoadmap {
  id: string;
  companyId: string;
  status: "draft" | "proposed" | "approved" | "active" | "completed" | "abandoned";
  vision: string;                           // one-sentence company vision
  phases: RoadmapPhase[];
  okrs: CompanyOKR[];
  lifecycle: CompanyLifecycleStage;
  approvedAt: string | null;                // when board approved
  createdAt: string;
  updatedAt: string;
}

interface RoadmapPhase {
  id: string;
  name: string;                             // "Phase 1: Core Product"
  description: string;
  order: number;                            // 1, 2, 3...
  status: "upcoming" | "active" | "completed" | "skipped";
  targetSprintRange: [number, number];      // [1, 2] = sprints 1-2
  milestones: PhaseMilestone[];
  completedAt: string | null;
}

interface PhaseMilestone {
  id: string;
  description: string;                      // "Auth system working end-to-end"
  status: "pending" | "achieved" | "missed";
  evidence: string | null;                  // link to artifact that proves it
  evaluatedAt: string | null;
}

interface CompanyOKR {
  id: string;
  objective: string;                        // "Ship production-ready MVP"
  keyResults: KeyResult[];
  timeframe: string;                        // "6 sprints" | "Phase 1-2"
  status: "active" | "achieved" | "missed" | "revised";
}

interface KeyResult {
  id: string;
  metric: string;                           // "All API endpoints tested"
  target: string;                           // "100% endpoint coverage"
  current: string;                          // "60% coverage" (updated per sprint)
  status: "on_track" | "at_risk" | "behind" | "achieved";
  updatedAt: string;
}
```

## Company Lifecycle Stages

Every company progresses through defined stages. The stage determines CEO behavior, sprint frequency, and governor policies.

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
│                                                                           │
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
    heartbeatMultiplier: 0.5,               // CEO beats less frequently
    autoSprintInitiation: false,
    allowedBlastRadius: ["green"],           // read-only phase
  },
  planning: {
    ceoBehavior: "Draft roadmap, define phases, set OKRs, seek board approval",
    heartbeatMultiplier: 1.0,
    autoSprintInitiation: false,
    allowedBlastRadius: ["green"],           // still planning, no execution
  },
  building: {
    ceoBehavior: "Monitor sprint health, evaluate milestones, initiate next sprints",
    heartbeatMultiplier: 1.0,
    autoSprintInitiation: true,             // CEO auto-initiates when roadmap is approved
    allowedBlastRadius: ["green", "yellow"],
  },
  testing: {
    ceoBehavior: "Focus on quality, request test plans, gate shipping on test results",
    heartbeatMultiplier: 1.0,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
  shipping: {
    ceoBehavior: "Coordinate deployment, verify production health, communicate to board",
    heartbeatMultiplier: 2.0,               // CEO beats more frequently during ship
    autoSprintInitiation: false,            // manual gate for deploy
    allowedBlastRadius: ["green", "yellow", "red"],  // deploy is red but allowed in this stage
  },
  iterating: {
    ceoBehavior: "Review metrics, gather feedback signals, propose improvement cycles",
    heartbeatMultiplier: 1.0,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
  scaling: {
    ceoBehavior: "Optimize performance, plan capacity, propose growth features",
    heartbeatMultiplier: 0.75,
    autoSprintInitiation: true,
    allowedBlastRadius: ["green", "yellow"],
  },
};

interface LifecycleStageConfig {
  ceoBehavior: string;
  heartbeatMultiplier: number;       // multiplied by base interval
  autoSprintInitiation: boolean;
  allowedBlastRadius: BlastRadius[];
}
```

## Proactive CEO

The CEO's heartbeat checklist (Spec 12) gets expanded to include strategic leadership.

### CEO Heartbeat: Strategic Checklist

```typescript
const CEO_STRATEGIC_CHECKLIST: HeartbeatChecklist = {
  role: "ceo",
  items: [
    // === EXISTING (Spec 12) ===
    { key: "pending_approvals",     priority: 1, source: "control_plane" },
    { key: "budget_health",         priority: 2, source: "control_plane" },
    { key: "sprint_health",         priority: 3, source: "control_plane" },
    { key: "board_messages",        priority: 4, source: "control_plane" },

    // === NEW: STRATEGIC ===
    {
      key: "roadmap_phase_status",
      priority: 2,
      source: "control_plane",
      // CEO evaluates: "Is the current phase on track? Any milestones at risk?"
    },
    {
      key: "okr_progress",
      priority: 3,
      source: "control_plane",
      // CEO evaluates: "Key results updated? Any metrics falling behind?"
    },
    {
      key: "sprint_completion",
      priority: 1,
      source: "control_plane",
      // CEO checks: "Did the current sprint just complete? If so, evaluate and
      // decide next sprint."
    },
    {
      key: "lifecycle_transition",
      priority: 2,
      source: "control_plane",
      // CEO evaluates: "Should we transition to the next lifecycle stage?
      //   Building → Testing: when all Phase N milestones are met
      //   Testing → Shipping: when all tests pass
      //   Shipping → Iterating: when deployed"
    },
    {
      key: "team_health",
      priority: 4,
      source: "control_plane",
      // CEO reviews: "Any agents with low trust scores? High failure rates?
      //   Consider reassignment or delegation changes."
    },
  ]
};
```

### Sprint Auto-Initiation

When a sprint completes, the CEO autonomously proposes and (potentially) starts the next one:

```
Sprint N completes
      │
      ▼
CEO's next heartbeat:
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
      │     "Tasks: [{title, description, assignee, priority}]"
      │
      ├─ 5. Auto-initiation decision
      │     ┌───────────────────────────────────────────────┐
      │     │ Can auto-initiate if ALL TRUE:                │
      │     │  □ CEO trust score >= 0.9                     │
      │     │  □ Board has approved the current roadmap      │
      │     │  □ Sprint is within a board-approved phase     │
      │     │  □ No budget red flags                        │
      │     │  □ Lifecycle stage allows auto-initiation      │
      │     │  □ No pending board escalations                │
      │     │                                               │
      │     │ If ALL TRUE → auto-start Sprint N+1           │
      │     │ If ANY FALSE → propose to board and wait      │
      │     └───────────────────────────────────────────────┘
      │
      └─ 6. Communicate to board
            "Sprint N complete. Roadmap progress: Phase 1 67%.
             Starting Sprint N+1 (auto-approved). Focus: [...]"
```

```typescript
interface AutoInitiationGate {
  ceoTrustAboveThreshold: boolean;
  roadmapApproved: boolean;
  sprintWithinApprovedPhase: boolean;
  budgetHealthy: boolean;
  lifecycleAllows: boolean;
  noActiveEscalations: boolean;
}

function canAutoInitiate(gate: AutoInitiationGate): boolean {
  return Object.values(gate).every(v => v === true);
}
```

## Roadmap Lifecycle

```
Board: "Build a SaaS todo app with collaboration"
      │
      ▼
CEO (planning stage):
      │
      ├─ Researches: What does a todo app need?
      │
      ├─ Proposes roadmap:
      │
      │   ROADMAP: "Collaborative SaaS Todo App"
      │   ┌─────────────────────────────────────────────────────────────┐
      │   │ Phase 1: Foundation (Sprint 1-2)                           │
      │   │   Milestones:                                              │
      │   │     □ User auth (signup, login, password reset)            │
      │   │     □ Todo CRUD (create, read, update, delete, reorder)    │
      │   │     □ Basic UI (clean, responsive, accessible)             │
      │   │                                                            │
      │   │ Phase 2: Collaboration (Sprint 3-4)                        │
      │   │   Milestones:                                              │
      │   │     □ Real-time sync (Supabase realtime or WebSockets)     │
      │   │     □ Shared lists (invite, permissions)                   │
      │   │     □ Activity feed (who did what)                         │
      │   │                                                            │
      │   │ Phase 3: Polish & Ship (Sprint 5-6)                        │
      │   │   Milestones:                                              │
      │   │     □ Mobile responsive                                    │
      │   │     □ Offline support                                      │
      │   │     □ Production deploy                                    │
      │   │                                                            │
      │   │ OKRs:                                                      │
      │   │   O: Ship collaborative todo app                           │
      │   │     KR1: All CRUD operations functional by Sprint 2        │
      │   │     KR2: Multi-user collaboration working by Sprint 4      │
      │   │     KR3: Deployed to production by Sprint 6                │
      │   └─────────────────────────────────────────────────────────────┘
      │
      ├─ Board: [Approves roadmap] → status = "approved"
      │         CEO lifecycle → "building"
      │
      ├─ Sprint 1 executes (CEO auto-initiates: within approved Phase 1)
      │    Delivers: auth + basic CRUD
      │    CEO evaluates: Phase 1 milestones: 2/3 done
      │
      ├─ Sprint 2 auto-initiates (Phase 1 still in progress)
      │    Delivers: UI polish + remaining CRUD
      │    CEO evaluates: Phase 1 milestones: 3/3 ✓
      │    → Phase 1 complete. Propose Phase 2 transition.
      │
      ├─ Sprint 3 auto-initiates (within approved Phase 2)
      │    ...
      │
      ...and so on until Phase 3 completes or board intervenes.
```

## Strategic Decision Templates

When the CEO faces strategic decisions, it uses structured reasoning:

```typescript
interface StrategicDecision {
  question: string;                     // "Should we start Sprint 3?"
  context: {
    roadmapPhase: RoadmapPhase;
    sprintHistory: SprintSummary[];
    okrStatus: CompanyOKR[];
    budgetRemaining: number;
    agentHealth: AgentHealthSummary[];
  };
  options: StrategicOption[];
  recommendation: string;               // CEO's recommended option
  reasoning: string;                    // structured reasoning
}

interface StrategicOption {
  id: string;
  description: string;
  pros: string[];
  cons: string[];
  costEstimate: number;                 // $ for this sprint
}
```

## CEO Roadmap Adjustment

The roadmap isn't static. The CEO can propose adjustments based on sprint outcomes:

```
Situation: Sprint 2 delivers auth but CRUD has major bugs.
           Phase 1 milestone "Todo CRUD" not achieved.

CEO's heartbeat evaluation:
  "Phase 1 milestone 'Todo CRUD' not achieved. 3 of 5 tasks failed.
   Developer trust: 0.65 (decreasing).
   Options:
     A) Sprint 3 continues Phase 1 (fix CRUD bugs)
     B) Sprint 3 splits: 60% bug fixes, 40% start Phase 2
     C) Revise roadmap: merge Phase 1 and 2 into fewer milestones

   Recommendation: Option A. Ship Phase 1 clean before starting Phase 2.
   Reasoning: Phase 2 (collaboration) depends on working CRUD.
              Starting Phase 2 with broken CRUD will compound failures."

→ CEO proposes roadmap adjustment:
   Phase 1 extended to Sprint 1-3 (was 1-2)
   Phase 2 shifted to Sprint 4-5 (was 3-4)
   Phase 3 shifted to Sprint 6-7 (was 5-6)

→ If adjustment is minor (same phases, shifted dates): CEO auto-approves
→ If adjustment is structural (phases added/removed): requires board approval
```

```typescript
interface RoadmapAdjustment {
  type: "schedule_shift" | "phase_restructure" | "okr_revision" | "scope_reduction";
  description: string;
  reason: string;
  requiresBoardApproval: boolean;       // true for structural changes
  proposedChanges: RoadmapDiff;
}

interface RoadmapDiff {
  phasesModified: Array<{
    phaseId: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
  okrsModified: Array<{
    okrId: string;
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
}
```

## Board Interaction Model

The board's role shifts from "task requester" to "strategic partner":

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    BOARD INTERACTION EVOLUTION                            │
│                                                                          │
│  BEFORE (today):                                                         │
│    Board → "Build a notes app" → Company builds → Done → (silence)       │
│                                                                          │
│  AFTER (this spec):                                                      │
│    Board → "Build a notes app"                                           │
│    CEO → "Here's my proposed roadmap. Phase 1: ... Phase 2: ..."         │
│    Board → [Approves roadmap]                                            │
│    CEO → "Sprint 1 complete. Phase 1 at 50%. Starting Sprint 2."         │
│    Board → (optional) "Looks good, carry on."                            │
│    CEO → "Sprint 2 complete. Phase 1 done. Phase 2 starting."           │
│    CEO → "Sprint 4 complete. All phases done. Deploying."               │
│    CEO → "Deployed! Company entering iterating stage."                  │
│    Board → "Users want dark mode"                                       │
│    CEO → "Adding to roadmap Phase 4: Polish. Starting Sprint 7."        │
│                                                                          │
│  Board is informed, not required (unless auto-init gate fails).          │
│  Board can intervene at any time (override, pause, redirect).            │
│  Board messages are high-priority in CEO's heartbeat checklist.          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Dashboard: Strategic View

```
┌──────────────────────────────────────────────────────────────────────────┐
│  COMPANY: MinimalNotes Inc.        Stage: 🏗️ building                    │
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
│  │                                                                 │    │
│  │  Ship collaborative notes app                                   │    │
│  │    KR1: CRUD operational         ████████████████████ 100% ✅   │    │
│  │    KR2: Multi-user collaboration ████████████░░░░░░░░  60% ⚠️   │    │
│  │    KR3: Production deployed      ░░░░░░░░░░░░░░░░░░░░   0% ⬜   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Sprint 4 (active): "Complete collaboration features"                    │
│    Tasks: 5 total | 3 done | 1 in-progress | 1 blocked                  │
│    Budget used: $4.20 / $15.00 sprint budget                             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Database Changes

```sql
-- Company roadmaps
CREATE TABLE company_roadmaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|proposed|approved|active|completed|abandoned
  vision TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'idea',  -- CompanyLifecycleStage
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active roadmap per company
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
  status TEXT NOT NULL DEFAULT 'upcoming',  -- upcoming|active|completed|skipped
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
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|achieved|missed
  evidence TEXT,
  evaluated_at TIMESTAMPTZ
);

-- Company OKRs
CREATE TABLE company_okrs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_id UUID NOT NULL REFERENCES company_roadmaps(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'   -- active|achieved|missed|revised
);

-- OKR key results
CREATE TABLE key_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  okr_id UUID NOT NULL REFERENCES company_okrs(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  target TEXT NOT NULL,
  current TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'on_track',  -- on_track|at_risk|behind|achieved
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roadmap adjustments (audit trail of changes)
CREATE TABLE roadmap_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_id UUID NOT NULL REFERENCES company_roadmaps(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                     -- schedule_shift|phase_restructure|okr_revision|scope_reduction
  description TEXT NOT NULL,
  reason TEXT NOT NULL,
  required_board_approval BOOLEAN NOT NULL,
  approved BOOLEAN,
  diff JSONB NOT NULL,                    -- RoadmapDiff
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Add lifecycle_stage to companies table
ALTER TABLE companies ADD COLUMN lifecycle_stage TEXT NOT NULL DEFAULT 'idea';
```

## Integration With Other Specs

### Spec 11 (Control Plane)
- Roadmap is a first-class Control Plane entity (loadRoadmap, commitRoadmapUpdate)
- OKR updates go through StateMutation pipeline (typed mutations)
- All roadmap changes recorded in Audit Ledger

### Spec 12 (Heartbeat)
- CEO heartbeat checklist extended with strategic items
- Sprint completion triggers roadmap evaluation
- Lifecycle stage affects heartbeat multiplier (shipping = 2x frequency)

### Spec 13 (Governance)
- Auto-initiation gated by CEO trust score + roadmap approval
- Roadmap structural changes: red blast-radius (requires board approval)
- Lifecycle stage determines allowed blast-radius for all agents
- New policy: `roadmap-phase-gate` — agents can only work on tasks within the active phase

### Spec 14 (Self-Evolution)
- Cross-sprint learning: skill evolution uses roadmap phases as temporal boundary
- Skills Lead reviews whether skills are adequate for the NEXT phase before it starts
- Proactive skill discovery: "Phase 2 requires real-time sync. Do we have WebSocket skills?"

## Initial Roadmap Generation

When the CEO receives the company brief, it generates the first roadmap proposal:

```typescript
async function generateInitialRoadmap(
  brief: string,
  companyId: string,
  agentSession: AgentSession
): Promise<CompanyRoadmap> {
  const prompt = `
You are the CEO of a new company. The board has given you this brief:

"${brief}"

Create a company roadmap with:
1. A clear vision statement (one sentence)
2. 2-4 phases, each with:
   - A name and description
   - Target sprint range (each sprint = 1-3 sessions of work)
   - 2-4 concrete, measurable milestones
3. 1-2 OKRs with 2-3 key results each

Be realistic about scope. Each sprint delivers 3-7 tasks.
A typical project has 4-8 sprints.

Output as structured JSON.
  `;

  const result = await agentSession.chat(prompt);
  return parseRoadmapResponse(result);
}
```

## Lifecycle Transitions

```typescript
const LIFECYCLE_TRANSITIONS: Record<CompanyLifecycleStage, {
  next: CompanyLifecycleStage[];
  condition: string;
}> = {
  idea: {
    next: ["planning"],
    condition: "CEO has analyzed brief and is ready to propose roadmap"
  },
  planning: {
    next: ["building"],
    condition: "Board has approved roadmap"
  },
  building: {
    next: ["testing", "shipping"],
    condition: "All active phase milestones achieved, OR board directs testing phase"
  },
  testing: {
    next: ["shipping", "building"],
    condition: "All tests pass and quality gate met, OR back to building if major bugs found"
  },
  shipping: {
    next: ["iterating"],
    condition: "Successfully deployed to production"
  },
  iterating: {
    next: ["building", "scaling"],
    condition: "Feedback gathered and next iteration planned, OR metrics show scaling needed"
  },
  scaling: {
    next: ["iterating"],
    condition: "Scaling objectives met, return to iteration for next growth cycle"
  }
};
```

## Cost Model

```
Roadmap generation (once):    ~$0.05  (gpt-4o, 2000 tokens)
Sprint evaluation (per sprint): ~$0.02  (gpt-4o-mini, 800 tokens)
OKR update (per sprint):     ~$0.01  (gpt-4o-mini, 400 tokens)
Roadmap adjustment:          ~$0.03  (gpt-4o, 1200 tokens)

Per-sprint strategic overhead: ~$0.06
6-sprint company lifecycle:    ~$0.41 total strategic cost

This is negligible compared to execution costs ($3-7 per sprint).
```

## Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| Auto-initiation gate | All 6 conditions must be TRUE | Conservative. Any red flag means board decides. Trust is earned gradually. |
| Roadmap storage | Normalized tables (phases, milestones, OKRs) | Queryable, auditable. Dashboard can render without parsing JSON. |
| Phase → sprint mapping | Approximate ranges, not exact | Sprints may slip. Rigid mapping causes cascading updates. Ranges allow flexibility. |
| Lifecycle stages | 7 stages | Covers full product lifecycle without being overly granular. Each stage has distinct CEO behavior. |
| OKR evaluation | CEO self-evaluates + board can override | CEO uses structured reasoning. Board can correct if CEO is overly optimistic. Trust score factors in. |
| Roadmap adjustment scope | Minor = auto, structural = board | Small schedule shifts shouldn't block progress. Structural changes (removing phases, adding scope) need board alignment. |// |

## Files Changed

| File | Change |
|------|--------|
| NEW: `packages/company-runtime/src/roadmap.ts` | CompanyRoadmap management, phase transitions, OKR evaluation |
| NEW: `packages/company-runtime/src/lifecycle.ts` | Lifecycle stage machine, transitions, stage-specific behaviors |
| NEW: `packages/company-runtime/src/strategic-planner.ts` | Sprint proposal, roadmap adjustment, auto-initiation logic |
| MODIFY: `packages/contracts/src/domain.ts` | Add CompanyRoadmap, RoadmapPhase, PhaseMilestone, CompanyOKR, KeyResult, CompanyLifecycleStage types |
| NEW: `packages/db/src/schema/roadmap.ts` | company_roadmaps, roadmap_phases, phase_milestones, company_okrs, key_results, roadmap_adjustments tables |
| MODIFY: `packages/db/src/schema/companies.ts` | Add lifecycle_stage column |
| MODIFY: `packages/company-runtime/src/heartbeat-checklist.ts` | Extend CEO checklist with strategic items |
| MODIFY: `packages/company-runtime/src/policies/base-policies.ts` | Add roadmap-phase-gate policy, lifecycle blast-radius policy |
| MODIFY: `apps/api/src/orchestrator.ts` | Integrate sprint completion → roadmap evaluation flow |
| MODIFY: `apps/web/components/` | Strategic dashboard panel (roadmap view, OKR bars, lifecycle badge) |

## Deferred from Spec 11

### 1. `getSnapshotAtVersion()` — Historical Snapshot Reconstruction

Spec 11 defines `ControlPlane.getSnapshotAtVersion(companyId, version)` to reconstruct the company snapshot at any prior version. This requires event-sourcing replay capability — replaying the audit ledger's state mutations from version 0 to the target version. This is primarily useful for debugging, rollback, and CEO strategic retrospectives ("what did the company look like at Sprint 2 start?"). Implement as part of this spec's roadmap-aware state management.

### 2. Roadmap/OKR Mutation Types

Spec 11's `StateMutation` discriminated union does not include types for roadmap/OKR mutations (e.g., `roadmap_create`, `roadmap_phase_transition`, `okr_update`). This spec must extend the mutation union in `packages/contracts/src/events.ts` and add corresponding handlers in `control-plane.ts`'s `applyOneMutation()` switch.
