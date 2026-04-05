# Plan: Meeting Pipeline — Structured DAG with Conditional Triggers + Daily Sync

> **Version**: 1.1 | **Date**: 2026-04-05
> **Status**: Approved design — ready for implementation
> **Depends on**: CEO welcome + hire + decompose flow (separate plan)

## Context

After the CEO welcome → hire → decompose → execute flow is working, the next feature is **meetings** — the mechanism for agents to sync, surface blockers, resolve conflicts, and learn from each other.

The current meeting system has solid CRUD (DB schema, service, routes, UI, wakeup integration) but zero orchestration — meetings are created manually and nothing happens automatically. We need a pipeline that makes meetings genuinely useful for autonomous agents.

**Design choices:**
- **Pipeline model**: Meetings are structured DAGs (Collect → Synthesize → Resolve → Execute → Learn), not multi-turn LLM conversations
- **Conditional triggers**: Skip meetings when nothing actionable (track "meeting debt" to force sync after N skips)

---

## Two Meeting Types with Different Purposes

### 1. Daily Sync (mandatory, fixed cadence)
**Purpose:** Shared context. Everyone knows what everyone else is doing.
- Runs once per day at a configured time
- **Never skipped** — even if nothing seems actionable, shared awareness matters
- Agents **actively contribute** (woken up, submit updates)
- Output: company-wide status brief injected into all agents' next context
- Surfaces summary card to board in CEO chat

### 2. Evaluation-Triggered Meetings (conditional, event-driven)
**Purpose:** Decision-making. CEO needs team input on a specific question.
- Triggered by CEO Evaluation Engine when `meetingNeeded = true`
- Only relevant agents participate (not everyone)
- Can be skipped if nothing actionable (track meeting debt)
- Output: decisions, task modifications, escalations

### 3. Escalation Meetings (reactive, immediate)
**Purpose:** Unblock. Agent hits a wall and needs manager help.
- Triggered by blocker events
- Only 2 participants: blocked agent + their manager
- Never skipped

```
Meeting Types Comparison:

| Type          | Trigger        | Skip? | Participants    | Output                    |
|---------------|----------------|-------|-----------------|---------------------------|
| Daily Sync    | Cron (1x/day)  | Never | All active      | Context brief + summary   |
| Eval-Triggered| CEO eval engine| Yes   | Relevant only   | Decisions + task changes   |
| Escalation    | Blocker event  | Never | Agent + manager | Unblock + task changes     |
```
- **Collect at meeting time**: Wake agents and gather fresh updates (not async bulletin board)
- **Board approves major decisions**: Task mods auto-execute, strategic decisions surface as CEO chat cards

---

## Architecture

```
MeetingSchedule (cron fires)
    │
    ▼
assessMeetingNeed()  ── skip ──→  increment skipCount, set nextCheckAt
    │ (needed)
    ▼
STEP 1: Collect       Wake agents, gather contributions     [N agent wakeups, ~2.5K tokens each]
    │
    ▼
STEP 2: Synthesize    1 LLM call: detect conflicts/blockers [~3K tokens, use gpt-4.1-mini]
    │
    ▼
STEP 3: Resolve       CEO decides on conflicts               [0 tokens if no conflicts, ~3K if conflicts]
    │
    ▼
STEP 4: Execute       Create/modify tasks, escalate to board [0 tokens, pure DB]
    │
    ▼
STEP 5: Learn         Extract learnings into agent memory    [N hippocampus extract calls]
```

**Total cost per standup (5 agents, no conflicts): ~25K tokens. With conflicts: ~28K tokens.**

---

## What Already Exists (Reuse These)

