# CEO Evaluation Engine — The "What to Build Next" Loop

> **Version**: 1.0 | **Date**: 2026-04-05
> **Status**: Approved design
> **Depends on**: CEO chat flow (welcome → hire → decompose → execute)

## Problem

After agents execute a batch of tasks, who decides what to build next? The CEO needs a **continuous decision loop** — not meetings on a timer, but an evaluation engine that runs on events and produces three outputs:

1. **Auto-delegate** tactical work (Layer 1 — no approval needed)
2. **Trigger meetings** when team sync is needed (Layer 2 — coordination)
3. **Surface to board** when direction is uncertain (Layer 3 — strategic approval)

## Core Principle

```
90% → CEO auto-creates next tasks, agents execute
 8% → CEO triggers lightweight sync with 2-3 agents
 2% → CEO surfaces strategic question to board
```

Meetings are an **output** of the evaluation engine, not a separate system.

---

## Architecture

```
                    ┌──────────────────────────────────┐
                    │      CEO EVALUATION ENGINE        │
                    │                                    │
  task.completed ──▶│  1. Assess: quality, learnings    │
  task.blocked ────▶│  2. Check: are we on track?       │
  budget.threshold─▶│  3. Decide: next action           │
  batch.done ──────▶│                                    │
  time.elapsed ────▶│  Outputs:                          │
                    │  ├─ auto_tasks (Layer 1)           │
                    │  ├─ meeting_needed (Layer 2)       │
                    │  └─ board_card (Layer 3)           │
                    └──────────────────────────────────┘
```

---

## Trigger Events

The evaluation engine runs when any of these events fire:

| Event | Source | Why It Matters |
|-------|--------|---------------|
| `task.completed` | Heartbeat marks task done | Batch might be done, next work needed |
| `task.blocked` | Agent status change | May need reassignment or escalation |
| `batch.done` | All tasks in a decomposition complete | Time to plan next sprint |
| `budget.threshold` | Budget at 50%/75%/90% | May need to adjust scope |
| `agent.idle` | Agent finishes and has nothing to do | Waste — needs work assignment |
| `time.elapsed` | Safety net: 6+ hours since last eval | Catch missed events |

**Debounce**: If multiple events fire within 60 seconds, batch them into one evaluation.

---

## Evaluation Input (Compact Snapshot)

The engine builds a compact context snapshot for a single LLM call:

```typescript
interface EvaluationSnapshot {
  // What just happened
  triggerEvent: string;           // "task.completed", "batch.done", etc.
  triggerDetails: string;         // "Engineer completed 'Build auth API'"

  // Current state
  companyGoals: string[];         // Top-level goals
  taskTree: {
    total: number;
    done: number;
    inProgress: number;
    blocked: number;
    todo: number;
    recentCompletions: Array<{ title: string; agent: string; quality: string }>;
    blockers: Array<{ title: string; agent: string; reason: string }>;
  };

  // Team state
  agents: Array<{
    name: string;
    role: string;
    status: "idle" | "running" | "blocked";
    currentTask: string | null;
    tasksCompleted: number;
  }>;

  // Resources
  budgetSpent: number;
  budgetTotal: number;
  burnRate: number;

  // History
  recentDecisions: string[];      // Last 5 CEO decisions
  recentMeetingOutcome: string | null;
}
```

**Token cost**: ~1.5K tokens for snapshot. ~2K for LLM output. **Total per evaluation: ~3.5K tokens.**

---

## Evaluation Output (Structured JSON)

```typescript
interface CeoEvaluation {
  // --- Layer 1: Auto-execute (tactical) ---
  newTasks: Array<{
    title: string;
    description: string;
    assigneeRole: string;          // "engineer", "designer", "cto"
    priority: "critical" | "high" | "medium" | "low";
    reason: string;                // Why this task is needed
  }>;
  taskModifications: Array<{
    issueId: string;
    action: "reprioritize" | "reassign" | "cancel" | "unblock";
    details: string;
  }>;

  // --- Layer 2: Need team sync ---
  meetingNeeded: boolean;
  meetingReason: string | null;    // "Need CTO input on API design approach"
  meetingParticipants: string[];   // Agent roles, not everyone — only relevant ones
  meetingAgenda: string[];         // Specific topics

  // --- Layer 3: Need board decision ---
  boardDecisionNeeded: boolean;
  boardQuestion: string | null;    // "Should we pivot to guest-only auth?"
  boardContext: string | null;     // Evidence/reasoning
  boardOptions: string[] | null;   // ["Keep accounts", "Guest-only", "Both"]

  // --- Always ---
  progressSummary: string;         // "Auth module complete. 3/8 core tasks done."
  confidence: number;              // 0.0 - 1.0: confidence in current direction
  reasoning: string;               // Why these decisions were made
}
```

**Confidence thresholds:**
- `>= 0.7` → proceed autonomously (Layer 1)
- `0.4 - 0.7` → trigger meeting for input (Layer 2)
- `< 0.4` → escalate to board (Layer 3)

---

## Execution of Outputs

### Layer 1: Auto-Execute Tasks

