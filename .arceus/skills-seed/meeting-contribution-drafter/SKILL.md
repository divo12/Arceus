---
name: meeting-contribution-drafter
description: Pre-meeting prep — draft your status contribution from recent work via the Facilitator contributor subagent.
role: all
trigger: about to attend a meeting, asked to pre-file a status update, or you want to shape a standup narrative before the chair ventriloquizes
---

# Meeting Contribution Drafter

When a meeting is scheduled and you want control over what goes in your contribution slot — rather than having the chair's Facilitator ventriloquize from your stored state — use the Facilitator contributor subagent to draft it yourself, then review and edit.

## When to invoke

### You likely want a pre-drafted contribution if:
- You have an open `meeting_contribute` delegation task (decision meeting)
- The upcoming standup covers work you want to frame specifically
- You've had a rough beat and want to make sure the narrative is calibrated

### You don't need this if:
- It's a standard standup and your artifacts + memory already tell the story accurately
- You're not invited to the meeting

## Invoke

```
Task({
  agent: "facilitator-contributor-service",
  prompt: JSON.stringify({
    mode: "draft",
    myRole: "<your role>",
    meetingContext: {
      type: "daily_sync" | "eval_triggered" | "escalation" | "decision",
      meetingId: "<if attending an open decision meeting>",
      focusAreas: ["<optional topic cues>"]
    }
  })
})
```

## Envelope shape

```
{
  status: "success",
  data: {
    role: "<your role>",
    contribution: {
      whatIDid: "...",
      whatImDoing: "...",
      blockers: [...],
      questionsForTeam: [...]
    },
    sourceState: {
      artifactIds: ["art_..."],
      memoryIds: ["mem_..."]
    }
  }
}
```

`sourceState` lists what the subagent read to draft this. Useful for verifying it grounded its draft in real data.

## Review + edit

**The draft is a starting point, not the final version.** Read it carefully:

- Did it miss important context you know?
- Did it overclaim or underclaim progress?
- Are the blockers real blockers or just annoyances?
- Are the questions worth raising to the team?

Edit freely within your session's reasoning. Then commit.

## For decision meetings (type: decision)

Your draft will likely be more structured — "position + reasoning + tradeoffs" rather than "what I did / blockers." After reviewing:

```
artifact_create({
  kind: "output",
  title: "<Your role>'s position on <meeting topic>",
  content: JSON.stringify(editedContribution)
})
→ art_123

meeting_contribute({
  meetingId: "<the open decision meeting>",
  artifactId: "art_123"
})
```

Your position is now visible to the chair when they `resolve` the meeting.

See `meeting-participation-etiquette` for quality bar on decision meeting contributions.

## For standups (type: daily_sync)

Two options:

### Option A — let the chair ventriloquize (default)
Don't do anything. The chair's `facilitator-chair-service` will read your state and draft your contribution as part of `mode: "run"`. Cheaper, usually fine.

### Option B — pre-file via contributor subagent
Draft as above, then:

```
artifact_create({
  kind: "output",
  title: "<Your role> standup update — <date>",
  content: JSON.stringify(editedContribution)
})

// Flag it for the chair's Facilitator to use
memory_add_learning({
  content: "Pre-filed standup contribution at artifact <art_id>; use this over ventriloquized draft"
})
```

The chair's Facilitator will see this artifact in your recent artifacts and use it directly rather than ventriloquizing.

## When editing the draft

Common edits:

- **Trim fluff** — subagent output tends toward verbosity
- **Sharpen blockers** — "I'm blocked" → "I'm blocked on <specific>; would unblock if <action>"
- **Remove redundant questions** — if you already know the answer or can look it up
- **Add tone calibration** — subagent is neutral; your actual voice may be more direct / diplomatic

## Failure modes

| error.cause | Meaning | What to do |
|---|---|---|
| `insufficient_context` | Your stored state is too thin to draft from | Do the work yourself; subagent can't help |
| `iteration_cap_hit` | Shouldn't happen on `draft` (5-step cap) | `task_report_bug` if it does |
| Envelope malformed | Rare hallucination | Retry once; then draft manually |

## Don't use this for

- Writing the chair's meeting summary — that's `meeting-chair-playbook`
- Writing artifacts unrelated to meetings — use `artifact-structure` skill instead
- Recording decisions after a meeting — chair handles via `meeting_record`

## After the meeting

- Your contribution artifact is preserved on the meeting record
- If the decision affects your work: `taskModifications` on the meeting record auto-create or update your tasks
- No post-meeting cleanup needed from your side unless you want to `memory_add_learning` something