| Component | File | What It Does |
|-----------|------|-------------|
| Meeting CRUD | `server/src/services/meetings.ts` (605 lines) | Full lifecycle: create → start → complete, contributions, events |
| DB Schema | `packages/db/src/schema/meetings.ts` | meetings, meetingParticipants, meetingEvents tables with indexes |
| Routes | `server/src/routes/meetings.ts` (282 lines) | Full CRUD + escalation + lifecycle endpoints |
| Wakeup | `server/src/services/meeting-wakeup.ts` | `queueMeetingParticipantWakeup()` wakes agents on meeting start |
| Context Injection | `server/src/services/meeting-context.ts` | `buildMeetingContextForRun()` injects meeting context into agent runs |
| Memory Extraction | `server/src/routes/memory.ts:454-489` | Manual `POST /agents/:id/memory/extract-meeting` endpoint |
| Hippocampus Bridge | `server/src/services/hippocampus-bridge.ts` | `extract()` for LLM-driven fact extraction |
| Routine Scheduler | `server/src/services/routines.ts` | `tickScheduledTriggers()` — pattern to follow for meeting scheduler |
| Types/Validators | `packages/shared/src/types/meeting.ts` | Meeting types, statuses, event kinds, contribution schema |
| Frontend | `ui/src/pages/Meetings.tsx` + `MeetingDetail.tsx` | Meeting list + detail views with contribution/event display |

---

## Implementation Steps

### Step 1: DB Schema — `meeting_schedules` + `meeting_health_snapshots`

**New file:** `packages/db/src/schema/meeting-schedules.ts`

**`meeting_schedules`** table:

| Field | Type | Description |
|-------|------|-------------|
| `id` | uuid PK | Unique identifier |
| `companyId` | uuid FK → companies | Parent company |
| `type` | text | "standup" \| "sync" \| "escalation" |
| `title` | text | e.g. "Daily Engineering Standup" |
| `cronExpression` | text | e.g. "0 */4 * * *" (every 4 hours) |
| `timezone` | text | Default "UTC" |
| `participantAgentIds` | jsonb string[] | Which agents participate |
| `facilitatorAgentId` | uuid FK → agents | Who runs the meeting (CEO for standups) |
| `conditionalCheckEnabled` | boolean | Default true — skip if nothing actionable |
| `enabled` | boolean | Default true |
| `lastCheckedAt` | timestamp | Last assessment time |
| `lastMeetingId` | uuid FK → meetings | Most recent meeting created |
| `nextCheckAt` | timestamp | When to check next |
| `skipCount` | int | Consecutive skips (reset on meeting run) |
| `totalRuns` | int | Total meetings created from this schedule |
| `config` | jsonb | `{ maxConsecutiveSkips: 3, skipIfNoBlockers: true, skipIfNoTaskChanges: true }` |

**`meeting_health_snapshots`** table:

| Field | Type | Description |
|-------|------|-------------|
| `id` | uuid PK | Unique identifier |
| `companyId` | uuid | Company |
| `meetingId` | uuid FK → meetings | Which meeting |
| `scheduleId` | uuid FK → meeting_schedules | Which schedule triggered it |
| `pipelineDurationMs` | int | Total pipeline runtime |
| `contributionCount` | int | How many agents contributed |
| `conflictCount` | int | Conflicts detected |
| `blockerCount` | int | Blockers detected |
| `decisionsCount` | int | Decisions made |
| `tasksCreated` | int | Tasks created from decisions |
| `tasksModified` | int | Tasks modified from decisions |
| `escalationsCreated` | int | Escalations surfaced to board |
| `totalTokensUsed` | int | Total LLM tokens consumed |
| `skippedBefore` | int | How many skips preceded this meeting |

**Also modify:** `packages/db/src/schema/index.ts` — export new tables

---

### Step 2: Meeting Scheduler Service

**New file:** `server/src/services/meeting-scheduler.ts`

#### `assessMeetingNeed(schedule)` — Pure SQL, zero LLM cost

Checks these signals:

