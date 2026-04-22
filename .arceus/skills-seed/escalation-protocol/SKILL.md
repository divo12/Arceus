---
name: escalation-protocol
description: When to task_block vs approval_request vs schedule a meeting vs memory_handoff.
role: all
trigger: you're stuck, blocked, or need a decision beyond your authority
---

# Escalation Protocol

You hit a point where you can't just "keep going." Four escalation options, each with a specific signature. Pick wrong and the system either stalls or makes the wrong call.

## The decision tree

```
Am I blocked on something concrete + external?
  │
  ├── Dependency I need isn't ready     → task_block
  ├── Another role needs context I have → memory_handoff
  ├── Need permission to proceed         → approval_request
  └── Need group judgment on a choice    → meeting_request_decision
                                              (if decision-shaped)
                                          → no escalation, just ask in
                                              contribution at next standup
                                              (if informational)
```

## 1. `task_block` — dependency / environmental blocker

Use when: your current task can't progress until something outside your control happens.

Examples:
- Dev waiting for CTO's architecture decision on task_38 before implementing task_42
- QA blocked because preview server won't start (infra issue)
- UI blocked because design-token package hasn't shipped

Shape:
```
task_block({
  taskId: "task_42",
  reason: "<what's blocking, concretely>",
  suggestedUnblockPath: "<what needs to happen for me to resume>"
})
```

Rules:
- Be specific about what unblocks you
- Name who or what you're waiting on
- Suggest an action someone can take
- Your beat ends; heartbeat re-tries the task when deps or conditions change

### When NOT to task_block
- You just don't feel like doing it → that's not a blocker
- The work is hard — hard ≠ blocked
- You need to learn something — go learn it via `skill` lookups first

## 2. `memory_handoff` — give context to another role

Use when: the next role needs information you have that isn't captured in the task description or artifact.

Examples:
- Dev finishes login form → hand off to QA with test credentials + known Safari bug
- UI finishes design → hand off to dev with token file path + a11y notes
- PM finishes spec → hand off to CTO with which parts are flexible vs hard constraints

Shape:
```
memory_handoff({
  targets: ["qa"],        // max 4 target roles
  context: "<concise — what you know that they need>"
})
```

Rules:
- Max 4 target roles per call
- ≤ 4000 chars per handoff
- Not for broadcasting — use `board_post_message` for company-wide
- Not for stuff already in the artifact — target role reads that via `artifact_get`

## 3. `approval_request` — need permission

Use when: a decision needs sign-off that's above your tier. Approval routing is automatic based on the `type` field.

Types + who approves:

| type | Requester | Approver |
|---|---|---|
| `strategy` | ceo | Board (human) |
| `hire` | ceo, pm | Board |
| `external_action` | marketing, ceo | Board |
| `architecture_change` | cto | CEO |
| `scope_change` | pm, cto | CEO |
| `meeting_blocker` | pm, cto | CEO |
| `tool_governance` | skills_lead | CEO |

Shape:
```
approval_request({
  type: "<one of the above>",
  title: "<single sentence>",
  description: "<full context>",
  evidenceArtifactIds: [...],       // artifacts backing the request
  meetingId: "<optional, if this came out of a meeting>"
})
```

Rules:
- Type determines the queue — don't guess; match the table
- Every approval needs evidence; don't file without referencing artifacts
- Your beat doesn't block — the approval surfaces when decided
- While pending, you might `task_block` the affected task so heartbeat doesn't re-run it

## 4. `meeting_request_decision` — need group judgment

Use when: a choice between real alternatives needs multiple roles' input, and no single approver has authority.

Examples:
- Should we pivot the sprint focus from B2C to B2B?
- Which auth library — Supabase vs Clerk vs self-hosted?
- Is this codebase ready to cut a major version?

Shape:
```
meeting_request_decision({
  topic: "<single-sentence question>",
  description: "<full context>",
  requiredParticipants: ["cto", "pm"],
  deadline: "<ISO or sprint_end>",
  contextArtifactIds: [<options + analyses>]
})
```

This fires `meeting_contribute` delegation tasks to each participant. They respond on their next beats. You (or chair) resolve via `facilitator-chair-service` (see `meeting-chair-playbook`).

### When NOT to request a decision meeting
- Only one person can decide → `approval_request` instead
- No real alternatives (just needs info) → ask via `memory_handoff` or standup
- Urgent and small → decide yourself; you probably have authority

## Anti-patterns

| Pattern | Why wrong | Right escalation |
|---|---|---|
| "I'll just `task_block` and wait" — no reason given | heartbeat can't route back to you | Always specify reason + unblock path |
| `approval_request({type: "strategy"})` from non-CEO | type-gated; will 403 | Route through your actual tier: CTO→CEO, etc. |
| `meeting_request_decision` for informational | wastes everyone's beat | Just put it in your next standup contribution |
| Silent stall (no tool called) | beat ends with verdict:fail | ALWAYS escalate explicitly — silence is bad |
| `memory_handoff` to all 8 roles as a broadcast | memory is per-role rolling summary | Use `board_post_message` for broadcasts |

## Choosing between `task_block` and `approval_request`

Often overlap. Rule of thumb:

- **Someone will do something** → `task_block` (dependency)
- **Someone must permit something** → `approval_request` (gate)

Example: dev waiting on CTO to finish `technical_plan` task → `task_block` (dep on task_38).
Example: dev wanting to use a new paid npm package → `approval_request` (need CEO sign-off on spend).

Both are legitimate; they solve different shapes.

## After the escalation

- If `task_block`: next beat, heartbeat re-checks conditions. If unblocked, task goes back to `ready`.
- If `memory_handoff`: target role sees the context on their next beat. You continue.
- If `approval_request`: you might `task_block` the affected task, or continue with other tasks. Approval surfaces when decided.
- If `meeting_request_decision`: you continue other work. Meeting resolves across 3-5 beats.

Silence is the only wrong move.