For each `newTasks` entry:
1. Find agent matching `assigneeRole` (or pick least-loaded if multiple)
2. `issueService.create()` with `originKind: "ceo_evaluation"`
3. `queueIssueAssignmentWakeup()` to start agent immediately
4. Post proactive update to CEO chat: "Assigned '[title]' to [Agent]"

For each `taskModifications`:
- `reprioritize` → `issueService.update(issueId, { priority })`
- `reassign` → `issueService.update(issueId, { assigneeAgentId })`
- `cancel` → `issueService.update(issueId, { status: "cancelled" })`
- `unblock` → Decompose blocker into sub-tasks, assign to available agent

### Layer 2: Trigger Meeting

1. `meetingService.create()` with only the relevant participants
2. Inject `meetingAgenda` items
3. Run the meeting pipeline (Collect → Synthesize → Resolve → Execute → Learn)
4. Feed meeting output back into the next evaluation

### Layer 3: Surface to Board

1. `chatService.pushCeoUpdate()` with a `board_decision` card:
```typescript
interface BoardDecisionCardData {
  question: string;
  context: string;
  options: Array<{ label: string; description: string }>;
  confidence: number;
  ceoRecommendation: string;     // CEO's preferred option
}
```
2. Board picks an option → card action handler
3. CEO evaluation runs again with the board's answer as context

---

## How This Replaces Meeting Cron

The meeting scheduler (from MEETING-PIPELINE-PLAN.md) becomes simpler:

**Before**: Cron ticks → assess need → run pipeline
**After**: CEO evaluation triggers → if `meetingNeeded` → run pipeline

The cron's only job is the **safety net**: "Has any evaluation happened in the last 6 hours? If not, force one." This catches edge cases where events are missed.

```
meeting_scheduler.tickMeetingSchedules():
  1. Check: has CEO evaluation run since lastCheckedAt?
  2. If yes → skip (evaluation engine handles meetings)
  3. If no → force CEO evaluation → which may or may not trigger a meeting
```

---

## Interaction Between Evaluation and Meetings

```
Normal flow:
  Task done → CEO evaluates → creates next tasks → agents execute → repeat

When coordination needed:
  Task done → CEO evaluates → confidence low → triggers meeting
       → meeting produces decisions → CEO evaluates with decisions → creates tasks

When strategic:
  Batch done → CEO evaluates → direction unclear → board card
       → board picks option → CEO evaluates with answer → creates tasks
```

The evaluation engine is the **single decision point**. Everything flows through it.

---

## System Prompt for Evaluation LLM

```
You are the CEO of [Company Name], evaluating the current state of the startup.

Your job: Decide what to do next based on what just happened.

Rules:
1. If the next steps are clear and within current direction → create tasks directly (Layer 1)
2. If you need input from specific team members → request a meeting with only those people (Layer 2)
3. If the direction itself is uncertain → escalate to the Board with clear options (Layer 3)

IMPORTANT:
- Prefer action over meetings. Most of the time, you can decide and delegate.
- Only request meetings when you genuinely need another agent's perspective.
- Only escalate to Board when the DIRECTION is uncertain, not just execution details.
- Keep your confidence score honest. 0.8+ means "I know what to do." 0.3 means "I'm guessing."

Output JSON only.
```

---

## Implementation

### New Files
| File | Purpose |
|------|---------|
| `server/src/services/ceo-evaluation.ts` | Core evaluation engine: snapshot builder, LLM call, output executor |

### Modified Files
| File | Change |
|------|--------|
| `server/src/services/heartbeat/index.ts` | On task completion → trigger CEO evaluation |
| `server/src/services/issues.ts` | On status change to "blocked" → trigger CEO evaluation |
| `server/src/services/meeting-scheduler.ts` | Safety net: force evaluation if none in 6 hours |
| `server/src/services/chat.ts` | `pushCeoUpdate()` for proactive messages |
| `packages/shared/src/types/chat.ts` | Add `BoardDecisionCardData` interface |
| `server/src/routes/chat.ts` | Handle `board_decision` card approval → re-trigger evaluation |

### Token Cost Analysis

| Scenario | Evaluations/day | Tokens/eval | Daily cost |
|----------|----------------|-------------|------------|
| Light activity (5 tasks/day) | ~8 | ~3.5K | ~28K tokens |
| Medium activity (20 tasks/day) | ~25 | ~3.5K | ~87K tokens |
| Heavy activity (50 tasks/day) | ~55 | ~3.5K | ~192K tokens |
| Meetings triggered | ~2/day | ~25K each | ~50K tokens |

**Total daily overhead**: 80K - 240K tokens depending on activity. Roughly $0.50-$1.50/day at GPT-4.1-mini rates.

---

## Verification

1. Complete a task → CEO evaluation runs → new task auto-created and assigned
2. Block a task → CEO evaluation runs → reassignment or escalation
3. Complete all tasks in a batch → CEO evaluation → either next batch or meeting/board
4. Force low confidence → meeting triggered with only relevant agents
5. Force very low confidence → board decision card appears in CEO chat
6. Board picks option → CEO re-evaluates with answer → creates tasks
7. Safety net: no events for 6 hours → cron forces evaluation