| Signal | Query | Threshold |
|--------|-------|-----------|
| Blocked issues | `SELECT count(*) FROM issues WHERE status='blocked' AND assignee_agent_id = ANY(participantIds)` | > 0 → needed |
| Tasks completed since last check | Count issues where status changed to 'done' since lastCheckedAt | > 0 → updates to share |
| Tasks created since last check | Count new issues since lastCheckedAt | > 0 → updates to share |
| Pending escalations | Count unresolved escalation meeting events for participants | > 0 → needed |
| Consecutive skips | `skipCount >= config.maxConsecutiveSkips` | >= 3 → force meeting |

**Decision logic:**
```
IF skipCount >= maxConsecutiveSkips → NEEDED (force sync)
IF blockerCount > 0 → NEEDED
IF pendingEscalations > 0 → NEEDED
IF skipIfNoTaskChanges AND zero task changes → SKIP
ELSE → NEEDED
```

#### `tickMeetingSchedules(now)` — follows `routines.tickScheduledTriggers()` pattern

1. Query schedules where `nextCheckAt <= now AND enabled = true`
2. Claim with optimistic lock (update `nextCheckAt` to next cron tick)
3. Run `assessMeetingNeed()` for each
4. If needed: call `executeMeetingPipeline()`, reset `skipCount`
5. If not needed: increment `skipCount`

**Modify:** `server/src/index.ts` (~line 598) — add `meetingScheduler.tickMeetingSchedules()` to the existing setInterval loop alongside heartbeat and routine ticks.

---

### Step 3: Pipeline Steps 1-2 (Collect + Synthesize)

**New file:** `server/src/services/meeting-pipeline.ts`

#### Step 1 — Collect

1. Create meeting via existing `meetingService.create()` then `.start()`
2. Wake participants via existing `queueMeetingParticipantWakeup()`
3. Poll `meetingParticipants` table for contributions (timeout: 5 min)
4. Each agent sees meeting context via `buildMeetingContextForRun()` (already works)
5. Each agent submits `POST /meetings/:id/participants/:agentId/contribution` (existing route)

**Output:**
```typescript
interface CollectOutput {
  contributions: Array<{
    agentId: string;
    agentName: string;
    agentRole: string;
    contribution: {
      whatIDid: string;
      whatImDoing: string;
      blockers: string;
      learnings: string;
    };
  }>;
  collectDurationMs: number;
}
```

#### Step 2 — Synthesize

Single LLM call (gpt-4.1-mini for cost efficiency):
- Input: compact one-liner per agent contribution
- Prompt: "Detect conflicts, blockers, alignment issues, and highlights. Output structured JSON."
- No creative reasoning needed — this is pattern-matching

**Output:**
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

Record synthesis results as `meetingEvents` (kind: "note").

---

### Step 4: Pipeline Steps 3-4 (Resolve + Execute)

#### Step 3 — Resolve

**Critical optimization:** If zero conflicts + zero blockers + zero alignment issues → **skip entirely** (0 tokens). This is the common case for smooth standups.

When needed: single LLM call with CEO/facilitator context to decide on each conflict.

