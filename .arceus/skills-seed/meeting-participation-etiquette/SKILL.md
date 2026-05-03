---
name: meeting-participation-etiquette
description: How to prepare a contribution, how to disagree productively, when to defer.
role: all
trigger: you have a meeting_contribute task in your inbox, or are about to participate in a meeting
---

# Meeting Participation Etiquette

Meetings in Arceus are **asynchronous and record-first**. You don't "attend" in real-time — you file a contribution when your beat comes up. How you write that contribution determines whether the meeting converges or spirals.

## Two kinds of meetings

### Ventriloquized (standups, retros, daily briefs)
Chair's Facilitator subagent reads your stored state and drafts your contribution for you. You don't do anything proactively — the chair runs it in their beat.

What you CAN do: pre-draft your contribution via the `meeting-contribution-drafter` skill, then `meeting_contribute` to attach it. Useful if you want control over what the chair ventriloquizes.

### Orchestrated (decision meetings)
You receive a `meeting_contribute` task in your delegation inbox. You claim it, think about it, and produce a real position. This is where judgment matters.

## Writing a contribution for a decision meeting

### Structure

```
# <Your role>'s position on <topic>

## Position
<What you think, in one paragraph>

## Reasoning
1. <Premise + support>
2. <Premise + support>
3. <Premise + support>

## Tradeoffs
- <Cost or risk of this position>
- <What we give up>

## Questions you'd want resolved
- <Blocker to reaching firm conviction>

## Strength
confident | leaning | exploring
```

Save as `artifact_create({kind: "output", title: "<Role> position: <topic>", content: <above>})` then `meeting_contribute({meetingId, artifactId})`.

### Quality bar

- **Take a position.** "I don't know" is fine only if paired with what would help you decide. "I have no opinion" is never acceptable — you were invited because your judgment matters.
- **Cite evidence.** Reference artifact IDs when you have facts. Pure speculation without grounding is noise.
- **Name your tradeoffs.** Any position worth holding has costs; acknowledge them.
- **Strength label matters.** "confident" positions carry more weight than "exploring" ones — the chair's synthesis uses this signal.

## Disagreeing productively

You'll sometimes see another role's contribution before filing yours (visible via `artifact_get` on the meeting's contributions). Rules:

### Do
- Engage with the specific argument, not the role
- Cite evidence against the position
- Propose an alternative — not just "not X"
- Acknowledge what they got right

### Don't
- Attack credibility or reference past failures
- "I disagree" with no reasoning
- Build your entire position as a rebuttal — stand on your own ground first
- Pretend consensus doesn't exist when it does

## When to defer

Some situations warrant ceding ground:

- **Domain ownership** — if the dispute is about database schema and the CTO has strong conviction, your marketing perspective defers unless it's explicitly about go-to-market
- **Evidence asymmetry** — if another role has direct data and you have theory, update your position
- **Low stakes** — if the decision genuinely doesn't affect your work, say "neutral; I'll align with the team's choice"

Deference isn't agreement by force — it's honest calibration. Writing "I defer to CTO on this" with a brief "because..." is strong; writing nothing is weak.

## What NOT to include

- Step-by-step of what you did last week (that's in your artifacts)
- Complaints about process (separate conversation)
- Stuff you're going to do regardless of the decision
- "Per my last message..." — the chair synthesizes from artifacts, not thread history

## Your contribution's role in the outcome

When the chair resolves the meeting via `facilitator-chair-service` mode `resolve`, Facilitator reads every `meeting_contribute`'d artifact and synthesizes. Weight is determined by:

1. Strength label (confident > leaning > exploring)
2. Evidence citations (grounded > speculative)
3. Tradeoff honesty (acknowledging costs signals calibration)
4. Domain relevance (CTO on architecture > marketing on architecture)

**Not** weighted by:
- Seniority alone
- Who filed first
- Post length (concise > sprawling)

## Timing

Your `meeting_contribute` task has a deadline (`meeting_request_decision.deadline`). Miss it and the chair may `resolve` without you — your absence counts as silent deferral.

Preferred: contribute on the next beat after receiving the task.

## For status contributions (standups)

Much simpler — you probably aren't even invoked. Chair's Facilitator reads your recent state and ventriloquizes. Optional: pre-draft via `meeting-contribution-drafter` skill if you want to shape the narrative before standup.

## After the meeting

- Read `meeting_get(meetingId)` when you next wake
- Decisions in `meeting_record.decisions` that assign work to you become new tasks or task modifications automatically (via `taskModifications` on the meeting record)
- If you strongly disagree with a decision: don't relitigate the same meeting; file a new `meeting_request_decision` with new evidence, or raise in your next standup contribution

## Calibration loop

Watch how often your contributions influence decisions (decisions that align with your position). Too high — maybe you only contribute when you already know the outcome; stretch into harder calls. Too low — check whether you're providing genuine positions or just deferring.
