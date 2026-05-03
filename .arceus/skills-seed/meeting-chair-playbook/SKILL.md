---
name: meeting-chair-playbook
description: How to run, brief, or resolve meetings via the Facilitator chair subagent.
role: [ceo, cto, pm, skills_lead]
trigger: about to run a standup, generate a daily brief, or resolve a decision meeting
---

# Meeting Chair Playbook

You chair meetings by invoking the `facilitator-chair-service` subagent via the built-in `Task` tool. The subagent does synthesis; you persist via deterministic MCP tools.

Four modes: `run`, `daily_brief`, `resolve`, plus the deterministic `meeting_request_decision` flow for async decision meetings.

## Mode: run — standup / retro / demo / escalation

Invoke:

```
Task({
  agent: "facilitator-chair-service",
  prompt: JSON.stringify({
    mode: "run",
    type: "daily_sync" | "eval_triggered" | "escalation",
    participants: ["ceo","cto","pm","dev","qa","ui","sl"],
    sprintId: "<current sprint id>",
    purpose: "<one-line why we're meeting>"
  })
})
```

Envelope returns:
```
{
  status: "success" | "partial",
  data: {
    agenda: [...],
    decisions: [...],
    learnings: [...],
    taskModifications: [...],
    memoryModifications: [...]
  }
}
```

Then persist:
```
meeting_record({
  type: "daily_sync",
  facilitatorRole: <your role>,
  participantRoles: [...],
  ...envelope.data
})
```

`meeting_record` is a **synchronous atomic DB write**. The row exists when the tool returns.

## Mode: daily_brief — end-of-day summary

```
Task({
  agent: "facilitator-chair-service",
  prompt: JSON.stringify({
    mode: "daily_brief",
    date: "YYYY-MM-DD",     // optional; defaults to today
    sprintId: "<current>"
  })
})
```

Envelope `data`: `{ briefText, referenceArtifactIds }`

Persist as an artifact (not a meeting record):
```
artifact_create({
  kind: "output",
  title: "Daily brief YYYY-MM-DD",
  content: envelope.data.briefText,
  attachToTaskIds: []    // usually unattached
})
```

## Mode: resolve — close an async decision meeting

Used after `meeting_request_decision` has collected participant contributions.

```
Task({
  agent: "facilitator-chair-service",
  prompt: JSON.stringify({
    mode: "resolve",
    meetingId: "<the open_meeting id>"
  })
})
```

Facilitator reads each contribution artifact attached to the open meeting and synthesizes a decision from **real positions** (not ventriloquized).

Then:
```
meeting_record({
  ...envelope.data,
  type: <original meeting type>,
  facilitatorRole: <your role>,
  participantRoles: [...],  // include ALL invited participants
  metadata: { resolvedFromDecisionMeetingId: "<same meetingId>" }
})
```

## Opening an async decision meeting

Before you can `resolve`, a decision meeting must exist. To open one:

```
meeting_request_decision({
  topic: "<single-sentence question>",
  description: "<longer context>",
  requiredParticipants: ["cto", "pm"],
  deadline: "<ISO timestamp or `sprint_end`>",
  contextArtifactIds: [<relevant spec artifacts>]
})
```

This tool:
- Creates an `open_meeting` row
- Fires `task_create({kind: "meeting_contribute", assignedRole: <each participant>})` delegations
- Returns immediately with `{meetingId, status: "open"}`

Participants respond on their own beats via `meeting_contribute`.

You come back for `resolve` when contributions land (visible in your next beat context as `N contributions received on mtg_xxx`).

## Failure modes

When envelope `status: "partial"` or `error`:

| error.cause | What it means | What to do |
|---|---|---|
| `insufficient_context` | Participant state too thin to ventriloquize | Ask participants for richer handoffs; retry run next beat |
| `iteration_cap_hit` | Synth couldn't converge in 15 steps | Envelope has best-effort `data.partialPayload` — review, decide to record as-is or re-run with narrower scope |
| `validation_failed` | Your prompt args were malformed | Re-read your Task invocation — missing required fields? |
| `upstream_error` | MCP tool call inside subagent failed | Likely transient. Retry once. If persistent, `task_report_bug`. |
| Envelope JSON malformed | Subagent hallucinated shape. Rare. | Retry once. If persistent, `task_report_bug`. |

## Rules

1. **Never call `meeting_record` without an envelope from `Task` or your own deliberate ventriloquized content.** Fat schema needs real content for agenda/decisions/learnings.
2. **`taskModifications` and `memoryModifications` from the envelope fire automatically on `meeting_record`.** Don't duplicate them as separate `task_update` / `memory_add_learning` calls.
3. **If you disagree with the synthesis, edit the envelope before recording.** You're the chair; the subagent proposes, you dispose.
4. **For decision meetings, `resolve` only AFTER all required contributions land.** Check `meeting_get(meetingId).contributionCount >= requiredParticipants.length` first.