**Output:**
```typescript
interface ResolutionOutput {
  decisions: Array<{
    conflictId?: string;
    blockerId?: string;
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

Record decisions as `meetingEvents` (kind: "decision").

#### Step 4 — Execute (pure DB, zero tokens)

| Action | How | Integration |
|--------|-----|-------------|
| `create_task` | `issueService.create()` with `originKind: "meeting"` | Queue wakeup for assigned agent |
| `modify_task` | `issueService.update()` | Update priority/status/assignee |
| `escalate_to_board` | `chatService.storeAssistantMessage()` with `cardType: "escalation"` | Surfaces in CEO chat for board approval |
| `note` / `no_action` | Record as `meetingEvent` only | — |

---

### Step 5: Pipeline Step 5 (Learn) + Memory Integration

Build compact transcript from contributions + synthesis + decisions, then call `hippocampusBridge.extract()` per participant.

- Container: `meeting:{meetingId}` (matches existing convention from memory.ts:473)
- Record as `meetingEvents` (kind: "memory_transfer")

**Modify:** `server/src/services/meetings.ts` line 355 — replace Phase 5 stub with call to pipeline learn step.

---

### Step 6: Meeting Summary Card in CEO Chat

After pipeline completes, post a summary card to CEO chat so the board sees what happened.

**Add to** `packages/shared/src/constants.ts`: `"meeting_summary"` in `CHAT_CARD_TYPES`

**Add to** `packages/shared/src/types/chat.ts`:
```typescript
interface MeetingSummaryCardData {
  meetingId: string;
  meetingType: string;
  participantCount: number;
  highlights: string[];
  decisionsCount: number;
  tasksCreated: number;
  blockerCount: number;
  escalationsCount: number;
}
```

---

### Step 7: Daily Sync — Mandatory Company-Wide Standup

The daily sync is the one meeting that **never gets skipped**. It's the heartbeat of shared awareness.

#### How It Differs from Eval-Triggered Meetings

| Aspect | Daily Sync | Eval-Triggered |
|--------|-----------|----------------|
| Trigger | Cron, 1x/day at configured time | CEO evaluation engine |
| Skip? | Never | Yes, if nothing actionable |
| Participants | All active agents | Only relevant agents |
| Purpose | Shared context, catch drift | Make a specific decision |
| Resolve step | Only if conflicts found | Always (that's why it was triggered) |

#### Daily Sync Pipeline (uses same 5-step framework, different behavior)

**Step 1 — Collect (active contributions)**
- Wake ALL active agents via `queueMeetingParticipantWakeup()`
- Each agent submits structured contribution: `{ whatIDid, whatImDoing, blockers, learnings }`
- Timeout: 5 min (same as regular meetings)

**Step 2 — Synthesize (focus on context, not decisions)**
- LLM prompt is different from eval-triggered meetings:
  - "Summarize what the team accomplished, what's in progress, what's blocked"
  - "Detect any misalignment or dependency conflicts between agents"
  - "Highlight anything the Board should know"
- Does NOT need to produce resolution proposals for every item
- Output includes a `companyBrief` field — a 3-5 sentence company status

**Step 3 — Resolve (conditional)**
- Only runs if synthesis detected conflicts or blockers
- Most days: **skipped** (0 tokens) — daily sync is about context, not decisions
- When conflicts found: CEO resolves (same as regular pipeline)

**Step 4 — Execute**
- Same as regular pipeline: create/modify tasks, escalate to board
- Additional: store `companyBrief` for injection into agent contexts

**Step 5 — Learn**
- Same as regular pipeline: extract learnings into agent memory
- Additional: update each agent's priming context with company-wide state

#### Context Broadcast

After the daily sync, the `companyBrief` is stored and injected into every agent's next run:

```typescript
interface DailySyncBrief {
  date: string;
  companyStatus: string;        // "3/8 core tasks done. Auth complete, payments in progress."
  teamUpdates: Array<{
    agentRole: string;
    summary: string;            // "Completed auth API, starting payment integration"
  }>;
  activeBlockers: string[];     // "Payment gateway sandbox access pending"
  upcomingDependencies: string[]; // "Frontend needs API docs from CTO before UI work"
}
```

Injection point: `buildMeetingContextForRun()` in `meeting-context.ts` — extend to also inject latest daily sync brief into non-meeting runs.

#### Daily Sync Summary Card

Post to CEO chat after sync:
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

Card type: `"daily_sync_summary"` — add to `CHAT_CARD_TYPES`.

#### Schedule Configuration

Daily sync is auto-created when a company has 2+ active agents:

```typescript
// In meeting-scheduler.ts
async function ensureDailySyncExists(companyId: string) {
  const existing = await findSchedule(companyId, "daily_sync");
  if (existing) return;

  const activeAgents = await getActiveAgents(companyId);
  if (activeAgents.length < 2) return; // No sync needed for just CEO

  await createSchedule({
    companyId,
    type: "daily_sync",
    title: "Daily Company Sync",
    cronExpression: "0 9 * * *",  // 9 AM daily, configurable
    participantAgentIds: activeAgents.map(a => a.id),
    facilitatorAgentId: getCeoAgentId(companyId),
    conditionalCheckEnabled: false,  // NEVER skip
    enabled: true,
  });
}
```

Called from: agent creation flow (after second agent is hired).

---

### Step 8: Escalation Meeting Variant

Escalation meetings use the **same pipeline** but with different config:

| Aspect | Daily Sync | Eval-Triggered | Escalation |
|--------|-----------|----------------|------------|
| Trigger | Cron, 1x/day | CEO eval engine | Blocker event |
| Skip? | Never | Yes, if nothing actionable | Never |
| Participants | All active agents | Relevant only | Agent + manager |
| Resolve step | Only if conflicts | Always | Always |
| Resolver | CEO | CEO | Direct manager |
| Unresolved | Surfaces to board | Surfaces to board | Escalates up hierarchy |

Existing `meetingService.createEscalation()` handles creation + auto-start. Wire it to trigger the pipeline with escalation config.

---

### Step 9: Schedule CRUD Routes + Health Metrics

**New file:** `server/src/routes/meeting-schedules.ts`

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/companies/:companyId/meeting-schedules` | List schedules |
| POST | `/companies/:companyId/meeting-schedules` | Create schedule (cron, participants, config) |
| PATCH | `/meeting-schedules/:id` | Update (enable/disable, cron, participants) |
| DELETE | `/meeting-schedules/:id` | Remove schedule |
| GET | `/companies/:companyId/meetings/health` | Aggregated health metrics from snapshots |

