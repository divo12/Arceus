# Spec 18: Meeting Pipeline & Structured Coordination

> **Status:** DRAFT v1
> **Last updated:** 2026-04-14
> **Depends on:** Spec 05a (Hippocampus — memory extraction for Learn step), Spec 11 (Control Plane — durable meeting state), Spec 12 (Heartbeat — multi-agent beat coordination), Spec 13 (Governance — decision approval gates)
> **Absorbs:** Deferred 05a Flow C (Meeting Memory Extraction), V3-3 (Meeting Engine)
> **Enables:** Spec 15 (Long-Horizon — sprint evaluation uses meeting outcomes), Spec 17 (Self-Healing — escalation meetings for critical issues)

---

## What This Is

Today agents work in isolation. The CTO makes architecture decisions the Developer never hears about. The Tester finds bugs the PM doesn't know about. The CEO gets board feedback that never reaches the team. Knowledge stays trapped in individual agent memory.

This spec gives the company structured coordination through three mechanisms:

1. **Daily Sync** — mandatory company-wide standup. Everyone knows what everyone else is doing.
2. **Eval-Triggered Meetings** — CEO calls a meeting when a decision needs team input.
3. **Escalation Meetings** — immediate 2-person sync when an agent hits a wall.

All meetings follow the same 5-step DAG pipeline: **Collect → Synthesize → Resolve → Execute → Learn**

Meetings are NOT free-form chat. They're structured artifact DAGs — typed JSON with explicit decisions, action items, and memory extraction. This prevents "dysmemic pressure" where agents optimize for agreement over accuracy.

---

## Why This Matters

```
WITHOUT structured meetings:
  Sprint 2: CTO decides "Use Redis for caching"
  Sprint 2: Developer implements caching with in-memory Map (didn't know about Redis decision)
  Sprint 2: CTO review rejects → 2 rework cycles
  Sprint 3: PM changes scope to add real-time features
  Sprint 3: Developer doesn't know → builds polling instead of WebSockets
  Sprint 3: CTO review rejects → 3 rework cycles
  → Each sprint burns rework because knowledge stays in silos.

WITH structured meetings:
  Sprint 2: Daily sync → CTO shares "Using Redis for caching"
    → ALL agents now know. Developer uses Redis first try. 0 rework.
  Sprint 3: Daily sync → PM shares "Adding real-time features"
    → CTO immediately says "Use Supabase Realtime, not polling"
    → Developer hears it in the same meeting. Builds correctly. 0 rework.
  → Meetings prevent the knowledge gaps that cause rework cycles.
```

---

## The Three Meeting Types

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    THREE MEETING TYPES                                     │
│                                                                          │
│  ┌────────────────────┐  ┌────────────────────┐  ┌──────────────────┐   │
│  │ DAILY SYNC         │  │ EVAL-TRIGGERED     │  │ ESCALATION       │   │
│  │                    │  │                    │  │                  │   │
│  │ Trigger: Cron 1x/d │  │ Trigger: CEO eval  │  │ Trigger: Blocker │   │
│  │ Skip: NEVER        │  │ Skip: If nothing   │  │ Skip: NEVER      │   │
│  │ Who: All active    │  │ Who: Relevant only │  │ Who: Agent + mgr │   │
│  │ Purpose: Context   │  │ Purpose: Decisions │  │ Purpose: Unblock │   │
│  │                    │  │                    │  │                  │   │
│  │ Output:            │  │ Output:            │  │ Output:          │   │
│  │ - Company brief    │  │ - Decisions        │  │ - Unblock action │   │
│  │ - Team updates     │  │ - Task changes     │  │ - Task changes   │   │
│  │ - Blockers found   │  │ - Escalations      │  │ - Escalation up  │   │
│  └────────────────────┘  └────────────────────┘  └──────────────────┘   │
│                                                                          │
│  ALL three types use the same 5-step pipeline:                           │
│  Collect → Synthesize → Resolve → Execute → Learn                        │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

