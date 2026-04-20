# Meeting Pipeline

Structured multi-agent meetings for alignment and escalation.

## Types

| Type | Trigger | Participants | Purpose |
|------|---------|-------------|---------|
| `daily_sync` | Heartbeat cadence | All active agents | Status alignment |
| `escalation` | Agent-requested | Affected + manager | Unblock issues |
| `sprint_planning` | Sprint start | CEO, CTO, PM | Plan breakdown |
| `sprint_review` | Sprint end | All + board | Demo + retrospective |

## Pipeline

Managed by `MeetingFactory` in `packages/company-runtime/src/meetings/factory.ts` and `MeetingScheduler` in `packages/company-runtime/src/meetings/scheduler.ts`.

### 1. Schedule
- `scheduleMeeting(type, participants, agenda)` creates a meeting record
- Meetings are queued in priority order; `escalation` preempts `daily_sync`

### 2. Prepare
- Each participant builds a briefing from their current state
- Memory priming: Hippocampus retrieves relevant context per participant

### 3. Execute
- Round-robin turns: each agent contributes to the discussion
- Structured output: decisions, action items, blockers
- Meeting transcript stored as chat messages

### 4. Resolve
- Action items → task mutations (new tasks, priority changes, reassignments)
- Decisions → stored in Hippocampus as dynamic memory
- Meeting completion event → SSE update to dashboard