**Health metrics:**
- **Meeting Debt**: `skipCount / maxConsecutiveSkips` — high = thresholds too aggressive
- **Decision Rate**: `decisionsCount / meetingCount` — low = meetings not producing value
- **Escalation Frequency**: trend of escalations over time
- **Pipeline Efficiency**: tokens per meeting — monitor for cost regression

---

## Files Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/db/src/schema/meeting-schedules.ts` | meeting_schedules + meeting_health_snapshots tables |
| `packages/shared/src/types/meeting-pipeline.ts` | All pipeline step I/O types (CollectOutput, SynthesisOutput, ResolutionOutput, etc.) |
| `packages/shared/src/validators/meeting-schedule.ts` | Zod schemas for schedule CRUD |
| `server/src/services/meeting-scheduler.ts` | Scheduler tick + conditional assessment |
| `server/src/services/meeting-pipeline.ts` | Pipeline orchestrator + all 5 steps |
| `server/src/routes/meeting-schedules.ts` | Schedule CRUD + health endpoint |

### Modified Files

| File | Change |
|------|--------|
| `packages/db/src/schema/index.ts` | Export new tables |
| `packages/shared/src/constants.ts` | Add "meeting_summary" to CHAT_CARD_TYPES |
| `packages/shared/src/types/chat.ts` | Add MeetingSummaryCardData interface |
| `server/src/index.ts` (~line 598) | Add tickMeetingSchedules to setInterval |
| `server/src/services/meetings.ts` (line 355) | Replace Phase 5 stub with learn step call |
| `server/src/routes/index.ts` | Mount meeting-schedule routes |

---

## Verification

1. Create a meeting schedule (POST with cron "*/5 * * * *" for testing)
2. Let scheduler tick — verify it checks signals and skips when nothing actionable
3. Create a blocked task → scheduler detects blocker → triggers pipeline
4. Verify agents are woken and contributions collected
5. Verify synthesis detects the blocker in structured output
6. Verify resolution creates a decision (or skips if no conflicts)
7. Verify execute step creates/modifies tasks or surfaces escalation card in CEO chat
8. Verify learn step stores memories via hippocampus
9. Check meeting_health_snapshots for metrics
10. Verify meeting summary card appears in CEO chat