| Type | Trigger | Skip? | Participants | Resolve Step | Output |
|------|---------|-------|-------------|-------------|--------|
| Daily Sync | Cron (1x/day) | Never | All active agents | Only if conflicts found | Company brief + team updates |
| Eval-Triggered | CEO evaluation engine | Yes, if nothing actionable | Relevant agents only | Always (that's why it was triggered) | Decisions + task changes |
| Escalation | Blocker event | Never | Blocked agent + manager | Always | Unblock action + task changes |

---

## The 5-Step Pipeline

Every meeting — regardless of type — flows through the same DAG:

```
MeetingSchedule fires (cron / event / blocker)
    │
    ▼
assessMeetingNeed()  ── skip ──→  increment skipCount, set nextCheckAt
    │ (needed or mandatory)
    ▼
STEP 1: COLLECT     Wake agents, gather structured contributions
    │
    ▼
STEP 2: SYNTHESIZE  LLM detects conflicts, blockers, alignment issues
    │
    ▼
STEP 3: RESOLVE     CEO/facilitator decides on conflicts
    │
    ▼
STEP 4: EXECUTE     Create/modify tasks, escalate to board
    │
    ▼
STEP 5: LEARN       Extract memories into each participant's Hippocampus
```

---

### Step 1: COLLECT

Wake participating agents and gather structured contributions. This is NOT an async bulletin board — agents actively contribute during the meeting beat.

**How it works with Heartbeat (Spec 12):**

The meeting scheduler triggers a **special meeting beat** for each participant. In their beat's Phase 2 (Observe), agents see the meeting contribution request. In Phase 3 (Execute), they produce a structured contribution. Phase 4 serializes it back to the Control Plane.

```typescript
interface MeetingContribution {
  agentId: string;
  agentName: string;
  agentRole: string;
  contribution: {
    whatIDid: string;            // recent accomplishments
    whatImDoing: string;         // current focus
    blockers: string;           // anything blocking progress
    learnings: string;          // insights to share with team
    questionsForTeam: string;   // things they need input on
  };
  submittedAt: string;
}
```

**Collection timeout:** 5 minutes. If an agent doesn't contribute within 5 minutes, the meeting proceeds without them (logged as absent).

**Cost per agent contribution:** ~$0.005 (agent generates structured output in their beat context — no separate LLM call needed, it's part of their normal heartbeat)

---

### Step 2: SYNTHESIZE

A single LLM call analyzes all contributions and detects issues.

```typescript
interface SynthesisOutput {
  conflicts: Array<{
    id: string;
    description: string;
    involvedAgentIds: string[];
    severity: "low" | "medium" | "high";
    suggestedResolution: string;
  }>;
  blockers: Array<{
    id: string;
    description: string;
    reportedByAgentId: string;
    suggestedAction: string;
  }>;
  alignmentIssues: Array<{
    id: string;
    description: string;
    involvedAgentIds: string[];
  }>;
  highlights: Array<{
    type: "completion" | "milestone" | "risk";
    description: string;
    agentId: string;
  }>;
  requiresBoardAttention: boolean;
  boardSummary: string | null;
}
```

**Synthesis prompt for Daily Sync (different from eval-triggered):**

```
Daily Sync focus:
  "Summarize what the team accomplished, what's in progress, what's blocked.
   Detect any misalignment or dependency conflicts between agents.
   Highlight anything the Board should know.
   Produce a companyBrief: 3-5 sentence company status."

Eval-Triggered focus:
  "Detect conflicts, blockers, alignment issues.
   For each conflict, propose a resolution.
   Determine if any decisions need board approval."
```

**LLM:** gpt-4o-mini (~3K tokens, ~$0.003). This is pattern-matching, not creative reasoning.

---

### Step 3: RESOLVE

**Critical optimization:** If zero conflicts + zero blockers + zero alignment issues → **skip entirely** (0 tokens). This is the common case for smooth standups. Most daily syncs have no conflicts.

When needed: CEO (or facilitator) makes decisions on each conflict.

```typescript
interface ResolutionOutput {
  decisions: Array<{
    conflictId: string | null;
    blockerId: string | null;
    decision: string;
    action: "create_task" | "modify_task" | "escalate_to_board" | "note" | "no_action";
    taskAction?: {
      type: "create" | "update" | "reassign";
      title?: string;
      description?: string;
      assigneeRole?: string;
      issueId?: string;
      newStatus?: string;
      newPriority?: string;
    };
    escalation?: {
      question: string;
      context: string;
      severity: "low" | "medium" | "high";
    };
  }>;
}
```

**For Eval-Triggered meetings:** Always runs (that's the whole point).
**For Escalation meetings:** Always runs (the manager must decide how to unblock).
**For Daily Sync:** Only runs if synthesis found issues. Most days: 0 tokens.

**LLM:** gpt-4o (~3K tokens, ~$0.008) — CEO/facilitator reasoning about conflicts. Only when needed.

---

### Step 4: EXECUTE

Pure database operations, zero LLM cost.

| Action | How | Integration |
|--------|-----|------------|
| `create_task` | Create task via orchestrator | Queue heartbeat wakeup for assigned agent |
| `modify_task` | Update task priority/status/assignee | Immediate DB update |
| `escalate_to_board` | Post CEO chat card | Board sees escalation card with approve/reject |
| `note` | Record as meeting event | Logged in audit ledger |
| `no_action` | Skip | Logged only |

All task modifications go through governance gateway (Spec 13). Red-tier modifications require board approval even if decided in a meeting.

---

### Step 5: LEARN (Meeting Memory Extraction)

> Implements deferred Spec 05a Flow C

Build compact transcript from contributions + synthesis + decisions, then extract memories for each participant.

```
Meeting transcript assembled:
  [CTO] "Decided to use Redis for caching. TTL-based invalidation."
  [PM] "Scope updated: adding real-time features in Sprint 3."
  [Developer] "Completed auth API. Starting payment integration."
  [Decision] "Use Supabase Realtime, not polling for real-time."
    │
    ▼
For EACH participant:
  hippocampus.extractFromMeeting({
    agentId: participant.id,
    meetingTranscript: compactTranscript,
    meetingType: "daily_sync",
    extractionMode: "meeting"     // uses MEETING_EXTRACTION_PROMPT from Spec 05a
  })
    │
    ▼
LLM extracts facts with relevant_to field:
  [
    { text: "Using Redis for caching with TTL invalidation",
      type: "static", confidence: 0.9,
      relevant_to: ["cto", "developer"] },
    { text: "Supabase Realtime chosen over polling",
      type: "static", confidence: 0.85,
      relevant_to: ["developer", "tester"] },
    { text: "Payment integration starting next",
      type: "dynamic", confidence: 0.7,
      relevant_to: ["pm", "developer"] },
  ]
    │
    ▼
For each fact, for each relevant agent:
  Run action decision (ADD/UPDATE/DELETE/NONE) against THAT agent's memories
  Store in agent's personal scope
  Decisions with visibility='shared' → accessible to ALL agents
```

**Container:** `meeting:{meetingId}` (matches existing memory container convention)

**Cost per meeting:** ~$0.03-0.05 (one extraction call per meeting + one action decision per fact per agent)

---

## Daily Sync: Mandatory Company-Wide Standup

The daily sync is the heartbeat of shared awareness. It never gets skipped.

### What Makes It Different

| Aspect | Daily Sync | Eval-Triggered | Escalation |
|--------|-----------|----------------|------------|
| Trigger | Cron, 1x/day at configured time | CEO evaluation engine | Blocker event |
| Skip? | **Never** | Yes, if nothing actionable | Never |
| Participants | All active agents | Only relevant agents | Agent + manager |
| Resolve step | Only if conflicts found | Always | Always |
| Primary output | Company brief + shared context | Decisions + task changes | Unblock action |

### Company Brief

After the daily sync, a compact summary is stored and injected into every agent's next beat context:

```typescript
interface DailySyncBrief {
  date: string;
  companyStatus: string;              // "3/8 core tasks done. Auth complete, payments in progress."
  teamUpdates: Array<{
    agentRole: string;
    summary: string;                  // "Completed auth API, starting payment integration"
  }>;
  activeBlockers: string[];           // "Payment gateway sandbox access pending"
  upcomingDependencies: string[];     // "Frontend needs API docs from CTO before UI work"
  decisionsFromMeeting: string[];     // "Use Supabase Realtime, not polling"
}
```

**Injection point:** Every agent's heartbeat Phase 1 (Context Assembly) includes the latest daily sync brief. This means even agents who weren't paying attention during the sync still get the shared context.

### Daily Sync Summary Card

Posted to CEO chat so the board sees what happened:

```typescript
interface DailySyncCardData {
  meetingId: string;
  date: string;
  participantCount: number;
  companyBrief: string;
  teamUpdates: Array<{ role: string; summary: string }>;
  blockerCount: number;
  conflictsDetected: number;
  decisionsNeeded: boolean;
}
```

Card type: `"daily_sync_summary"` — surfaces in CEO chat.

### Auto-Creation

Daily sync is auto-created when a company has 2+ active agents:

```typescript
async function ensureDailySyncExists(companyId: string) {
  const existing = await findSchedule(companyId, "daily_sync");
  if (existing) return;

  const activeAgents = await getActiveAgents(companyId);
  if (activeAgents.length < 2) return;

  await createSchedule({
    companyId,
    type: "daily_sync",
    title: "Daily Company Sync",
    cronExpression: "0 9 * * *",        // 9 AM daily, configurable
    participantAgentIds: activeAgents.map(a => a.id),
    facilitatorAgentId: getCeoAgentId(companyId),
    conditionalCheckEnabled: false,      // NEVER skip
    enabled: true,
  });
}
```

---

## Eval-Triggered Meetings

CEO calls a meeting when a specific decision needs team input. These can be skipped if nothing is actionable (tracked via meeting debt).

### assessMeetingNeed() — Pure SQL, Zero LLM Cost

```typescript
async function assessMeetingNeed(schedule: MeetingSchedule): Promise<boolean> {
  const signals = {
    blockedTasks: await countBlockedTasks(schedule.companyId, schedule.participantAgentIds),
    completedSinceLastCheck: await countTasksCompletedSince(schedule.companyId, schedule.lastCheckedAt),
    createdSinceLastCheck: await countTasksCreatedSince(schedule.companyId, schedule.lastCheckedAt),
    pendingEscalations: await countPendingEscalations(schedule.companyId),
    consecutiveSkips: schedule.skipCount,
  };

  // Decision logic:
  if (signals.consecutiveSkips >= schedule.config.maxConsecutiveSkips) return true;  // force sync
  if (signals.blockedTasks > 0) return true;
  if (signals.pendingEscalations > 0) return true;
  if (schedule.config.skipIfNoTaskChanges
      && signals.completedSinceLastCheck === 0
      && signals.createdSinceLastCheck === 0) return false;  // skip
  return true;
}
```

### Meeting Debt

When meetings get skipped, "debt" accumulates. After 3 consecutive skips (configurable), the next meeting is forced regardless of signals. This prevents long periods of silence.

---

## Escalation Meetings

Immediate 2-person sync when an agent hits a wall. No scheduling delay — triggers on the next beat.

### Escalation Flow

```
Agent hits unresolvable blocker during task execution
    │
    ▼
Agent creates escalation request:
  { blockerId, description, attemptedActions, manager: agent.reportsTo }
    │
    ▼
Escalation meeting created with 2 participants:
  - Blocked agent
  - Direct manager (from org hierarchy)
    │
    ▼
Pipeline runs:
  Step 1 (Collect): Both agents contribute context
  Step 2 (Synthesize): Characterize the blocker
  Step 3 (Resolve): Manager decides resolution
  Step 4 (Execute): Task modified / reassigned / escalated further
  Step 5 (Learn): Both agents store learnings
    │
    ▼
If manager can't resolve:
  Escalate UP the hierarchy: Agent → Manager → Manager's Manager → CEO → Board
  Each level gets one beat to resolve before escalating further.
```

### Escalation Chain

```
Developer blocked on "Payment API unclear"
  → Escalation meeting: Developer + CTO
  → CTO: "Use Stripe. Here's the pattern." → RESOLVED

Developer blocked on "Need production database credentials"
  → Escalation meeting: Developer + CTO
  → CTO can't provide creds → escalate to CEO
  → Escalation meeting: CTO + CEO
  → CEO: "Board needs to approve prod access" → ESCALATE TO BOARD
  → CEO posts approval card in chat
```

---

## Meeting Scheduling Infrastructure

### MeetingSchedule Type

```typescript
interface MeetingSchedule {
  id: string;
  companyId: string;
  type: "daily_sync" | "eval_triggered" | "escalation";
  title: string;
  cronExpression: string;                // "0 9 * * *" for daily at 9 AM
  timezone: string;                      // default "UTC"
  participantAgentIds: string[];
  facilitatorAgentId: string;            // CEO for standups, manager for escalations
  conditionalCheckEnabled: boolean;      // true = can skip, false = always run
  enabled: boolean;
  lastCheckedAt: string | null;
  lastMeetingId: string | null;
  nextCheckAt: string | null;
  skipCount: number;                     // consecutive skips (reset on meeting run)
  totalRuns: number;
  config: MeetingScheduleConfig;
}

interface MeetingScheduleConfig {
  maxConsecutiveSkips: number;            // default 3
  skipIfNoBlockers: boolean;             // default true
  skipIfNoTaskChanges: boolean;          // default true
  collectionTimeoutMs: number;           // default 300000 (5 min)
}
```

### Meeting Record

```typescript
interface Meeting {
  id: string;
  companyId: string;
  scheduleId: string | null;             // null for ad-hoc escalations
  type: "daily_sync" | "eval_triggered" | "escalation";
  title: string;
  status: "scheduled" | "collecting" | "synthesizing" | "resolving" | "executing" | "learning" | "completed";
  facilitatorAgentId: string;
  participantAgentIds: string[];
  contributions: MeetingContribution[];
  synthesis: SynthesisOutput | null;
  resolutions: ResolutionOutput | null;
  brief: DailySyncBrief | null;          // only for daily_sync type
  healthSnapshot: MeetingHealthSnapshot;
  createdAt: string;
  completedAt: string | null;
}
```

### Meeting Health Metrics

```typescript
interface MeetingHealthSnapshot {
  meetingId: string;
  scheduleId: string | null;
  pipelineDurationMs: number;
  contributionCount: number;
  conflictCount: number;
  blockerCount: number;
  decisionsCount: number;
  tasksCreated: number;
  tasksModified: number;
  escalationsCreated: number;
  totalTokensUsed: number;
  skippedBefore: number;                 // how many skips preceded this meeting
}
```

Track over time:
- **Meeting Debt:** `skipCount / maxConsecutiveSkips` — high = thresholds too aggressive
- **Decision Rate:** `decisionsCount / meetingCount` — low = meetings not producing value
- **Escalation Frequency:** trend of escalations over time
- **Pipeline Efficiency:** tokens per meeting — monitor for cost regression

---

## Heartbeat Integration

Meetings are NOT a separate execution path. They're a **special beat type** within the heartbeat system.

### How Meeting Beats Work

```
Meeting scheduler fires → "daily_sync due"
    │
    ▼
For each participant agent:
  Trigger special beat with:
    beatTrigger: "meeting"
    meetingId: "meeting_abc123"
    meetingType: "daily_sync"
    │
    ▼
Agent's beat Phase 2 (Observe):
  Agent sees: "You're in a Daily Sync meeting. Contribute your update."
  Context includes: recent tasks, current focus, any blockers
    │
    ▼
Agent's beat Phase 3 (Execute):
  Agent produces structured MeetingContribution
  (Not a tool call — a structured output in the beat response)
    │
    ▼
Agent's beat Phase 4 (Serialize):
  Contribution stored in meeting record
  Agent returns to normal heartbeat schedule
    │
    ▼
After all contributions collected (or timeout):
  Synthesis → Resolve → Execute → Learn
  (These run as system operations, not agent beats)
```

### CEO as Synthesizer

The synthesis and resolve steps run in the **CEO's beat**, not as a separate system. The CEO's Phase 2 sees all contributions. Phase 3 synthesizes and resolves. This makes the CEO the natural meeting facilitator, consistent with the "CEO as company voice" principle.

---

## Database Schema

```sql
-- Meeting schedules
CREATE TABLE meeting_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  participant_agent_ids JSONB NOT NULL DEFAULT '[]',
  facilitator_agent_id UUID,
  conditional_check_enabled BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_meeting_id UUID,
  next_check_at TIMESTAMPTZ,
  skip_count INTEGER NOT NULL DEFAULT 0,
  total_runs INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{"maxConsecutiveSkips": 3, "skipIfNoBlockers": true, "skipIfNoTaskChanges": true, "collectionTimeoutMs": 300000}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_company ON meeting_schedules(company_id)
  WHERE enabled = true;

-- Meeting records
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  schedule_id UUID REFERENCES meeting_schedules(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  facilitator_agent_id UUID,
  participant_agent_ids JSONB NOT NULL DEFAULT '[]',
  contributions JSONB NOT NULL DEFAULT '[]',
  synthesis JSONB,
  resolutions JSONB,
  brief JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_meeting_company ON meetings(company_id, created_at DESC);

-- Meeting health snapshots
CREATE TABLE meeting_health_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  meeting_id UUID NOT NULL REFERENCES meetings(id),
  schedule_id UUID REFERENCES meeting_schedules(id),
  pipeline_duration_ms INTEGER NOT NULL,
  contribution_count INTEGER NOT NULL,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  decisions_count INTEGER NOT NULL DEFAULT 0,
  tasks_created INTEGER NOT NULL DEFAULT 0,
  tasks_modified INTEGER NOT NULL DEFAULT 0,
  escalations_created INTEGER NOT NULL DEFAULT 0,
  total_tokens_used INTEGER NOT NULL DEFAULT 0,
  skipped_before INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Company documents are a separate concern (PG-6) — not in this spec
```

---

## Integration Map

```
Spec 05a (Hippocampus)
  └── Step 5 (Learn): meeting memory extraction using existing extraction pipeline
      Implements deferred 05a Flow C (Meeting Memory Extraction)

Spec 12 (Heartbeat)
  ├── Meeting beats: special beat type with meetingTrigger context
  ├── CEO synthesizes in their beat (not a separate system call)
  └── Meeting scheduler ticks alongside heartbeat tick

Spec 13 (Governance)
  ├── Task modifications from Step 4 go through governance gateway
  └── Red-tier meeting decisions require board approval

Spec 14 (Self-Evolution)
  └── Meeting patterns feed into PatternLearner
      (recurring meeting topics → potential skill gaps)

Spec 15 (Long-Horizon)
  ├── Sprint evaluation uses meeting outcomes
  ├── CEO strategic checklist includes pending meeting results
  └── Roadmap adjustments can be proposed in meetings

Spec 16 (Memory Consolidation)
  └── Meeting memories get Hebbian links (decisions co-accessed → linked)
      Shared decisions get highest retention (emotional valence from board impact)

Spec 17 (Self-Healing)
  └── Escalation meetings triggered by self-healing blocker events
      Critical issues → immediate escalation meeting → resolution
```

---

## Cost Model

```
Daily Sync (5 agents, no conflicts):
  Step 1 (Collect):     ~$0.025  (5 agents × $0.005 per contribution in beat)
  Step 2 (Synthesize):  ~$0.003  (gpt-4o-mini, pattern matching)
  Step 3 (Resolve):     ~$0.00   (skipped — no conflicts)
  Step 4 (Execute):     ~$0.00   (pure DB)
  Step 5 (Learn):       ~$0.03   (extraction + action decisions)
  Total:                ~$0.06

Daily Sync (5 agents, WITH conflicts):
  Steps 1-2:            ~$0.028
  Step 3 (Resolve):     ~$0.008  (CEO reasoning on conflicts)
  Steps 4-5:            ~$0.03
  Total:                ~$0.07

Eval-Triggered (3 agents):
  Total:                ~$0.05

Escalation (2 agents):
  Total:                ~$0.03

Per-sprint meeting overhead:
  5 daily syncs + 1 eval-triggered + 0-2 escalations
  Total: ~$0.33-0.50 per sprint
```

---

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Pipeline model | Structured DAG (not multi-turn LLM chat) | Prevents dysmemic pressure. Agents optimize for schema output, not conversational agreement. |
| Daily sync | Never skip | Shared awareness matters even when nothing seems urgent. Prevents knowledge drift. |
| Collect = active beats | Agents wake and contribute (not async bulletin) | Fresh, current contributions. Not stale pre-written updates. |
| CEO as synthesizer | CEO beat handles synthesis + resolve | Natural facilitator. Consistent with "CEO as company voice." |
| assessMeetingNeed | Pure SQL, zero LLM | Cheap to check frequently. LLM only used when meeting actually runs. |
| Meeting debt | Force after 3 skips | Prevents long silence periods. Configurable per company. |
| Memory extraction | Per-participant with relevant_to routing | Not all facts matter to all agents. Targeted extraction is more useful. |

---

## Implementation Phases

### Phase 1: Meeting Scheduling + Pipeline Framework
**Build:** MeetingSchedule types, scheduler tick, pipeline orchestrator (Collect → Synthesize → Resolve → Execute → Learn stubs), assessMeetingNeed().
**Test:** Create daily sync schedule → verify it fires → verify agents are woken.
**Effort:** 3 days

### Phase 2: Collect + Synthesize
**Build:** Meeting contribution type, agent beat integration (meeting trigger), CEO synthesis with LLM.
**Test:** 3 agents contribute → synthesis detects a conflict between CTO and Developer.
**Effort:** 3 days

### Phase 3: Resolve + Execute
**Build:** CEO resolution flow, task creation/modification via governance, escalation to board.
**Test:** Conflict resolved → task created → governance approves → agent assigned.
**Effort:** 2 days

### Phase 4: Learn (Meeting Memory Extraction)
**Build:** Meeting transcript assembly, hippocampus extraction per participant, shared decision routing.
**Test:** Meeting decides "Use Redis" → Developer's memory now contains this fact → retrieval confirms.
**Effort:** 2 days

### Phase 5: Escalation Meetings
**Build:** Escalation trigger from blocker events, 2-person meeting flow, hierarchy-based escalation chain.
**Test:** Developer blocked → escalation meeting with CTO → CTO resolves → task unblocked. CTO can't resolve → escalates to CEO → board.
**Effort:** 2 days

### Phase 6: Dashboard + Health Metrics
**Build:** Meeting dashboard (schedule list, health metrics, recent meetings), meeting debt tracking, pipeline efficiency monitoring.
**Test:** Dashboard shows meeting history, health metrics, escalation trends.
**Effort:** 2 days

**Total: 14 days** (Phases 1-3 = 8 day MVP)

---

## Verification Checklist

### Pipeline Framework
- [ ] Meeting schedules stored in `meeting_schedules` table
- [ ] Scheduler tick runs every minute alongside heartbeat tick
- [ ] Daily sync auto-created when company has 2+ active agents
- [ ] assessMeetingNeed() correctly detects: blocked tasks, task changes, consecutive skips
- [ ] Skipped meetings increment skipCount; forced after maxConsecutiveSkips

### Step 1: Collect
- [ ] Meeting beat triggered for each participant agent
- [ ] Each agent produces structured MeetingContribution in their beat
- [ ] Contributions stored in meeting record
- [ ] 5-minute timeout: meeting proceeds without absent agents (logged)

### Step 2: Synthesize
- [ ] LLM detects conflicts between agent contributions
- [ ] LLM detects blockers reported by agents
- [ ] LLM produces highlights (completions, milestones, risks)
- [ ] Daily sync produces companyBrief (3-5 sentence status)
- [ ] Synthesis cost under $0.005

### Step 3: Resolve
- [ ] Skipped when zero conflicts + zero blockers (daily sync)
- [ ] Always runs for eval-triggered and escalation meetings
- [ ] CEO/facilitator produces decisions for each conflict
- [ ] Decisions include action type: create_task, modify_task, escalate_to_board, note

### Step 4: Execute
- [ ] Task creation goes through governance gateway (Spec 13)
- [ ] Task modification applied immediately
- [ ] Escalations surface as CEO chat cards with approve/reject buttons
- [ ] All meeting events logged in audit ledger

### Step 5: Learn
- [ ] Meeting transcript assembled from contributions + synthesis + decisions
- [ ] Hippocampus extraction runs per participant (05a Flow C)
- [ ] Facts routed to relevant agents by `relevant_to` field
- [ ] Shared decisions stored with `visibility = 'shared'`
- [ ] Shared decisions stored with visibility='shared' in memory

### Daily Sync
- [ ] Runs daily at configured time, never skipped
- [ ] All active agents participate
- [ ] Company brief produced and stored
- [ ] Company brief injected into every agent's next beat context
- [ ] Summary card posted to CEO chat

### Escalation
- [ ] Blocker event triggers immediate escalation meeting
- [ ] Only 2 participants: blocked agent + direct manager
- [ ] Escalation chain: agent → manager → manager's manager → CEO → board
- [ ] Each level gets one beat to resolve before escalating further

### End-to-End Scenario
- [ ] Company has 5 agents. Daily sync at 9 AM.
- [ ] Developer contributed: "Completed auth API, starting payments"
- [ ] CTO contributed: "Architecture review done. Use Stripe for payments."
- [ ] PM contributed: "Scope confirmed: payments + checkout in Sprint 3"
- [ ] Synthesis: no conflicts, 1 highlight (auth complete)
- [ ] Resolve: skipped (no conflicts)
- [ ] Learn: "Use Stripe for payments" extracted → stored in Developer + PM memory
- [ ] Company brief: "Auth complete. Payments starting. Stripe confirmed."
- [ ] Board sees summary card in CEO chat
- [ ] Next beat: Developer's context includes "Use Stripe" from daily sync brief
- [ ] 2 PM: Developer blocked on Stripe sandbox → escalation meeting with CTO
- [ ] CTO provides API key → Developer unblocked → task continues

---

## Files

### New Files

| File | Purpose |
|------|---------|
| `packages/company-runtime/src/meeting-scheduler.ts` | Schedule tick, assessMeetingNeed, meeting creation |
| `packages/company-runtime/src/meeting-pipeline.ts` | 5-step pipeline orchestrator |
| `packages/company-runtime/src/meeting-synthesis.ts` | LLM synthesis prompts and output parsing |
| `packages/company-runtime/src/meeting-resolution.ts` | CEO resolution flow, task action execution |
| `packages/company-runtime/src/meeting-memory.ts` | Step 5 Learn — transcript assembly, hippocampus extraction |
| `packages/db/src/schema/meetings.ts` | meeting_schedules, meetings, meeting_health_snapshots tables |

### Modified Files

| File | Change |
|------|--------|
| `packages/contracts/src/domain.ts` | Add MeetingSchedule, Meeting, MeetingContribution, SynthesisOutput, ResolutionOutput, DailySyncBrief, CompanyDocument types |
| `packages/company-runtime/src/heartbeat-checklist.ts` | Add meeting-related items to all agent checklists |
| `apps/api/src/server.ts` | Add meeting scheduler tick alongside heartbeat tick |
| `apps/api/src/orchestrator.ts` | Integrate escalation meeting trigger from blocker events |
| `packages/hippocampus/src/engines/extractor.ts` | Add MEETING_EXTRACTION_PROMPT (05a Flow C) |